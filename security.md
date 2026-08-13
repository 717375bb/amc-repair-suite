# Security Overview — Project Takeoff (amc-repair-suite)

**Audience:** PSA Airlines IT/Security review, and the engineers/analysts who build and use this tool. Written to be read start to finish by either.

**Scope:** the whole application — the React frontend, the Express backend, the local SQLite data stores, and the Playwright-driven automation that writes into Maintenix (MXI). Last reviewed: 2026-08-13.

**What this tool is:** an internal automation suite for PSA's component repair team. It reads vendor/CRA open-order reports, infers estimated ship dates, and drives real write-ups (order creation, authorization, issue, dock) directly inside Maintenix on behalf of a logged-in analyst. It runs entirely on the analyst's own machine — there is no shared server or cloud deployment today. Coworkers each run their own local copy from the same GitHub repository.

---

## 1. Authentication & account management

### 1.1 Identity model
The login username **is** the analyst's real MXI username, and the login password **is** their real MXI password — this is a deliberate design choice, not an oversight. There is no separate "app password" to remember or keep in sync. One consequence: when an analyst's real MXI password changes, they must also update it here (see 1.5).

### 1.2 Password storage
Login passwords are never stored in a recoverable form. On account creation, the password is hashed with **scrypt** (Node's built-in `crypto.scryptSync`, 64-byte derived key, random 16-byte salt per account) and only the salt+hash is stored (`backend/src/auth/crypto.ts`). Verifying a login re-derives the hash from the submitted password and compares it to the stored value using a timing-safe comparison (`crypto.timingSafeEqual`) — a login attempt can never be used to narrow down the real password one byte at a time via response-time differences.

### 1.3 MXI credential storage
The Playwright automation that actually logs into Maintenix needs the *real* password, not a hash — a one-way hash cannot be reversed to produce it. So the same password value is *also* stored separately, encrypted with **AES-256-GCM** under a master key (`CREDENTIAL_ENCRYPTION_KEY`) that lives only in that analyst's local `backend/.env` file, generated once per machine and never committed to source control. This is standard envelope encryption: the database holds ciphertext only; decryption requires both the ciphertext and the local machine's key.

**Operational note:** losing or rotating `CREDENTIAL_ENCRYPTION_KEY` makes every already-stored MXI password on that machine permanently undecryptable — every account would need to be re-created. There is currently no automated key-rotation tooling; back the key up separately from the database file if it's ever regenerated.

### 1.4 Account creation
Self-serve — anyone who can reach the login page can create an account (there is no separate admin approval step; this matches the tool's current single-machine, single-analyst deployment model). Usernames are enforced unique at the database level (`users.username UNIQUE`), so two accounts can never collide on the same identity.

### 1.5 Changing a password
Reachable from within the app (top-right user menu → "Change password"). Requires the *current* password before accepting a new one — there is no email- or token-based reset, because there is no email infrastructure in this tool, and proving you already know the current password is the appropriate bar for an identity that's also a real MXI credential. A successful change updates both the login hash and the encrypted MXI credential together, so they can never drift to different underlying passwords.

### 1.6 Login rate limiting & lockout
After **5 failed login attempts for a given username within 15 minutes**, that username is locked out of further login attempts for **15 minutes** — including attempts using the *correct* password, so an attacker who has exhausted the guess budget can't distinguish "wrong guess" from "about to succeed" by trying the real password last. The lockout check runs before password verification, so a locked-out account never causes the server to spend the (deliberately expensive) scrypt computation on a guess that's going to be rejected anyway. Implemented in `backend/src/auth/loginRateLimit.ts`; in-memory, per server process (a restart clears it — see 4.2).

### 1.7 Session management
A successful login/registration issues a random 256-bit session token (`crypto.randomBytes(32)`), set as an `HttpOnly`, `SameSite=Lax` cookie. Sessions are tracked server-side (`backend/src/auth/sessions.ts`) and expire after **12 hours**. `HttpOnly` prevents the token from being read by page JavaScript (blocking the classic XSS-steals-the-cookie attack); `SameSite=Lax` blocks the cookie from being attached to cross-site requests initiated by other websites.

### 1.8 Audit trail
Every registration, login success, login failure, lockout, logout, and password change is recorded to an append-only `auth_events` table (`backend/src/db/authDb.ts`) with the username, event type, and timestamp — never any credential material. This is what makes a real brute-force attempt (or a legitimate analyst locked out by their own typo) something you can actually go look at, rather than something that's only theoretically detectable.

**Scope note:** this covers the login lifecycle only. It does not, by itself, tell you which analyst's session triggered a specific real MXI write — see `privacy.md` section 5 for that gap and what closing it would take.

---

## 2. Authorization boundaries

Two genuinely different trust relationships exist in this system, and they are kept structurally separate rather than sharing one gate:

- **Human, browser-driven traffic** (Order Write-Ups, Open Order ESD Finder) is gated by the session cookie described above (`requireSession` middleware, `backend/src/api/authRoutes.ts`). Every write-up or ESD action a logged-in analyst triggers runs using **that analyst's own decrypted MXI credential** — injected into the spawned automation process's environment at the moment the job starts (`backend/src/api/jobManager.ts`'s `spawnRunner`), never a shared or hardcoded credential. Two different analysts running actions never use each other's MXI identity.
- **Machine-to-machine traffic** (the Power Automate integration: `GET /pending-esd-updates`, `POST /esd-updates/:orderNumber/approve`, `POST /esd-updates/:orderNumber/reject`) is gated by a separate shared-secret header (`X-Automation-Key`, compared with `crypto.timingSafeEqual`) and uses its own, separately-configured MXI credential (`MXI_USERNAME`/`MXI_PASSWORD` in `.env`) — this integration has no concept of an individual logged-in human, by design, so it is deliberately not folded into the session system.

A valid session does not satisfy the automation-key gate, and a valid automation key does not satisfy the session gate — confirmed by direct test, not assumed.

---

## 3. Network & transport

- The backend binds to **127.0.0.1 only**, never `0.0.0.0` — it is not reachable from any other machine on the network, by any network path, under any circumstance, short of someone deliberately reconfiguring the bind address.
- **No HTTPS.** All traffic (login included) is plain HTTP. This is an accepted tradeoff, not an oversight: the entire request path never leaves the analyst's own machine (browser → localhost → same machine's backend process), so there is no network segment for a third party to intercept. This stops being acceptable the moment this tool is ever exposed beyond one machine — see 5.1.
- CORS is restricted to the two loopback dev-server origins (`http://localhost:5173`, `http://127.0.0.1:5173`) that the frontend is actually served from; the Vite dev server also proxies `/api/*` requests same-origin so the browser never needs to treat the backend as a cross-origin (or cross-site, for cookie purposes) target at all.

---

## 4. Data protection

### 4.1 What's stored, and where
Everything lives in local SQLite files under `backend/data/` (gitignored — never committed):
- `auth.db` — user accounts, hashed passwords, encrypted MXI credentials, the auth event log.
- `audit.db` — the ESD inference and write-up audit trail (unrelated to login; a separate concern deliberately kept in a separate database).

### 4.2 In-memory session state
Active sessions and the login-attempt/lockout counters are held in server memory, not persisted — a server restart logs every analyst out and clears any in-progress lockout. This is an accepted tradeoff for a local, single-analyst tool (the same tradeoff this codebase already makes for its background job tracking), not a gap that needs closing at this scale.

### 4.3 Real production consequences
This tool can write directly into **production** Maintenix, not just a sandbox. Separate, existing safeguards (outside the login system, already in place before this security review) require the target environment to be explicitly selected per action — there is no ambient "ends up in production by default" path — and the server prints an unmissable warning banner on startup whenever it is configured for `MXI_ENV=production`.

---

## 5. Known limitations & accepted tradeoffs

Documented honestly rather than left implicit. None of these are currently exploitable from outside the analyst's own machine, given the network posture in section 3.

| Item | Status | Why |
|---|---|---|
| No HTTPS | Accepted, by design | No network segment exists for traffic to cross — see 3. Must be revisited before any deployment beyond one machine. |
| Sessions/lockout state lost on restart | Accepted | Same v1 tradeoff already used elsewhere in this codebase; low impact for a single local analyst. |
| No CSRF token beyond `SameSite=Lax` | Accepted for now | No public network exposure exists to exploit; revisit if that changes. |
| No automated encryption-key rotation | Not yet built | Manual rotation is possible but not tooled — see 1.3. |
| No password complexity requirements | Intentional | The password *is* the analyst's real MXI password; enforcing an app-specific rule risks rejecting a legitimate, already-real password. |
| Each analyst runs a separate local copy/database | Accepted, temporary | Centralizing to an Azure-hosted store is planned (see section 6) — the current schema was deliberately kept small and self-contained to make that migration straightforward. |
| No rate limiting on account *creation* | Accepted for now | Lower-value target than login brute-forcing; revisit if abuse is ever observed. |
| No account deletion/deactivation feature | Not yet built | An account (and its still-valid encrypted MXI credential) currently stays active indefinitely unless removed by directly editing the local database — no in-app offboarding step exists yet for when an analyst leaves the team. See `privacy.md` section 4. |

## 6. Planned future work

- Migrate `auth.db`'s schema to an Azure-hosted database, so credentials and sessions are centralized across analysts' machines instead of one independent copy per machine.
- Automated encryption-key rotation tooling.
- `privacy.md` (in progress) and a broader repository restructuring toward a more enterprise-oriented layout (proposal pending review).

## 7. If a credential is suspected compromised

- **A user's MXI password may be compromised:** they should change their real MXI password through normal channels, then use "Change password" in this tool (section 1.5) to bring the two back in sync. Their existing session remains valid until they log out or it expires (12 hours) — log out explicitly if immediate invalidation is needed.
- **`CREDENTIAL_ENCRYPTION_KEY` itself is suspected compromised:** rotate it (generate a new 32-byte value) and have every user on that machine re-create their account. There is currently no way to re-encrypt existing rows under a new key without each user re-entering their password.
- **`AUTOMATION_API_KEY` is suspected compromised:** generate a new value, update `backend/.env`, and update the Power Automate flow's stored credential to match. This key is unrelated to any individual user account and rotating it does not affect anyone's login.
