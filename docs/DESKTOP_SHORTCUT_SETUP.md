# Getting the desktop icon onto everyone's computer

Each analyst runs their own independent local copy of this app — there's no
shared server and no central IT push today (see `security.md` section 1).
So "everyone gets the icon" means each person does this same short,
self-service setup once on their own machine. This doc is written to be
handed to a teammate directly; no prior context needed.

## What you end up with

Two icons on your Desktop: "Start AMC Repair Suite" and "Stop AMC Repair
Suite". Double-clicking Start installs anything missing, starts both
servers running invisibly in the background (no console windows to leave
open or accidentally close), and opens the app in your browser.

The suite also stops itself automatically once the browser tab you were
using it in has been closed for about 30 seconds — closing the tab is
normally all you need to do. "Stop AMC Repair Suite" is there for when you
want to stop it explicitly instead (e.g. you're not sure it's still
running, or you closed the tab by mistake and want to be sure).

## Prerequisites (one-time, per machine)

- **Node.js** (LTS) — https://nodejs.org. Confirms with `node --version` in
  a terminal.
- **Git** — https://git-scm.com, if you don't already have it.
- Windows with PowerShell (built in — no separate install).

## Steps

1. **Clone the repo** to a normal folder you won't move later (e.g.
   `C:\Users\<you>\amc-repair-suite`) — the Desktop icon will point back at
   this exact location, so wherever you put it here is where it needs to
   stay:
   ```
   git clone <the repo URL your team uses> amc-repair-suite
   cd amc-repair-suite
   ```

2. **First launch — installs everything and creates your `.env`.**
   Double-click `Start-AMC-Repair-Suite.bat` right inside that folder (not
   a shortcut yet — the real file, this one time). First run installs
   frontend + backend dependencies (a few minutes) and creates
   `backend\.env` from `backend\.env.example` if it doesn't exist yet, then
   starts both servers and opens the app in your browser.
   - **Fill in `backend\.env` before relying on this for real work** —
     at minimum `ANTHROPIC_API_KEY` (ESD Finder's AI step) and the
     `MXI_STAGE_*`/`MXI_PROD_*` values, same list as `CLAUDE.md`'s
     `.env.example` reference. `CREDENTIAL_ENCRYPTION_KEY` matters too —
     see `security.md` section 1.3 for why losing it is unrecoverable.
   - **Log in with your own real MXI username/password** the first time
     the app asks — see `security.md` section 1.1 for why the login *is*
     your MXI identity, not a separate app password.

3. **Create the Desktop shortcuts** — from the same folder, in an ordinary
   PowerShell window (no admin rights needed):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\Create-Desktop-Shortcut.ps1
   ```
   This creates two real Windows shortcuts (`.lnk`) on your Desktop —
   "Start AMC Repair Suite" (points at the real `Start-AMC-Repair-Suite.bat`
   in this folder) and "Stop AMC Repair Suite" (points at
   `scripts\Stop-AMC-Repair-Suite.ps1`) — neither **copies or moves**
   anything out of this folder. That distinction matters: an earlier
   session already hit the exact failure mode of moving the `.bat` file
   straight to the Desktop, which breaks it (see
   `docs/INVOICE_PRICE_WRITER_HANDOFF.md`'s Part D) — the script exists
   specifically so nobody has to repeat that by hand.

4. **From now on**, just double-click "Start AMC Repair Suite" on your
   Desktop. Use "Stop AMC Repair Suite" if you want to stop it explicitly
   rather than just closing the browser tab.

## If something goes wrong

- **The shortcuts don't work after the folder gets moved or renamed.**
  Re-run step 3 from the new location — it always overwrites the old
  shortcuts with correct ones, safe to run as many times as you like.
- **Something looks wrong and there's no console window to check.** That's
  expected now (the servers run hidden) — check `logs\launcher.log`,
  `logs\backend.log`, and `logs\frontend.log` in the repo folder instead.
- **`Start-AMC-Repair-Suite.bat` itself prints "This file has been moved or
  copied."** That means someone double-clicked/copied the `.bat` directly
  to the Desktop instead of using the shortcut script. Delete that copy,
  go back to the real repo folder, and run step 3 instead.
- **PowerShell refuses to run the script at all** (a policy error, not the
  script's own output) — your machine's execution policy is blocking
  unsigned local scripts. The `-ExecutionPolicy Bypass` flag in the command
  above should already cover this for that one invocation; if it's still
  blocked, an admin may have a stricter machine-wide policy — ask IT rather
  than permanently lowering the policy yourself.
- **Anything about the app itself once it's running** (login, ESD Finder,
  write-ups, etc.) — see the root `CLAUDE.md` and `backend/README.md`,
  which are the living reference for how to actually use this once it's up.
