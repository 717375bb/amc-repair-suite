# amc-repair-suite backend (Phase 1)

Standalone Node.js/TypeScript service that infers estimated ship dates (ESD) for
vendor repair orders. Reads two Excel reports, matches orders, applies a mix of
deterministic rules and AI-assisted classification, and writes results to a
local SQLite audit database plus a human-readable Excel export.

This is Phase 1 only: no email integration, no Maintenix (MXI) writes, no UI.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
```

Drop your test workbooks into `backend/data/` (gitignored).

## Running

```bash
npm run cli -- --file ./data/OOR_Tool_Bulletproof.xlsx --vendor-assignments ./data/Vendor_Assignments.xlsx
```

Flags:

- `--file <path>` (required) — workbook containing both the `Vendor OOR` and `CRA OOR` sheets
- `--vendor-sheet <name>` (default `Vendor OOR`)
- `--cra-sheet <name>` (default `CRA OOR`)
- `--vendor-assignments <path>` (optional) — `Vendor_Assignments.xlsx`, used only to attach CRA owner name/email for display
- `--db <path>` (default `data/audit.db`)
- `--out-dir <path>` (default `data/`)

Each run inserts a new row into `runs` and a full set of rows into
`esd_inferences` — prior runs are never overwritten, so results are diffable
across runs. A timestamped `output-<timestamp>.xlsx` is written to `--out-dir`
on every run.

## Architecture

- `src/parsers/` — Excel row parsing + defensive cell cleaning (whitespace-only
  cells, `_x000D_` artifacts)
- `src/matching/` — joins Vendor OOR to CRA OOR by Order Number
- `src/inference/` — the ESD decision engine (`applyInferenceRules.ts`) plus the
  swappable AI provider interface (`types.ts`, `anthropicProvider.ts`)
- `src/db/` — SQLite schema + audit persistence
- `src/output/` — Excel export
- `src/cli/` — every standalone CLI entry point (the ones `package.json`'s
  `scripts` invoke directly with `tsx`) — moved here as of the repo
  restructuring pass (2026-08-13) so they're not sitting loose alongside the
  organized module folders above. `server.ts` (the HTTP entry point) and
  `types.ts` (shared domain types) stay at `src/` root — genuinely different
  kinds of things from a one-shot CLI script.

See `inference/constants.ts` for the buffer-day constants referenced in the
decision logic. This README predates Phase 2/the MXI writer/the web UI and
hasn't been fully updated to match — `CLAUDE.md` at the repo root is the
living, currently-accurate reference; treat this file as an introduction to
the original Phase 1 pipeline specifically.

## Recording a new MXI discovery/codegen script

`npm run mxi:save-storage-state -- [--env production]` logs in and saves an
authenticated browser session to `data/mxi-{stage,production}-storage-state.json`
— load it into Playwright codegen so a new recording starts already logged
in (no credentials typed or captured during the recording itself):

```bash
npm run mxi:save-storage-state -- --env production
npx playwright codegen --load-storage=data/mxi-production-storage-state.json \
  --output=discovery-<vendorcode>-<analystinitials>-<case>-recording.ts \
  "https://maintenix.psa.aa.com/maintenix/common/ToDoList.jsp"
```

Swap `production` for `stage` (and the matching storage-state file) to record
against stage instead. Output files follow the `discovery-*.ts` naming
convention (`backend/.gitignore` — never committed).
