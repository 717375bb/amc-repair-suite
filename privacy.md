# Privacy Policy — Project Takeoff (amc-repair-suite)

**Audience:** PSA Airlines IT/Security review, and the engineers/analysts who build and use this tool. Written to be read start to finish by either.

**Scope:** what personal and business data this tool collects, why, where it goes, and how long it's kept. This is a companion to `security.md`, which covers *how* data is protected; this document covers *what* data exists and *whose* it is. Last reviewed: 2026-08-13.

**Who this tool is for:** internal PSA Airlines component-repair analysts. There are no external users, no customer accounts, and — to be explicit about the one thing people usually ask first — **no passenger data of any kind passes through this system.** It handles repair orders, vendor correspondence, and part/order identifiers, not passenger records.

---

## 1. Whose data this tool handles

Two distinct groups of people have data in this system, and they're handled very differently:

### 1.1 The analyst using the tool (you)
Your login identity **is** your real MXI username and password (see `security.md` section 1.1 for why). That means this tool stores:
- Your username (plaintext — it's an identifier, not a secret).
- A one-way hash of your password (never the password itself).
- Your real MXI password, separately encrypted (needed so the tool can act in MXI on your behalf — see `security.md` section 1.3).
- A timestamped log of your login/logout activity and password changes (`auth_events` — see section 4 below).

### 1.2 Vendor and CRA contact people
The "Vendor Assignments" spreadsheet this tool reads includes a named contact and email address per vendor (`craOwnerName` / `craOwnerEmail` in the code, sourced from the "CRA" / "CRA Email" columns) — real names and email addresses of people at repair vendors and PSA's own CRA (Component Repair Authorization) contacts, not PSA employees or passengers. This is used only to enrich the Open Order ESD Finder's on-screen comparison results and its exported Excel report — **it is not written into the persistent audit database** (confirmed directly against the `esd_inferences` table schema, which has no such column). It does, however, land in the exported `.xlsx` file saved locally under `backend/data/` (gitignored, never committed) each time a comparison is run.

### 1.3 Free-text vendor notes — the one place accidental PII could show up
"Vendor Notes" is free text typed by a vendor's own staff into their order-tracking system, then read into this tool. It is not screened or redacted before use — if a vendor rep happens to type a person's name or contact info into that field (e.g. "call John at ext. 4521"), that text is stored in `audit.db` exactly as received and is also sent to Anthropic's API for classification (see section 3). This is a real, if low-probability, way incidental personal data could enter the system, and it's disclosed here rather than assumed away.

---

## 2. What this tool does NOT collect

Stated explicitly, not just by omission:
- No passenger names, tickets, itineraries, or any passenger-facing data.
- No payment/financial card data.
- No location tracking, device fingerprinting, or analytics/telemetry of any kind.
- No data about PSA employees other than the analyst who is themselves using the tool (their own login identity — section 1.1).
- Aircraft tail numbers (e.g. "N545PB") and part/serial numbers appear in order data — these identify *equipment*, not people.

---

## 3. Third-party data sharing

There is exactly one third-party service this tool sends real data to:

**Anthropic's Claude API**, used by the Open Order ESD Finder's inference step (`backend/src/inference/anthropicProvider.ts`) to classify vendor notes and extract an estimated ship date. Every call sends exactly four fields, verified directly against the code that constructs the request — nothing more:
- Order Number
- Vendor Name
- Current Status
- Vendor Notes (free text — see section 1.3's caveat)

No login credentials, no vendor contact names/emails, and no data outside those four fields are ever sent. What Anthropic does with this data on their end is governed by Anthropic's own API terms and privacy policy, not this document — PSA IT should review those directly if that's part of the approval process.

**No other third party receives data from this tool today.** A KPI reporting integration exists in the codebase (`backend/src/kpiDb/`, pointed at an Azure SQL database using PSA's own credentials) but is not currently wired into any running code path — it's scaffolding for a "Vendor KPI Reports" feature marked "coming soon" in the UI, not an active data flow. This will need its own review when it's actually built out.

---

## 4. Data retention

- **`audit.db`** (ESD inference runs, MXI write outcomes): **append-only, kept indefinitely.** Nothing is ever deleted or overwritten — this is a deliberate design choice for auditability of real production writes, not an oversight. There is currently no retention/purge policy.
- **`auth.db`** (accounts, password hashes, encrypted MXI credentials, login/logout audit events): kept indefinitely. **There is no account deletion feature yet** — if an analyst leaves the team or changes roles, their account currently has to be removed by directly editing the local database file rather than through the app itself. Worth flagging as a real gap, not silently left implicit.
- **Exported Excel files** (`backend/data/esd-finder-output-*.xlsx`): accumulate locally with each comparison run; nothing currently cleans these up automatically (documented previously as "harmless, not cleaned up — fine to delete anytime," but that predates this privacy review, and given section 1.2, these files do carry real vendor contact names/emails, so "harmless" deserves a second look — flagging here rather than leaving the earlier, narrower framing standing).

## 5. A real accountability gap, disclosed plainly

Login/logout events are attributed to a specific analyst (`auth_events`, section 1.1). **Individual write-up actions and MXI writes are not** — `write_up_actions` and `mxi_writes` (the tables that record what actually got written into Maintenix) track the vendor, part, order, and outcome, but not which logged-in analyst's session triggered them. In practice, on a given machine, that's usually inferable from the auth log's timestamps — but it isn't a direct, queryable link today. If per-write analyst attribution becomes a real requirement (e.g. for a compliance audit), this is a well-scoped follow-up: thread the session's username through into those two tables the same way `approvedBy` already exists as a column.

## 6. Where this data physically lives

Everything described above lives in local SQLite files on the analyst's own machine (`backend/data/`, gitignored — see `security.md` section 4.1), with the single exception of the four fields sent to Anthropic's API per ESD inference call (section 3). There is no shared server and no cloud database today. Each analyst's data is only as accessible as their own machine is — physical/OS-level access control is out of scope for this document and is PSA IT's existing endpoint policy, not something this tool adds or changes.

## 7. Planned changes that affect this document

- The planned migration of `auth.db` to an Azure-hosted store (`security.md` section 6) will change section 6 above materially — data will no longer be purely local to each analyst's machine. This document will need a real revision at that point, not just a note.
- An account-deletion feature and a retention/purge policy for `audit.db` and exported Excel files are both open items surfaced by this review (section 4) — not yet scheduled.

---

**Questions about this document** should go to whoever owns this tool internally (the analyst team lead) or PSA IT Security, per your normal review process.
