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

See `inference/constants.ts` for the buffer-day constants referenced in the
decision logic.
