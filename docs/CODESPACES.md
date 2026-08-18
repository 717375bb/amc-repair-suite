# Running amc-repair-suite in GitHub Codespaces

## What this is

A one-click way to run the whole app (frontend + backend) without a local
dev setup: click the "Open in GitHub Codespaces" badge in the root
`README.md`, wait for the container to build, and the app opens in a
browser tab automatically. Everything runs inside that container —
`npm run dev` (frontend) and `npm run server` (backend) are started for
you by `.devcontainer/start.sh`.

## Why this shape, specifically

- **`backend/src/server.ts` still binds `127.0.0.1` only, exactly as it
  does locally.** `security.md` documents this as a deliberate choice
  ("not reachable from any other machine on the network"), and nothing
  about moving to Codespaces requires changing it: the frontend's Vite dev
  server already proxies `/api/*` to `127.0.0.1:3001` **server-side**
  (`vite.config.ts`) — the browser has never talked to the backend
  directly, even in local dev. So only port `5173` (the frontend) is
  forwarded publicly by `.devcontainer/devcontainer.json`; port `3001`
  stays container-internal. This preserves the existing local-only
  security posture rather than widening it.
- **Analyst MXI credentials still come from the app's own login system,
  not from this container's setup.** The "credential locker" this doc's
  setup was originally asked about turned out to just be the existing
  per-analyst encrypted-credential system (`auth.db`, AES-256-GCM under
  `CREDENTIAL_ENCRYPTION_KEY`) — an analyst creates an account through the
  app's own Create Account page using their real MXI username/password,
  same as running it locally. Nothing new was built for that.
- **The app is already designed to boot with an empty `.env`.**
  `PHASE2_MXI_WRITER_SPEC.md`'s "Implementation status" section documents
  that a failed/absent login at server boot (the shared `MXI_USERNAME`/
  `MXI_PASSWORD` client, used only by the Power Automate endpoints) does
  not crash the server — it degrades gracefully. Login, Order Write-Ups,
  and ESD Finder all use the *per-logged-in-user* credential path instead,
  so a fresh Codespace with zero secrets configured still boots into a
  usable app.

## Secrets: what to set and where

GitHub Codespaces secrets (repo, or your fork's Settings → Secrets and
variables → Codespaces) are injected as real environment variables before
the container's setup scripts run. Every backend entry point loads env
vars via `import 'dotenv/config'`, which **never overrides an
already-set `process.env` value** — so a Codespaces secret always wins
over anything blank in `.env`, with no code change needed.

| Secret | Required? | What it affects if missing |
|---|---|---|
| `ANTHROPIC_API_KEY` | Recommended | Without it, ESD Finder's AI classification step fails. Everything else (login, Order Write-Ups) still works. |
| `CREDENTIAL_ENCRYPTION_KEY` | Optional | If you don't set this, `.devcontainer/setup.sh` auto-generates a fresh random one on first build. Fine for a short-lived session — but a **container rebuild** would generate a *new* key, making any accounts created under the old one permanently undecryptable (same tradeoff `security.md` §1.3 already documents for losing this key locally). Set it explicitly as a Codespaces secret if you want accounts to survive a rebuild. |
| `AUTOMATION_API_KEY` | Optional | Only gates the Power Automate endpoints (`/pending-esd-updates`, `/approve`, `/reject`), not the browser UI. Same auto-generate-if-blank behavior as above. |
| `MXI_USERNAME` / `MXI_PASSWORD` | Optional | Only used by the shared boot-time MXI client for the Power Automate endpoints. Not needed for the browser UI at all — leave blank unless you're wiring up that integration. |

`MXI_STAGE_BASE_URL` / `MXI_PROD_BASE_URL` are not secrets (same public
login URLs for every analyst) and already ship filled in via
`backend/.env.example`.

## What's proven vs. what's still unverified

Following this project's own "verified via real testing, not assumed"
discipline (see `CLAUDE.md`, `PHASE2_MXI_WRITER_SPEC.md`): this setup was
built and reasoned through carefully, then actually proven/corrected
against a real Codespace, not just assumed to work.

### Real bug found and fixed: `postStartCommand`'s background processes didn't survive

First real launch: `postCreateCommand` ran correctly (both `npm install`s
completed, `backend/.env` was created), but neither server was running —
no `node`/`vite`/`tsx` processes, and `/tmp/amc-*.log` didn't even exist,
meaning `start.sh` itself never got a chance to run to completion.
Manually running `bash .devcontainer/start.sh` in an interactive terminal
worked immediately and stayed running — which initially looked like a
contradiction, but is actually the tell: an interactive terminal's session
isn't torn down the way a lifecycle command's process group is once the
command itself returns. Plain `nohup ... &` only blocks `SIGHUP`; it does
nothing to protect against Codespaces cleaning up the whole process group
`postStartCommand` ran in. Fixed by adding `setsid` (`.devcontainer/start.sh`),
which puts each server in a brand new session — a different process group
entirely, immune to that teardown. This is the standard fix for this exact
class of devcontainer/Codespaces issue.

**Still to be confirmed**: this fix is based on live-tested diagnosis of
the actual root cause, but hasn't yet been proven by an actual Codespace
restart/rebuild with the fixed script in place (the bug could only be
observed after the fact, from inside the already-broken session).

### Other items, still open

- Whether `npx playwright install --with-deps chromium` installs cleanly
  against the `mcr.microsoft.com/devcontainers/typescript-node:22` base
  image (this is Playwright's own documented pattern for devcontainers,
  but hasn't been directly confirmed here).
- Whether Vite's HMR websocket works correctly over Codespaces' HTTPS
  port-forwarding tunnel. If live-reload doesn't work but the app itself
  loads fine, the likely fix is adding `server.hmr.clientPort = 443` to
  `vite.config.ts`.
- Whether Akamai's bot-detection (documented in `backend/CHANGELOG.md` as
  having once blocked this tool's automated traffic from a different
  network) flags traffic from a Codespaces/Azure IP range. MXI itself was
  confirmed reachable from arbitrary internet connections before this was
  built, but that's different from confirming Akamai doesn't fingerprint
  cloud-datacenter IP ranges specifically.

If any of these surface on first use, they're expected to need a small
follow-up fix, the same way this project's own MXI selectors needed
live-tested corrections before being trusted.

## Manual start / troubleshooting

If the browser tab doesn't open automatically, or you want to restart
either server by hand:

```bash
tail -f /tmp/amc-backend.log     # backend logs
tail -f /tmp/amc-frontend.log    # frontend logs

# restart backend
cd backend && npm run server

# restart frontend
npm run dev
```
