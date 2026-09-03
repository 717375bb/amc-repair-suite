# amc-repair-suite

Automation tooling for PSA Airlines' component repair team. Two independent
parts live in this repo:

- **Frontend** (repo root: `src/`, `index.html`, etc.) — Vite + React + Tailwind
  scaffold. Untouched so far; no backend integration wired up yet.
- **Backend** (`backend/`) — standalone Node.js/TypeScript service, its own
  `package.json`/`node_modules`, deliberately decoupled from the frontend.
  This is where all work has happened.

**Picking this up fresh? Read `docs/INVOICE_PRICE_WRITER_HANDOFF.md` first**
— it covers the most recent session's work (a new Invoice Price Writer
feature, ESD writer date-push/note-only changes, a backend-wide Pino
logging migration, and a local-launcher fix) and names the exact next
step still pending: a live, single-order test of the Invoice Price Writer
that was set up but never run.

## How to run this for a normal week (start here — no project history required)

All commands run from `backend/`, with `.env` already filled in (real
`ANTHROPIC_API_KEY`, `MXI_STAGE_*`, `AUTOMATION_API_KEY` — see
`.env.example` for the full list). `MXI_ENV` stays `stage`.

**0. Verify `.gitignore` is actually excluding sensitive paths** (`.env`,
discovery recording files, `tool-backups/`) before touching anything real —
a `.gitignore` entry that visually looks right has silently failed to match
twice before in this project (see Phase 2b below):
```bash
npm run verify-gitignore
```
Exits non-zero and prints exactly which path(s) aren't actually ignored if
anything's wrong; safe to run any time, doesn't touch any real data.

**1. Run inference against the real tool file, and populate its flag columns:**
```bash
npm run cli -- --from-tool "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" --write-back-flags
```
This reads `Vendor OOR`/`CRA OOR` from that file, runs the real AI
classification, writes a new run to `data/audit.db`, and populates
`Automation Flag`/`Flag Note`/`Suggested Action` in the file's `Output`
sheet — real Excel COM automation under the hood, with a timestamped
backup in `data/tool-backups/` made first, every time, no exceptions.
**Note the `Run ID` it prints** — you need it for step 3.

**2. Review.** Open the file in Excel. Filter/sort the `Output` sheet by
`Automation Flag`. Rows already marked `Updated` need nothing.
`No ESD Found` rows are informational (`Flag Note`/`Suggested Action`
explain why — scrap, quote-sent, stale date, or genuinely nothing found).
The ones needing a decision are `Pending Review` — each `Flag Note` already
states the inferred ESD, classification, and confidence.

**3. Approve or reject the ones you've reviewed:**
```bash
# Approve — writes to real stage MXI, verifies independently, self-heals
# a known silent-partial pattern (see writeEsdAndNotes.ts), then refreshes
# the tool-table with the real outcome:
npm run approve-and-write -- <runId> "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" approve P000AAAA,P000BBBB manual-approval

# Reject — never touches MXI, just records the decision and refreshes the tool-table:
npm run approve-and-write -- <runId> "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" reject P000CCCC manual-approval
```
Defaults to stage. Add `--env production` anywhere in the args (e.g. `...
approve P000AAAA manual-approval --env production`) to write to real live
Maintenix instead — an explicit, per-invocation opt-in, never an ambient
`.env`-wide default, so a leftover setting from an earlier session can't
silently redirect a real write. Requires `MXI_PROD_USERNAME`/
`MXI_PROD_PASSWORD` to be filled in in `.env` first.

**Correction: production is not untested.** This tool (and `server.ts`'s
`/approve`) has genuine, real production write history: a real batch of
~30 orders was written against production on 2026-07-15 (independently
verified via direct `mxi_writes` audit query — same order set tested in
stage on 2026-07-12 first, then deployed for real), predating a prior
version of this note that incorrectly called the first `--env production`
run "genuinely untested." That was wrong and is corrected here rather than
left standing. Still good general practice for any *new* kind of
production action, though: read-only smoke test first (`npm run
mxi:read-esd -- <orderNumber> --env production`) before trying a real
write against production you haven't exercised before.
Order numbers are comma-separated, no spaces. `manual-approval` (last arg)
is just a label recorded in the audit trail (`mxi_writes.approved_by`) —
use your own name/initials if you want it attributable. Re-run step 3
again later with different order numbers whenever you've reviewed more —
it always rebuilds the tool-table from the *full* real history for that
run ID, so earlier approvals never get overwritten back to "Pending
Review."

**To act on everything at once instead of typing each order number:**
pass the literal word `all` in place of the order-number list. It resolves
to every `flag='ok'` order for that run that doesn't already have a
recorded outcome (so it's never a re-write of something already approved/
rejected), prints the full resolved list, and does nothing further until
you add `--confirm` too — still a deliberate, reviewed action, just without
retyping every order number:
```bash
# First call (no --confirm) just lists what it would do — writes nothing:
npm run approve-and-write -- <runId> "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" approve all manual-approval --env production

# Add --confirm once you've reviewed that list to actually run it:
npm run approve-and-write -- <runId> "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" approve all manual-approval --env production --confirm
```

**A real bug was found and fixed: `--env production` silently kept
navigating to stage.** `selectors.ts` had `LOGIN_URL`/`TODO_LIST_URL`
hardcoded to the stage subdomain — env-aware credentials were correctly
threaded through (per the earlier `cliMxiClient.ts` work), but every actual
page navigation (login, order search) ignored `config.baseUrl` entirely and
went to stage regardless. Fixed: `login()`/`findOrderByNumber()`/
`navigateToOrder()` now take the URL as a parameter from the caller's
config; `MxiClient` derives a `todoListUrl` from `config.baseUrl` (swapping
`/security/login.jsp` for `/ToDoList.jsp`) — confirmed this reproduces the
exact previously-hardcoded stage URL, so the same derivation should hold
for production, though the production path itself is newly-exercised.
**Re-test `npm run mxi:read-esd -- <orderNumber> --env production` again**
if you tested this before today's fix — that earlier test was silently
still hitting stage.

**If the tool-table write-back fails because the Excel file is locked/open**
(the real MXI write may have already succeeded even though this step
failed — check the console output above the error before assuming
nothing happened): close the file in Excel, then re-run with `refresh`
instead of `approve`/`reject` — this replays the tool-table from the run's
*existing* `mxi_writes` history only. No order numbers, no MXI client, no
risk of re-writing (re-approving the same order again is NOT safe —
`writeEsdAndNotes` has no "already correct, skip" check, so it would
resubmit the ESD, duplicate the Notes to Receiver entry since that's an
append-only log, and reissue the order again):
```bash
npm run approve-and-write -- <runId> "C:\Users\<you>\Downloads\OOR Matcher.xlsb.xlsx" refresh
```

**That's the whole loop.** `--from-tool` alone (no `--write-back-flags`)
is safe to run read-only if you just want to see what a run would find
without touching the file. Everything else in this document is the
history of how the above came to exist and be trusted — useful for
understanding *why* it works this way, not required to *operate* it.

## Descope: personal ESD Matcher tool as an alternate input/output path

For a near-term deadline, added a second way to run the Phase 1 pipeline —
against the user's own personal Excel tool directly, instead of the
(never-built) email/Power Automate path. **Additive, not a replacement**:
the original `--file`/parsers/matching path is completely untouched.

**The file**: real name is `ESD Matcher.xlsb.xlsx` per the user, but the
actual file found and used (confirmed via a note in
`C:\Users\717375\Documents\Regarding the ESD Updater, there's.txt`, which
also independently confirmed the QUOTE_BUFFER_DAYS/EQD-anchor and Notes to
Receiver format questions already resolved above) is
`C:\Users\717375\Downloads\OOR Matcher.xlsb.xlsx` — three different names
were given across this project's conversation for what turned out to be
the same file. Despite "xlsb" in the filename, it's confirmed (by
inspecting the raw zip contents and Content_Types.xml, not the extension)
to be a genuine `.xlsx` (OOXML) file with **no VBA macros**
(`xl/vbaProject.bin` absent, main content type is the standard
non-macro-enabled `spreadsheetml.sheet.main+xml`).

**Sheets**: `Vendor OOR`, `CRA OOR` (same header names the existing
`parsers/vendorOorParser.ts`/`craOorParser.ts` already expect — confirmed
by direct inspection, not assumed), and `Output` — a **derived** sheet
computed live via Excel dynamic-array formulas (`FILTER`, `XLOOKUP`,
`ANCHORARRAY`) over the other two, not static data.

**CLI**: `--from-tool <path>` (in `cli.ts`) reuses the exact same
`parseVendorOor`/`parseCraOor`/`matchOrders`/`applyInferenceRules` pipeline
as `--file` — no new parser was built, since the headers already match
(confirmed live, not assumed) and reading the "Output" sheet directly would
mean trusting Excel's cached formula results, which are fragile (see
below). Mutually exclusive with `--file`.

**Real gap found while testing `--from-tool` mechanically**: the actual
downloaded file's `Vendor OOR`/`CRA OOR` sheets are currently **completely
empty** (headers only) — confirmed by direct cell inspection, not just
`rowCount` (which misleadingly still reports 321/115 rows, likely stale
`<dimension>` metadata from before the sheets were last cleared). This is
why the `Output` sheet's cached formula results show `#VALUE!` errors — no
real data to filter, not a formula bug. `--from-tool --dry-run` was run for
real against the actual file and correctly produced a valid, empty
(0-order) run — the wiring itself is proven; the pipeline's actual
classification logic on this file remains unverified until real order data
exists in it.

### `--write-back-flags`: writing Automation Flag/Flag Note/Suggested Action into Output

Separate, explicit opt-in flag (only valid with `--from-tool`, disabled
under `--dry-run` regardless) — kept deliberately decoupled from
`--from-tool` itself after the auto-mode permission classifier correctly
caught an early version of this code trying to write into the *real* live
file before it had ever been tested against a copy, exactly the boundary
this work was told not to cross.

**A real corruption risk was found and is why this doesn't use ExcelJS**:
a bare ExcelJS read+write round-trip (zero deliberate modifications, tested
only against a disposable scratch copy) drops `xl/metadata.xml`, the
entire `xl/richData/` folder, and `xl/calcChain.xml`, strips every
formula cell's `cm`/`vm` metadata-index attributes, and produces at least
one outright corrupted cell value (a stray untyped `NaN` literal replacing
a properly-typed `#VALUE!` error). Since `metadata.xml`'s `cm`/`vm`
attributes are exactly what ties a cell to its dynamic-array/spill
formula, this is a real, direct threat to the `Output` sheet's `FILTER`/
`XLOOKUP` formulas — confirmed via evidence, not assumed from ExcelJS's
general reputation.

**Fix: real Excel via COM automation instead** (`scripts/write-tool-output-flags.ps1`,
invoked from `output/writeToolOutputFlags.ts` via `child_process.execFile`).
Excel saving its own file preserves its own format perfectly by
construction. Confirmed installed and COM-automatable on this machine
(Office 16.0) before committing to this approach — user explicitly chose
this over a separate-report alternative once the ExcelJS risk was shown.

**Safety measures actually built and tested**:
- Non-negotiable timestamped backup (`data/tool-backups/<basename>-<timestamp><ext>`)
  before every write-back attempt, regardless of anything else.
- `xl/vbaProject.bin` presence check (real evidence, not filename-based) —
  report-only now that Excel COM automation is doing the actual write
  (a real macro project would be preserved correctly by Excel's own Save()
  regardless), but still checked and reported every time per the original ask.
- The PowerShell script refuses to proceed if the file is already open/
  locked (exclusive-open probe) — guards against a conflict with the user's
  own already-open Excel session.
- Only rows whose Order Number matches a record from this run are touched;
  `orphaned_vendor_row`/`orphaned_cra_row` records are skipped entirely
  since they can't appear in `Output`'s own `FILTER()` result to begin with.

**Template selection** (`selectTemplate` in `writeToolOutputFlags.ts`) implements
all 7 fixed templates from the spec. Only two are reachable yet in
practice — `Pending Review` (flag='ok') and the `No ESD Found` family
(`not_esd_relevant`/`quote_sent_reference`/generic/`past_date_rejected`,
distinguished by classification + whether `extractedBaseDate` is non-null)
— since this phase's non-goal is "no MXI writes yet." `Updated`/`Write
Failed` are built and ready for whichever future step wires
`writeEsdAndNotes` in and starts passing real per-order outcomes via the
`writeOutcomes` parameter.

**Tested end-to-end against a disposable test copy** (never the real
file), with synthetic seeded data (since the real file has none) — and the
seeding itself used Excel COM automation too, not ExcelJS, to avoid
corrupting the test copy before even testing the write-back logic. Real AI
classification (not `--dry-run`) confirmed all three fixed template
categories exercised: `explicit_date` → `Pending Review`, `not_esd_relevant`
→ `No ESD Found` (scrap wording), `quote_sent_reference` → `No ESD Found`
(quote-sent wording). Verified afterward, independent of the tool's own
success report:
- Backup file existed and was a faithful copy.
- All 3 rows' new columns matched the correct templates exactly.
- `Vendor OOR`/`CRA OOR` sheets and existing `Output` columns A-H untouched.
- `xl/metadata.xml` and `xl/calcChain.xml` **both survived** (unlike the
  ExcelJS round-trip), and the formula cells' `cm` attributes were intact
  with correctly-computed values (not errors) — direct proof the array
  formulas still work after the COM-automation save, not an assumption.

**A real encoding bug was found and fixed during this same testing pass**:
the first write-back run produced mojibake (`â€”` instead of `—`) in the
`not_esd_relevant` template's em dash — classic UTF-8-read-as-Windows-1252
corruption from Windows PowerShell 5.1's `Get-Content` not reliably
detecting UTF-8 without a BOM. Fixed with an explicit `-Encoding UTF8` on
the `Get-Content` call; re-tested and confirmed correct.

**Update — run for real against the real live file, real data, with real
consequences.** Once real order data existed in the file: `--from-tool
--dry-run` first (safe, mechanical check, 632 orders processed correctly).
Then a real run (Run ID 13, real AI calls) plus `--write-back-flags` — the
first attempt was **safely blocked** by the file-lock check (the file was
open in the user's own Excel session at the time); retried afterward using
the already-computed Run 13 records read back from the DB (not re-running
the AI a second time — avoids paying for 107 API calls twice). Result,
independently verified: 131 rows updated (44 `Pending Review` / 87 `No ESD
Found`), and a **full order-by-order cross-check** (every one of the 131
rows individually, not just the aggregate counts) against the DB found
**zero mismatches**. Two real timestamped backups exist in
`data/tool-backups/` from this session (one from the blocked attempt, one
from immediately before the successful write).

### A real reconciliation gap was found and fixed: the printed summary's counters overlap

After the real run above, the printed summary's classification breakdown
(`42 explicit_date, 24 vendor_quote_estimate, ...`) summed to 227 while
"632 orders processed" was also printed — looking like 405 orders had
vanished. **They hadn't.** Queried the real `esd_inferences` table
directly for Run 13 and printed the complete, literal (flag, classification)
cross-tab — all 13 non-zero combinations, confirmed to sum to exactly 632:

```
no_esd_found         explicit_date            1
no_esd_found         none                     28
no_esd_found         not_esd_relevant         9
no_esd_found         parts_pending            22
no_esd_found         quote_sent_reference     7
no_esd_found         vendor_quote_estimate    20
ok                   explicit_date            40
ok                   vendor_quote_estimate    4
orphaned_cra_row     (NULL)                   485
orphaned_vendor_row  explicit_date            1
orphaned_vendor_row  none                     1
orphaned_vendor_row  not_esd_relevant         10
orphaned_vendor_row  quote_sent_reference     4
```

The real cause: the printed summary's numbers were never a mutually
exclusive partition of 632 in the first place — `explicit_date`/
`vendor_quote_estimate`/`parts_pending`/`not_esd_relevant`/
`quote_sent_reference` count by **classification alone, regardless of
flag** (so `ok`, `no_esd_found`, and `orphaned_vendor_row` rows are all
mixed into the same number); `no_esd_found` (87) is a **flag-level total**
that overlaps almost entirely with those classification counts; and
`past_date_rejected` (22) is a **subset of `no_esd_found`**, counted a
third time. Summing them was never valid arithmetic — not a data bug, a
presentation bug. `classification='none'` (29 rows) was also never printed
at all, a genuine omission on top of the overlap.

First pass at explaining this cited only part of `orphaned_vendor_row`'s
16 rows (2 of them) — a real, fair catch that the full cross-tab existed
in the query output but wasn't fully surfaced in the written explanation.
Re-run and printed in full above: `orphaned_vendor_row` = 1 `explicit_date`
+ 1 `none` + 10 `not_esd_relevant` + 4 `quote_sent_reference` = 16, and
`not_esd_relevant`/`quote_sent_reference` (19 + 11 = 30 total) split
exactly as hypothesized: 16 land in `no_esd_found` (9 + 7), the remaining
14 (10 + 4) land in `orphaned_vendor_row` — confirmed with the real query,
not a plausibility argument.

**Fixed for good, not just explained**: `cli.ts`'s printed summary no
longer prints the overlapping counters at all. `RunSummary`
(`types.ts`) dropped the per-classification/per-flag fields entirely
(`explicitDate`, `quoteEstimate`, `partsPending`, `notEsdRelevant`,
`quoteSentReference`, `noEsdFound`, `pastDateRejected`) — they were only
ever written in `applyInferenceRules.ts` and only ever read by the old
`printSummary`, so removing them outright (rather than leaving them unused)
closes off the chance of a future maintainer reusing them and reintroducing
the exact same ambiguity. In their place, `printFlagClassificationCrossTab()`
computes the real, always-accurate (flag, classification) breakdown
directly from the run's `records` array itself — not from separately
accumulated counters that can drift — so it can't misrepresent the total
the way the old counters did. Verified against real data:
`--from-tool --dry-run` prints a 4-row cross-tab summing exactly to 632.

## Current status: Phase 1 complete, Phase 2 (MXI writer) built and wired

**Phase 1** proved the ESD (estimated ship date) inference logic works
against real historical data. Full spec: `backend/PHASE1_SPEC.md` if it was
saved (check before assuming it wasn't — it wasn't, originally, which is why
Phase 2's spec is saved this time).

**Phase 2** adds an HTTP approval API and a Playwright-based MXI writer, so
an approved ESD actually gets written into MXI — human-approved, one order
at a time, never automatic. Full spec + implementation status:
`backend/PHASE2_MXI_WRITER_SPEC.md`. Still not done: email/Graph
integration, custom UI, multi-user auth, any workflow besides ESD.

**Both the ESD and Notes to Receiver read/write paths into real stage MXI
now work**, including a combined write (`writeEsdAndNotes`) that updates
both fields in one edit session with a single reissue. `selectors.ts` is all
real, all verified against actual stage MXI — none of it guessed. The ESD
write path required two real live-testing corrections before it was
trustworthy (a field that silently rejects keystrokes past the first one —
see Phase 2c below). The Notes to Receiver work required a live diagnostic
to uncover the real page architecture (RO Details page, separate Order
Lines / Details tabs, "Issue Order" as a shared top-level action) before any
code was written — see `PHASE2_MXI_WRITER_SPEC.md`'s Notes to Receiver
addendum before touching this code.

**Update — Part C's auto-write and human-review tiers have now both run
for real, end to end, against all 44 eligible Run 13 orders.** The
reissueOrder() anomaly did reproduce at scale (confirmed on ordinary
orders, not just `P000B2YT`) and turned out worse than known — 2 of 3
timeout "failures" had silently committed the ESD field correctly anyway.
Fixed properly, not just noted: `partCAutoWrite.ts` now independently
re-verifies every outcome (not just reported successes), a new
"Partially Updated" tool-table category exists for exactly this case, and
a distinct "Not Found in Stage" category (added after user feedback
mid-run) cleanly separates "order doesn't exist in the sandbox" from an
actual write failure. Final tool-table state across all 131 candidate
rows: 87 No ESD Found, 35 Updated, 8 Not Found in Stage, 1 genuine Write
Failed. See PHASE2_MXI_WRITER_SPEC.md's "Part C run at real scale"
addendum for the full account.

**Original follow-up, now superseded above**: repeated the same combined
write against a fresh, never-before-touched order (`P000AUCX`) — every
step succeeded cleanly and independent verification matched exactly. The
anomaly didn't reproduce *that time*. See PHASE2_MXI_WRITER_SPEC.md's
"anomaly did NOT reproduce on a fresh order" addendum for that
methodology, superseded by the real-scale run above.

**Original concern, for context**: a routine real smoke test of the
combined write (`writeEsdAndNotes`) failed against `P000B2YT` —
`reissueOrder()`'s "Issue Order" click timed out, yet the ESD value
persisted anyway, contradicting Phase 2c's "Issue Order is required"
finding. See PHASE2_MXI_WRITER_SPEC.md's "reissueOrder() reliability gap"
addendum for that original finding.

### What it does

Reads two Excel reports (Vendor OOR — vendor's returned report — and CRA OOR
— PSA's internal daily report, typically two sheets in one workbook), matches
rows by Order Number, infers an ESD per order via a mix of deterministic
rules and AI classification, writes every result to a local SQLite audit DB
(append-only across runs, never overwritten), and exports a human-readable
Excel report.

### Decision logic (the core of Phase 1)

1. **Step 1** — if Vendor OOR's `RO ESD` column has a parseable date, trust it
   directly (+3 days, `SHIPPING_BUFFER_DAYS`). No AI call. This is deliberate:
   that field is the vendor's actual promise date; free-text Notes often
   reference a *different* date (e.g. the vendor's own upstream part order).
2. **Step 2** — if RO ESD is blank, call Claude on `Vendor Notes` +
   `Current Status` via forced tool-calling (see `inference/anthropicProvider.ts`).
   Six possible classifications: `explicit_date`, `vendor_quote_estimate`
   (explicitly recognizes "EQD"/"estimated quote date" phrasing as a direct
   cue, not just generic estimate language), `parts_pending`,
   `not_esd_relevant` (scrap/shipped references — takes priority over any
   other date mentioned in the text), `quote_sent_reference` (a quote was
   sent but no computable date — tagged for a future quote-automation
   workflow, not forced into an estimate), or `none`.
3. **Step 3** — apply the offset deterministically in code, never in the
   prompt: `explicit_date` +3d, `vendor_quote_estimate` +25d
   (`QUOTE_BUFFER_DAYS` — anchored on the extracted EQD date itself, not
   today), `parts_pending` + AI-reasoned offset (20-30d,
   `PARTS_PENDING_MIN/MAX_DAYS`, falls back to `PARTS_PENDING_FALLBACK_DAYS`
   = 20 if the AI doesn't return a confident value in range).
   `not_esd_relevant` / `quote_sent_reference` never get an offset applied —
   `extractedBaseDate` is forced to `null` for both regardless of what the
   AI returns (deterministic override, not just a prompt instruction), so
   they always fall through to `no_esd_found` in Step 4.
4. **Step 4** — sanity check regardless of source: if the computed ESD is in
   the past, override the flag to `no_esd_found` rather than surface a stale
   date. Raw classification/date are kept in the audit record either way.
5. **Step 5** — no special-casing for `Scrap Approved` / `Exchange Approved`
   order statuses. Verified via smoke test that they run identical logic.

All constants live in `backend/src/inference/constants.ts` — change there,
not inline. `QUOTE_BUFFER_DAYS` was corrected from an earlier, never-applied
14 to 25 — see the "Classification/EQD/buffer discrepancy" note below for
what that correction was about.

### Provider architecture

`backend/src/inference/types.ts` defines `EsdInferenceProvider` /
`EsdInferenceInput` / `EsdInferenceResult` so the model/vendor is swappable.
`AnthropicEsdProvider` (`anthropicProvider.ts`) is the real implementation:
model `claude-haiku-4-5-20251001`, forced `tool_choice` on a
`record_esd_inference` tool (never free-text JSON parsing), retries once on
API error or malformed tool response, then falls back to
`classification: 'none', confidence: 'low'` with an explanatory
`reasoningNote` rather than crashing the run.

`AzureOpenAiEsdProvider` (`azureOpenAiProvider.ts`) is a deliberate stub —
`throw new Error('Not implemented')` — left as a seam for later, not called
by anything.

`DryRunEsdProvider` (`dryRunProvider.ts`) was added mid-session so the whole
pipeline (parsing → matching → Step 1 → DB → Excel export) can be exercised
against real files with **zero API calls and no key required** — every
order that would reach Step 2 comes back `classification: 'none'`. Use
`--dry-run` on the CLI.

### File map

```
backend/
  src/
    cli.ts                        entry point (commander)
    types.ts                      shared domain types (rows, MatchedOrder, InferenceRecord, RunSummary)
    parsers/
      cellUtils.ts                 shared cell cleaning (whitespace-blanks, _x000D_ stripping)
      sheetUtils.ts                shared readSheetRows() — header-index + per-row get() closure, used by all three parsers below
      vendorOorParser.ts
      craOorParser.ts
      vendorAssignmentsParser.ts   enrichment only — never filters/drops rows
    matching/
      matchOrders.ts               joins on normalized Order Number; orphans flagged, not dropped
    inference/
      types.ts                     EsdInferenceProvider interface
      constants.ts                 buffer-day constants
      dateUtils.ts                 parseFlexibleDate — structured RO ESD / AI ISO dates only, not free-text regex
      anthropicProvider.ts         real provider
      azureOpenAiProvider.ts       stub, not implemented
      dryRunProvider.ts            no-op provider for --dry-run
      applyInferenceRules.ts       the Step 1-5 decision engine
    db/
      schema.sql                   runs + esd_inferences + mxi_writes tables (reference copy)
      db.ts                        schema inlined here too (so tsx dev and a future tsc build both work without asset-copy step); also getPendingEsdUpdates, getActionableEsdInference, insertMxiWrite
    output/
      exportExcel.ts
      writeToolOutputFlags.ts      writes Automation Flag/Flag Note/Suggested Action into the tool file's Output sheet via real Excel COM automation (scripts/write-tool-output-flags.ps1) — backup first, always. 9 templates: Pending Review, Updated, Partially Updated, Write Failed, Not Found in Stage, Rejected by CRA, and the 3 No ESD Found variants. See PHASE2_MXI_WRITER_SPEC.md's Part C addenda for why each exists.
    mxiWriter/                     Phase 2
      config.ts                    MXI_ENV literal-value guard (stage|production), prod warning banner
      mxiClient.ts                 single persistent Playwright browser context; login-once + re-auth-once-then-halt
      esdFormatting.ts             toMxiDateFormat() (ISO -> DD-MMM-YYYY) and assembleNoteText() (Vendor Notes -> "M.d.yy - text" entry) — shared by server.ts and approveAndWrite.ts, extracted from server.ts to avoid duplicating this logic.
      selectors.ts                 ALL real now (from codegen recordings + live diagnostics against stage): login/findOrderByNumber/navigateToOrder/readEsdField/readNoteToReceiver/readIssuedCount (read) + updateEsdField/confirmEsdLineEdit/updateNoteToReceiver/reissueOrder/submitChanges (write). updateEsdField uses .fill() directly (single value, overwrite is correct there); updateNoteToReceiver reads the field first and APPENDS (`${existing}\n\n${newEntry}`) since Notes to Receiver is a real accumulating log, not a single value — confirmed from real order history, see PHASE2_MXI_WRITER_SPEC.md's "Notes to Receiver append fix" addendum. Returns the pre-write value so callers can verify prior history survived, not just that the new entry landed. "Issue Order" (reissueOrder) is a top-level RO Details action shared by both ESD and Notes edits — see the same spec doc for the full architecture (RO Details page / Order Lines vs Details tabs) this was built from. attemptCancelEdit is best-effort cleanup only — confirmed via live diagnostic that no cancel/exit/close control exists at the one point checked so far.
      writeEsdAndNotes.ts          combined orchestrator — updates ESD (if pending) and/or Notes to Receiver (if pending) in one edit session, then reissues once. **Always independently re-verifies the real outcome, regardless of whether the attempt threw** — a real 40-order run found a thrown exception here doesn't reliably mean nothing changed (ESD can silently commit while Notes to Receiver never runs); this is now a structural guarantee, not just a batch-script behavior. If it detects exactly that pattern (ESD correct, note missing), it makes ONE self-healing follow-up attempt at just the notes step before reporting failure — so a `success` result means both parts you asked for are genuinely correct. Two call sites, both requiring a human-specified order number: server.ts's /approve handler, and approveAndWrite.ts/mxiWriteEsd.ts's CLI tools. Never automatic/unattended.
      cliMxiClient.ts              createReadyMxiClient(env = 'stage') — shared bootstrap (env read, client init, ready-state check) used by mxiReadEsd.ts, mxiWriteEsd.ts, approveAndWrite.ts, and saveStorageState.ts. Supersedes the old stage-only stageClient.ts — env is now an explicit argument, not hardcoded. 'stage' reads MXI_STAGE_BASE_URL/MXI_STAGE_USERNAME/MXI_STAGE_PASSWORD; 'production' reads MXI_PROD_BASE_URL/MXI_PROD_USERNAME/MXI_PROD_PASSWORD — a fully separate credential pair from server.ts's MXI_USERNAME/MXI_PASSWORD, by design.
      parseEnvFlag.ts              pulls an optional `--env stage|production` out of argv for the three CLI tools below (defaults to 'stage' if absent, throws on anything else) — same case-sensitive strictness as config.ts's MXI_ENV guard.
      saveStorageState.ts          one-off: `npm run mxi:save-storage-state -- [--env production]` — logs in, saves authenticated session to data/mxi-{env}-storage-state.json so codegen recordings can start pre-authenticated. **Correction (repo restructuring review, 2026-08-13): the "Always stage — no --env option" claim previously here was wrong** — the file's own code (`parseEnvFlag`, env-suffixed output filename) has supported both stage and production for a while; this doc just hadn't been updated to match. Verified directly against the source, not assumed.
    server.ts                      Phase 2 HTTP API (Express): GET /health (open), GET /pending-esd-updates + POST /esd-updates/:orderNumber/{approve,reject} (gated by X-Automation-Key == AUTOMATION_API_KEY). Uses esdFormatting.ts's toMxiDateFormat()/assembleNoteText() to convert the DB's stored values into what the writer expects.
    mxiReadEsd.ts                  read-only smoke test — `npm run mxi:read-esd -- <orderNumber> [--env production]`; prints both RO ESD and Notes to Receiver; own credential vars (MXI_STAGE_*/MXI_PROD_*), never the writer's
    mxiWriteEsd.ts                 read-write smoke test — `npm run mxi:write-esd -- <orderNumber> <newDate> [noteText] [--env production]`; reads current ESD (and Note, if noteText given), writes new value(s) via writeEsdAndNotes, confirms via read-back, prints originals for manual revert (the printed revert command carries the same --env forward). Direct CLI only, not wired to /approve.
    approveAndWrite.ts             `npm run approve-and-write -- <runId> <toolFilePath> approve|reject <orders>|all <approvedBy> [--env production] [--confirm]` — the real, permanent "review then act" tool for the --from-tool workflow (see "How to run this" at the top of this doc). Approve calls writeEsdAndNotes per order (trusting its own always-verify guarantee) and records to mxi_writes; reject just records the decision, no MXI call (--env has no effect on reject). `all` resolves to every flag='ok' order for the run with no recorded outcome yet, and requires --confirm before it acts (otherwise it only lists what it would do). A separate `refresh` action (`<runId> <toolFilePath> refresh`, no order list) re-writes the tool-table from the run's existing mxi_writes history only, with no MXI client and no new write — for retrying the tool-table step after a file-lock failure without re-touching an already-successful order (re-running approve on the same order is NOT idempotent: writeEsdAndNotes has no skip-if-already-correct check, so it would resubmit the ESD, duplicate the Notes to Receiver entry, and reissue again). Either way, refreshes the tool-table afterward using the FULL historical outcome set reconstructed from mxi_writes for that run — not just this invocation's orders — so earlier approvals never get overwritten back to "Pending Review". Supersedes the deleted, one-off partCAutoWrite.ts.
  scripts/
    write-tool-output-flags.ps1   real Excel COM automation (not ExcelJS — confirmed live that a bare ExcelJS round-trip drops this workbook's dynamic-array formula metadata and corrupts a cell value) that writes the 3 tool-table columns. Refuses to proceed if the file is already open/locked elsewhere.
  data/                            gitignored — real xlsx files + audit.db + exports + mxi-stage-storage-state.json (also has its own explicit .gitignore entry, not just the folder rule) + tool-backups/ (timestamped pre-write-back backups of the real tool file) live here
  .env.example                     ANTHROPIC_API_KEY=, MXI_ENV=, MXI_USERNAME=, MXI_PASSWORD=, MXI_STAGE_BASE_URL=, MXI_PROD_BASE_URL=, DEFAULT_APPROVED_BY=, MXI_STAGE_USERNAME=, MXI_STAGE_PASSWORD=, MXI_PROD_USERNAME=, MXI_PROD_PASSWORD=, AUTOMATION_API_KEY=
```

## Classification/EQD/buffer discrepancy — investigated and resolved

A prior prompt (from a session/context not visible in this one) asked for
three specific changes to the inference engine: two new classifications
(`not_esd_relevant`, `quote_sent_reference`), explicit "EQD"/"estimated
quote date" recognition in the AI prompt, and `QUOTE_BUFFER_DAYS` changed
from 14 to 25. A later session found none of it in the codebase and flagged
the discrepancy rather than guessing. Investigated properly before building
anything:

**What was actually found, checked directly (not assumed):**
- `constants.ts`: `QUOTE_BUFFER_DAYS` was `14` — the change to 25 had never
  been applied.
- `anthropicProvider.ts`'s system prompt: no mention of "EQD" or "estimated
  quote date" anywhere — only generic "estimate or quote date" language.
- `not_esd_relevant` / `quote_sent_reference`: grepped the entire backend —
  zero occurrences anywhere in actual code (only in the prior session's own
  discrepancy note in `PHASE2_MXI_WRITER_SPEC.md`, which is what raised the
  flag in the first place).

**Git history check**: `constants.ts`, `anthropicProvider.ts`, `types.ts`,
and `applyInferenceRules.ts` have **never been committed to git at all** —
`git log --all` on each returns nothing. The repo's entire commit history
is two commits (`Initial UI shell...` and `Implement isSessionAlive()...`),
neither touching these files. So this isn't a case of work being lost via
git — there's no history to lose it from. Combined with directly reading
current file contents (above), the honest conclusion is this specific work
was simply never done, not lost.

**Incidental finding worth knowing about, not directly answering the
question above**: `mxiClient.ts`/`selectors.ts` (the only two files tracked
in git at all) show real, committed work — including a genuine
`isSessionAlive()` implementation — dated the same day as this session,
authored outside this conversation's own history. This confirms other
sessions/processes have been actively working on this repo in parallel;
worth keeping in mind that "what I remember from this conversation" and
"the actual current state of the repo" can diverge, and checking the latter
directly (as done here) is what actually matters.

**All three now implemented**, verified via `tsc --noEmit`:
- `EsdClassification` (`types.ts`) and `EsdInferenceResult['classification']`
  (`inference/types.ts`) both extended with `not_esd_relevant` and
  `quote_sent_reference`.
- `anthropicProvider.ts`'s system prompt teaches both new categories, names
  EQD/"estimated quote date" explicitly as a `vendor_quote_estimate` cue,
  and instructs the AI to never return a date for the two new
  classifications — enforced deterministically in `applyInferenceRules.ts`
  too (`extractedBaseDate` forced to `null` for both regardless of what the
  AI returns), not just left to the prompt.
  `not_esd_relevant`/`quote_sent_reference` never get an offset applied in
  Step 3, so they fall through Step 4 to `flag = 'no_esd_found'` for free —
  no special-casing needed there.
- `QUOTE_BUFFER_DAYS` is now `25`, with a comment confirming the anchor is
  the extracted EQD date, not today's date (matches how the code already
  applied it — `addDays(extractedBaseDate, QUOTE_BUFFER_DAYS)` — the
  constant's value was wrong, not its usage).
- `RunSummary` and the CLI's printed summary both got `notEsdRelevant` /
  `quoteSentReference` counters, for the same observability every other
  classification already had.

**Update — actually run for real, not just typechecked.** The above was
implemented and `tsc --noEmit`-clean, but had never been executed against
the real Anthropic API — a real gap, caught when asked directly whether it
had "run successfully yet." A real `ANTHROPIC_API_KEY` is available in
`.env`, so a small, targeted script called `AnthropicEsdProvider` through
`applyInferenceRules` with 7 hand-crafted vendor-note examples (2× each new
classification, 2× EQD-phrasing variants, 2× unaffected controls:
`explicit_date`, `parts_pending`) — not the full production pipeline
(running that for real against the whole 589-order file is still a
separate, bigger, not-yet-done step, see below). **All 7 matched
expectations**, including the one that actually matters most: for both EQD
examples, `inferredEsd` was verified to be exactly 25 days after the
*extracted* EQD date (not today's date) — confirming the anchor point, not
just the constant's value. `not_esd_relevant`/`quote_sent_reference` cases
both correctly got `extractedBaseDate: null` and `flag: 'no_esd_found'`
straight from the real model's output, no forcing needed to see it work.
Script deleted after use, per the project's throwaway-diagnostic
convention.

## Validation done so far (across both sessions)

**Phase 1:**
- `tsc --noEmit` is clean.
- Synthetic fixture + stub provider confirmed: Step 1 ignores conflicting
  free-text dates, Step 2 AI path triggers when `RO ESD` is blank,
  `Scrap Approved` runs identical logic with no branch, orphaned rows
  preserved and correctly flagged, re-running inserts a new `runs` row
  rather than overwriting.
- Ran `--dry-run` against the **real** workbook
  (`backend/data/OOR_Tool_Bulletproof.xlsx`, 589 total order rows) and
  `Vendor_Assignments.xlsx`: 176 matched, 26 orphaned (vendor-only), 387
  orphaned (CRA-only), 75 explicit dates resolved via Step 1 alone, 127
  orders would need an AI call.
- **The 387 CRA-only orphan question is now resolved** (see Phase 2 below)
  — confirmed expected, not a bug.

**Phase 2:**
- `tsc --noEmit` is clean across the whole backend.
- Orphan-rate diagnostic (`matching/orphanDiagnostics.ts`) built and run
  against the real file. First pass (vendor-name overlap alone) produced a
  misleading "not confirmed" — investigation showed vendor-name overlap
  isn't a real bug signal (a vendor with more open orders than replies this
  cycle will always produce some). Rebuilt to check the thing that actually
  matters — exact Part Number + Serial Number match under a *different*
  Order Number for the same vendor — and got **0 likely duplicates**.
  Hypothesis confirmed: the orphan rate is reporting coverage, not a
  matching bug.
- Full server run against the real Phase 1 audit DB (65 pending orders):
  `/health`, `/pending-esd-updates`, `/reject` (audit row confirmed via
  direct SQL), `/approve` (tested at two depths — see
  `PHASE2_MXI_WRITER_SPEC.md`'s Implementation status section for exactly
  what was and wasn't reachable without real MXI access), production guard
  (`MXI_ENV=Production` refused, `MXI_ENV=production` started with the
  warning banner), and append-only re-approval (two `/approve` calls on the
  same order produced two distinct `mxi_writes` rows).
- Chromium installed via `npx playwright install chromium` (background,
  succeeded) — needed to prove a real browser launch reaches the
  `selectors.ts` stub rather than crashing.
- Grep self-check done: `writeEsd(` has exactly one call site
  (`server.ts`'s `/approve` handler).

**Phase 2b (real selectors, read path):**
- User ran `npx playwright codegen` against real stage MXI and handed over
  the recording. **The recording had a live, unredacted credential in it**
  despite the user believing they'd stripped it — flagged immediately,
  never used/copied, user advised to rotate. Deleted only after the read
  path was confirmed working and `git status`/`git log --all` confirmed it
  was never staged or committed.
- **Found and fixed an unrelated real bug in `backend/.gitignore`**: the
  `.env` and `discovery-recording.ts` entries had literal quote characters
  in them (`".env"` not `.env`), so git wasn't actually ignoring either
  file — `git check-ignore` confirmed neither matched before the fix, both
  match after. Nothing had been staged in the meantime, but this was a live
  landmine (the real `.env` holds real secrets) worth knowing was there.
  **Lesson: a gitignore entry that visually looks right still needs
  `git check-ignore -v` to confirm it actually matches** — don't trust a
  read-through.
- Implemented `login`, `findOrderByNumber`, `readEsdField` in
  `selectors.ts` from the recording. One correction versus the literal
  recording: the recorded flow clicked a "Sign In" button after pressing
  Enter in the password field, but pressing Enter alone already submits and
  navigates away — the button click was removed (confirmed via debug
  screenshot showing the timeout was because that button no longer existed
  on the post-login page).
- Verified end-to-end against real stage MXI, order `P000AG1D`: login
  succeeds (screenshot shows real inventory data, logged in as "BRAYDEN
  BURY (PSA ADMIN)"), `readEsdField` returned `19-FEB-2026`, cross-checked
  against a screenshot of the real "Edit Order Lines" page showing
  "Promised By: 19-FEB-2026 10:52 EST" for that order's line 1 — exact
  match (the selector correctly isolates the date sub-field from the
  separate time/timezone sub-fields).
- New tool: `npm run mxi:read-esd -- <orderNumber>` (`src/mxiReadEsd.ts`).
  Read-only, never fills/submits/edits anything. Uses its own
  `MXI_STAGE_USERNAME`/`MXI_STAGE_PASSWORD`/`MXI_STAGE_BASE_URL` env vars,
  deliberately separate from the writer's `MXI_USERNAME`/`MXI_PASSWORD` so
  this diagnostic never depends on the writer's config.
- **Open, unresolved**: does entering "Edit Lines" to read the ESD field
  place a record lock or leave an "edited by" trail in MXI, even without
  submitting? There's no read-only display of the field outside that edit
  view. Matters more if this read path is ever used for routine/automated
  polling rather than one-off checks.

**Phase 2c (write path — `updateEsdField`, `submitChanges`):**
- Built `saveStorageState.ts`/`MxiClient.saveStorageState()` and an explicit
  `data/mxi-stage-storage-state.json` `.gitignore` entry (verified via
  `git check-ignore -v` before the file even existed) so the user could
  record the write flow already logged in — no login form, no credentials,
  in the new recording.
- **First real finding**: a smoke test that stopped `submitChanges()` after
  "YES" (skipping "Issue Order", per initial instruction to hold off on it)
  completed with no error, but the date change did not persist on re-read.
  Reported rather than assumed success; user confirmed "Issue Order" is
  actually required for a date-only change and asked for it to be added.
  `submitChanges()` now runs the full recorded sequence through the final
  "OK".
- **Second, more serious finding: `updateEsdField` corrupted the live field
  twice before being caught.** The recorded/described interaction (click →
  auto-select → Backspace → type) was replicated with Playwright
  (`.click()` + `Control+A` + `Backspace` + `.pressSequentially()`) and
  produced a garbled hybrid value both times — `10-JUL-2026` became
  `10-JUL-2020` on the first attempt, and the attempted fix produced
  `10-JUL-2021` on the second. Both were caught immediately by `writeEsd`'s
  own read-back check (reported as `write_status: 'failed'`, never silently
  treated as success) — but the wrong value had already been submitted to
  the live stage record each time. **A write reporting failure and a record
  being left in a wrong state are two different facts** — worth remembering
  before this is trusted anywhere less closely watched than direct CLI
  testing.
- Root-caused via a non-destructive diagnostic script (click, inspect DOM
  selection state, type one character at a time, screenshot — no submit)
  run directly against the live order: the field's `selectionStart`/`End`
  confirmed the whole value *does* get selected on click (not a selection
  bug), but a `Backspace` press only ever removed one character, and every
  character typed after the first was silently rejected — pointing at
  custom per-keystroke JS validation on this field (a common pattern in
  older masked date inputs) that enforces a fixed length by rejecting
  further input once "full," regardless of reported selection state.
  `.fill()` (sets the value via a direct DOM `input`/`change` event, not
  simulated keydown/keypress) was tested the same non-destructive way and
  worked correctly. `updateEsdField` now uses it.
- Fixed for real: ran a genuine end-to-end write (which also corrected the
  live corrupted value back to `10-JUL-2026`), then independently
  re-verified with the separate `mxi:read-esd` tool (shares no code with
  the write path's own verification) — both confirm `10-JUL-2026`.
- New tool: `npm run mxi:write-esd -- <orderNumber> <newDate>`
  (`src/mxiWriteEsd.ts`). Reads current value, writes new, confirms via
  read-back, prints the original clearly for manual revert. Direct
  one-order-at-a-time CLI invocation — explicitly not wired into
  `/approve`'s automatic path yet.
- Updated the "only one call site for `writeEsd()`" comments in
  `server.ts`/`writeEsd.ts` — there are now legitimately two (`/approve`
  and the CLI tool). The real invariant was always "never
  automatic/unattended," not "exactly one caller" — comments now say that.

## Not yet done / open items for next session

- **Still never run the full Phase 1 pipeline (real file, no `--dry-run`)
  against the real Anthropic API.** A real `ANTHROPIC_API_KEY` is in fact
  available now (this was stale — see the Classification/EQD/buffer
  section above, a small *targeted* real-API test of just the new
  classification logic has been run and passed). But the ~127 real orders
  from the actual 589-order file that would hit Step 2 are still
  unverified as a full run — that's a separate, bigger step (new `runs`
  row, real cost across ~127 calls) from the 7-example targeted check
  above, and hasn't been done.
- ~~`updateEsdField` / `submitChanges` unimplemented~~ — done, see Phase 2c.
  Both the read and write paths are now real and verified.
- The record-lock/edit-trail question (readEsdField's caveat) — still open.
- `mxiClient.isSessionAlive()` needs a real signal for "this page looks
  logged out" — currently a placeholder that just trusts the last
  successful login. Now that a real login exists, this could be captured
  next time (e.g. try a lightweight authenticated request, see what a
  logged-out response looks like).
- ~~Next real step: wire Power Automate → Teams approval card →
  `/pending-esd-updates` / `/approve` / `/reject`~~ — the API side is now
  ready for that: `X-Automation-Key` auth added and tested for real (401 on
  missing/wrong key), a real ISO→`DD-MMM-YYYY` date-format bug caught and
  fixed before it could corrupt a live write, and all three endpoints
  exercised for real against the actual audit DB and real stage MXI (see
  "Automation API auth" under Running It for the exact curl commands and
  results). **Building the actual Power Automate flow itself is still not
  started** — that's the literal next step now that the API is verified.
- Phase 1 deliverables checklist not yet formally re-walked with a real
  (non-dry-run) run — do that once an Anthropic key exists.
- No email/Graph integration, no custom UI, no multi-user auth, no
  workflow besides ESD — all still explicitly out of scope.
- **Notes to Receiver added** (`writeEsdAndNotes`, replacing `writeEsd`) —
  real architecture discovery + live-tested notes-only and combined
  ESD+Notes writes. Full detail in `PHASE2_MXI_WRITER_SPEC.md`'s Notes to
  Receiver addenda.
  - ~~The note-text assembly convention... unverified assumption~~ —
    resolved: real precedent found (date-first, `M.d.yy - text`), and a
    real destructive-overwrite bug this surfaced (Notes to Receiver is an
    accumulating log; the original `.fill()` would have erased history) is
    fixed and verified against a real order with genuine prior history
    (`P000AG1D`) — see the "Notes to Receiver append fix" addendum.
  - ~~"Quote-sent and not_esd_relevant classifications"~~ — resolved, see
    the "Classification/EQD/buffer discrepancy" section above: neither
    existed anywhere in the codebase; both are now implemented for real.

## Running it

**Or run the whole app (frontend + backend) with one click via GitHub
Codespaces** — see the badge in root `README.md` and full details in
`docs/CODESPACES.md` (secret list, what's auto-generated vs. required,
what's proven vs. still unverified from a real launch). Backend stays
bound to `127.0.0.1` exactly as it does locally — only the frontend port
is forwarded — so the security posture documented in `security.md` is
unchanged, just running inside a container instead of on the analyst's
own machine.

```bash
cd backend
npm install          # already done in this environment
cp .env.example .env # then fill in ANTHROPIC_API_KEY / MXI_* vars when available

# Phase 1 CLI — no API key yet, validates everything except the actual AI calls:
npm run cli -- --file ./data/OOR_Tool_Bulletproof.xlsx --vendor-assignments ./data/Vendor_Assignments.xlsx --dry-run

# Phase 1 CLI — real run once an Anthropic key is set:
npm run cli -- --file ./data/OOR_Tool_Bulletproof.xlsx --vendor-assignments ./data/Vendor_Assignments.xlsx

# Phase 2 HTTP API (reads from the same data/audit.db the CLI just wrote to):
npm run server
# GET  http://localhost:3001/health   — no auth required
# GET  http://localhost:3001/pending-esd-updates          — needs X-Automation-Key
# POST http://localhost:3001/esd-updates/<orderNumber>/approve   {"approvedBy": "..."}  — needs X-Automation-Key
# POST http://localhost:3001/esd-updates/<orderNumber>/reject    {"approvedBy": "..."}  — needs X-Automation-Key
```

### Automation API auth (for Power Automate Desktop)

`GET /pending-esd-updates`, `POST /.../approve`, and `POST /.../reject` all
require an `X-Automation-Key` header matching `AUTOMATION_API_KEY` from
`.env` exactly, or they return `401`. If `AUTOMATION_API_KEY` isn't set on
the server at all, every gated request gets `500` rather than being let
through — a missing config value fails closed, not open. `GET /health` is
intentionally left unauthenticated for load-balancer/monitoring checks.

The real value lives only in `backend/.env` (never commit it, never paste it
into a flow definition that leaves your machine unencrypted). Generate one
locally with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Exact working curl commands** (verified for real against stage MXI and the
real audit DB on 2026-07-08 — copy these into the Power Automate Desktop
HTTP action, swapping in the real key from `.env`):

```bash
# List pending ESD updates (excludes anything already approved/rejected/written)
curl -s -H "X-Automation-Key: <AUTOMATION_API_KEY>" \
  http://localhost:3001/pending-esd-updates
# -> 200, JSON array. Verified: 65 pending rows against the real run-7 audit
# DB (589-order file), each with orderNumber/vendorName/currentMxiEsd/
# inferredEsd/classification/confidence/reasoningNote.

# Approve one (writes the inferred ESD into real MXI, one order, human-named)
curl -s -X POST -H "X-Automation-Key: <AUTOMATION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"approvedBy":"power-automate"}' \
  http://localhost:3001/esd-updates/P000ATS5/approve
# -> 200 {"orderNumber":"P000ATS5","writeStatus":"success","mxiWriteId":6}
# Verified for real: order P000ATS5's real stage MXI RO ESD was 10-JUN-2026
# before this call; the DB's inferred_esd was 2026-07-29. After this call,
# an independent `npm run mxi:read-esd -- P000ATS5` (separate code path from
# the write's own confirmation) showed 29-JUL-2026 — the write genuinely
# landed, correctly reformatted (see date-format bug note below).

# Reject one (never touches MXI, just records the decision)
curl -s -X POST -H "X-Automation-Key: <AUTOMATION_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"approvedBy":"power-automate"}' \
  http://localhost:3001/esd-updates/P000AGPC/reject
# -> 200 {"orderNumber":"P000AGPC","action":"rejected","mxiWriteId":5}

# Missing or wrong key on any of the three gated endpoints
curl -i http://localhost:3001/pending-esd-updates
# -> 401 {"error":"Unauthorized"}
```

After both calls above, `GET /pending-esd-updates` dropped from 65 to 63
rows (confirmed both via the live endpoint and a direct SQL query against
`mxi_writes`) — the exclusion logic was verified against the real DB, not
assumed from reading the query.

**Real bug found and fixed while wiring this up**: `esd_inferences.inferred_esd`
is stored ISO (`2026-07-29`), but every verified MXI write goes into a field
expecting `DD-MMM-YYYY` (`29-JUL-2026`) — confirmed throughout Phase 2c.
`/approve` was passing the raw ISO string straight through with no
conversion, which would have written a wrongly-formatted date into a real
order the first time this endpoint was ever used for a live write. Fixed in
`server.ts` with a `toMxiDateFormat()` helper (`date-fns` `format`/`parseISO`),
verified against several dates before trusting it, then verified for real
against `P000ATS5` above.

```bash
# Phase 2b/2c/Notes-addendum smoke tests against real stage MXI (need
# MXI_STAGE_USERNAME/MXI_STAGE_PASSWORD/MXI_STAGE_BASE_URL in .env —
# separate from MXI_USERNAME/MXI_PASSWORD above):
npm run mxi:read-esd -- P000AG1D                          # prints both RO ESD and Notes to Receiver
npm run mxi:write-esd -- P000AG1D 08-JUL-2026              # ESD-only (still via writeEsdAndNotes, noteText omitted)
npm run mxi:write-esd -- P000AG1D 08-JUL-2026 "Some note"  # combined — writes both, reads back to confirm both

# One-off: save an authenticated session so a codegen recording can start pre-authenticated
npm run mxi:save-storage-state
npx playwright codegen --load-storage=data/mxi-stage-storage-state.json -o discovery-recording.ts <url>
```

`--db` and `--out-dir` (CLI) default to `data/audit.db` and `data/`.
`MXI_DB_PATH` and `PORT` (server) default to `data/audit.db` and `3001`.

## Back Shop tab — the daily in-house scrap list (2026-08-27)

The analyst's daily list of parts that have no vendor and often need an
in-house scrap. Three deliberately separate steps, because the last one is
irreversible and NOT idempotent:

1. **Load the day's sheet.** `BackShopListing.xlsm`, sheet `Today`, synced
   from SharePoint via OneDrive. Confirmed real path:
   `C:\Users\<user>\American Airlines, Inc\CRA - CRA Team\BackShopListing.xlsm`
   — note the sync root is `American Airlines, Inc`, NOT the pre-existing
   `OneDrive - American Airlines, Inc` (that one holds only Favorites).
   `BACK_SHOP_LISTING_PATH` overrides discovery; an upload fallback in the
   UI covers a machine that isn't synced. Cell A1 holds the sheet's date;
   a sheet that isn't today's WARNS (never blocks, per explicit choice) and
   the warning is never suppressed — running yesterday's list would scrap
   the wrong parts.
2. **Read each part's note in MXI** (`npm run diag:backshop` to do this from
   the CLI, or the tab's own read-only discovery job). Never writes.
3. **Review and confirm**, which hands the selection to the *existing*
   Scrap tab in-house job (`POST /api/scrap/start`, `kind: "in_house"`).
   That job remains the one authority on scrapping, with its own
   already-scrapped and approved-base guards. Discovery never flows
   straight into a write.

### The note is on the PART record, not the inventory record

From one inventory search result row, clicking the **serial** opens the
physical item (`InventoryDetails.jsp`); clicking the **part number** opens
the part (`PartDetails.jsp`). The scrap wording lives on the latter, in
`#idCellPartNote` — part-NUMBER level, so every serial of a part number
shares it. `openPartDetailsBySerial` / `openInventoryBySerial`
(`mxiWriter/openInventoryBySerial.ts`) are the two openers; they share one
search implementation so they cannot drift.

This was found the hard way and is worth not re-learning: a first discovery
run read the *inventory* record's Notes/Receiver Note and found no scrap
wording on **any** of 32 real parts — those fields hold only system-generated
Merlin tags (`CCN:… USSN:… merlin position:…`). The analyst's recording
(`discovery-part-detail-scrap-recording.ts`) showed the real path.

### Three real false positives, all caught before anything ran for real

- **Every inventory details page** contains "scrap" — the action bar has a
  `Scrap Inventory` button.
- **Every part details page** contains "scrap" — the Reliability section
  states `Scrap Rate: 100%`.
- **A note can mention scrapping only to forbid it.** Part
  `GG436-2004-1MT`'s real note reads "…Repairs do not scrap. 07/27".

The first two are handled by SCOPE, not by cleverness: only `#idCellPartNote`
is ever searched. The third is handled by per-occurrence, clause-bounded
negation detection in `backShop/scrapNoteJudgement.ts` — and the window is
deliberately narrow because part `DK120`'s real note reads "…OEM DOES NOT
WANT THIS SENT IN. SCRAP IN-HOUSE.", a genuine instruction that a wider
negation check would have suppressed. Both notes are pinned as tests.

Outcomes are `scrap_recommended` / `scrap_negated` / `no_scrap_note` /
`unreadable`, and `unreadable` is deliberately its own category: a part we
could not read must never be presented as a part with nothing to say.

### Only an explicit "scrap" counts — BER/NREP/non-repairable was reverted

Recognising conclusion-words that imply a scrap without saying it (`BER`,
`NREP`, `NON-REP`, `non-repairable`) was implemented and then **reverted the
same day (2026-08-27) on the analyst's instruction** — scrapping is
permanent, and those words sit on real parts that are not to be scrapped.
Measured against the live list, the broadening moved 5 more parts into the
**pre-selected** set, including all three serials of `WE3876352-1`, whose
note is about test-only handling and pricing rather than disposition.

This is a deliberate limit, not a gap, and it is pinned by a test that
asserts those wordings stay unrecommended. Do not re-add it without the
analyst asking for it explicitly. Softer wording is a judgement for the
human reading the quoted note — the note is shown in full in the UI.

### A real race in the inventory search was found and fixed

`openInventoryBySerial` used to click Search, `pace()`, then count matching
links — so a results page that had not rendered yet became a confident
"No inventory item found for serial X". A discovery run over 32 real parts
produced that for **four serials that had opened fine five minutes earlier
in the same session**; re-searching one directly showed MXI answering
"1 inventory item was found." It now waits for MXI to actually STATE an
outcome (`mxiWriter/inventorySearchVerdict.ts` parses both real phrasings —
`"0 of 0 inventory items were found."` and `"1 inventory item was found."`),
so `not_found` can only come from the page positively saying zero. Anything
else reports as the fault it is (`search_not_rendered`, `row_not_clickable`,
`details_not_reached`). Re-running the same 32 rows afterward: 32/32 read,
0 unreadable. `writeInHouseScrap` calls the same helper, so it got the fix
too.

### Verified against real production data

`npm run diag:backshop -- --limit 32 --env production` over the whole live
list: 9 scrap-recommended, 1 correctly reclassified as "note forbids
scrapping", 22 with no scrap note, 0 unreadable. The discovery runner was
then exercised directly on a 4-row set covering all four outcomes,
including a deliberately nonexistent serial.

**Still untested live:** the tab's own UI end to end (the job, the API, and
the classification are all exercised; the React page is typechecked and
builds, but has not been clicked through), and the hand-off from a
confirmed selection into a real in-house scrap.

**Files:** `backend/src/backShop/` (listing location/parser/rows,
`scrapNoteJudgement.ts`, `readPartScrapNote.ts`),
`backend/src/api/backShop/backShopJobManager.ts`,
`backend/src/api/jobRunners/backShopDiscoveryRunner.ts`,
`backend/src/cli/backShopProbeCli.ts`, `src/pages/BackshopRepairs.tsx`,
`src/lib/backShopApi.ts`.

## Five real bugs found and fixed (2026-08-28)

All five were diagnosed from real audit data and live pages, not from
reading code. Each fix is noted at its own definition; this is the map.

### 1. The ESD writer reported every note write as a failure

`updateNoteToReceiver` was changed on 2026-08-24 (commit `752d764`, by
hand) to put the newest entry FIRST. `writeEsdAndNotes`' verification still
compared the re-read field to `${previousNote}\n\n${newEntry}` — the
opposite order — so from that date every order that already had note
history compared against a string that cannot occur.

Measured: **all 28 failed ESD writes since 2026-08-24 were this**, and each
one's own error message shows the note had been written correctly. Each
also burned ~30s on a self-heal attempt that then timed out.

No data was damaged: every one of the 28 self-heal attempts threw while
waiting for the Details tab, so none of them wrote the entry a second time.
That was luck, not design — the self-heal was one working click away from
duplicating a note on 28 real orders.

Fixed in `mxiWriter/noteVerification.ts`: verification now checks the two
things that are actually true of a correct write — the new entry is
present, and prior history survived — in any order and whatever the
whitespace. Byte-exact comparison of an accumulating log was never going to
hold. Unit-tested against the real note shapes, including both orderings.

### 2. EQD always produced "No ESD Found" — two independent causes

**a. The AI was never reached.** Run 31 had **241 of 2002 orders** fail
with `unable to verify the first certificate` — corporate SSL inspection
re-signs HTTPS with an internal root Node does not trust (browsers use the
Windows cert store; Node does not). `anthropicProvider` degraded to
`classification: 'none'`, which `applyInferenceRules` turned into
`no_esd_found` — a statement about the vendor's notes, when nothing had
been read at all.

Now: `EsdInferenceResult.providerError` carries the failure, and a new
`EsdFlag` value `inference_unavailable` reports it as its own outcome
(rendered `danger`, not `warning`). Set `NODE_EXTRA_CA_CERTS` to the
corporate root in PEM form; `security/corporateCaCert.ts` reports at
startup whether it loaded and documents how to export one.

**b. Bare month/day dates got an invented year.** Real EQD notes are
`EQD 8/26`, `EQD 9/2` — no year. The model has to supply one for ISO, and
on run 19 it supplied **2024**, so +14 days landed two years in the past
and Step 4 rejected it as stale.

`inference/bareDateYear.ts` now decides the year in code when the note
states none: the nearest occurrence of that month/day, which may be
slightly past (an EQD from last week reads as last week). Same principle
that keeps the buffer constants out of the prompt.

### 3. Editable ESD and note cells in the ESD Finder review table

Click either cell and type. Entirely optional — an untouched cell sends
nothing, a cleared cell reverts to the inferred value, blanks stay blank.
The typed value is an instruction for that write only; the stored inference
is untouched, so the audit trail keeps what the pipeline concluded next to
what the analyst decided. The server re-parses the typed date and refuses
the whole request if it cannot read one.

### 4. The vendor scrap could not finish, and stopped in the worst place

Two real failures on 2026-08-28, both leaving an order part-processed:

**a. It searched for the certificate's serial.** On `P000BESE` the
certificate said `PEL01531` while the item MXI actually received is batch
`BN 397522` — and the receipt line's own description carried a third value
(`BN 396273`). With batch-numbered parts these routinely disagree. It now
takes the inventory shown on the inventory receipt line, exactly as the
original recording did, located structurally as the one
`InventoryDetails.jsp` link inside `#idTableInventoryReceipts`. Verified
read-only against both stuck orders. More than one received line refuses
rather than guesses — scrapping is irreversible. The audit trail records
the item actually opened whenever it differs from the certificate.

**b. It could not resume.** `P000BESC`'s receive-dialog OK click hung 30s
and threw; the retry then refused because the shipment HAD been received.
The receive step is now judged by whether the item actually arrived
(Receipt & Returns), not by whether every click resolved, so re-running a
part-processed order picks up where it stopped. `clickIfPresent` also
bounded its click — it was passing the caller's timeout to the *wait* only,
leaving the click on Playwright's 30s default.

**Still not resumable:** the cancel-tasks and complete-work-package steps.
Making those safe needs a real order observed in each state; their failure
messages now say exactly where they stopped.

### 5. The zero-times-and-cycles email draft stopped appearing

The Outlook draft mechanism works — verified by creating a real draft. The
button simply never appeared: **no `zero_usage` outcome has fired since
2026-08-07**. The "Create Order Only" feature routes zero-usage lines to
`order_created_do_not_ship` instead, but only on USSTG lines — which is
effectively all of them. The MXI behaviour was intended; it silently took
the Maintenance Records notification with it.

`zeroUsageRows` now rides along on that outcome, and the button keys off
the usage rows being present rather than the exception type — so a future
third path carrying them gets the button instead of quietly losing it.

**What to do in MXI and who to tell about bad data are separate concerns.**
A redirect should only ever have changed the first.

### The line locator's "USSTG" click was hitting the Dock checkbox (2026-08-28)

Symptom: discovery finds a vendor's lines, a later pass reports **"No lines
currently found for this vendor"** — while the lines are plainly still in
MXI. Intermittent, across many vendors, for weeks.

`navigateToVendorCodeGrid` clicked
`getByRole('cell', { name: 'When selected, items at USSTG' }).nth(1)`, and
the docstring asserted that was the USSTG control — deliberately not reusing
aeroRepair's ID-based `resetOptionsFilters()` because "nothing confirms the
two are the same underlying control."

They are the same controls, and the cell click was on the wrong one. MXI
puts the identical `title` text on the adjacent DOCK checkbox's cell, so two
cells carry that accessible name and `.nth(1)` is the second. Probed live:

```
dialog opens     USSTG=true   Dock=false
Reset Filters    USSTG=true   Dock=TRUE
.nth(1) click    USSTG=true   Dock=FALSE   <- only Dock moved
```

The step meant to guarantee "show USSTG items" never touched USSTG. It is a
blind TOGGLE, so its effect depends on the session state it starts from —
and that state persists per session. A run starting with USSTG off searched
with USSTG off, found nothing, and blamed the vendor.

Now uses the same idempotent `resetOptionsFilters()` (`.check()` /
`.uncheck()` by element id) that aeroRepair has always used — same end
state, asserted rather than toggled into, and identical between discovery
and execute. Verified live: with USSTG deliberately turned OFF first, the
locator recovers all 6 of 0T1Y4's lines and leaves the box checked.

**Lesson worth keeping: an accessible name is not an identity.** Two
different controls shared one title string, and a `.nth(i)` index over that
name silently addressed the wrong one for weeks. Prefer the element id when
one exists; when using a name, verify how many things carry it.

Three supporting changes, from the analyst's requirement that finding lines
succeed 100% of the time even when nothing can be done with the lines:

- **Silent-drop guard.** If the grid shows real inventory rows but no
  candidate could be read from any of them, that now throws with the row
  text and a captured grid, instead of reporting an empty vendor. "The grid
  was empty" and "we could not read the grid" are different facts.
- **The empty-state text is only believed when the grid also has zero rows.**
  It was a bare substring test over the whole body.
- **`MAX_ATTEMPTS` restored from 1 to 3.** It had been set to 1, leaving the
  retry loop and its backoff as dead code. A genuine empty is now captured
  to `data/diagnostics/` before being reported.

### "Timeout waiting for getByRole('link', ...)" — the whole class (2026-08-28)

Reported as "the writer is having a hard time identifying the buttons, even
though they are present on the screen." Measured across the real
`write_up_actions` error history, the top locator failures were all the same
shape — a bare `page.getByRole('link', { name: X }).click()`:

```
7x  Timeout 30000ms  waiting for getByRole('link', { name: 'Unassigned' })
6x  strict mode violation: 'L00158' resolved to 2 elements
5x  Timeout 30000ms  waiting for getByRole('link', { name: 'SE75558' })
4x  Timeout 30000ms  waiting for getByRole('link', { name: 'Request Authorization' })
```

Three separate defects behind them, now fixed:

**1. Absence was being treated as a fault.** An order that is ALREADY
authorized shows no "Request Authorization" action at all — real behaviour
the analyst confirmed on 2026-08-21 and which `mxiWriter/priceLineSelectors.ts`
has handled ever since ("that run should count as a success"). The write-up
path never did: it waited the full 30s for a correctly-absent control, then
failed a line that was fine. `clickRequestAuthorization` now returns
`requested | already_authorized`, reading the order's real Authorization
Status to decide, and every caller skips the Auth Flow / confirm steps on
the already-authorized path — otherwise the timeout just moves one step
along.

**2. Ambiguity was fatal.** MXI shows the same order number twice on one
page, so a perfectly correct link name threw a strict-mode violation.
`clickActionLink` resolves duplicates, preferring an EXACT text match over
DOM order — which matters because `'Unassigned'` is a substring that also
matches the `'Unassigned Tasks'` tab beside it, and blind `.first()` there
would click the wrong tab.

**3. The error named only what it wanted.** "Waiting for X" with no mention
of what WAS on the page is precisely why this reads as "the button is right
there and it can't see it". Failures now list the links actually present and
call out near matches — "Authorization" being present while "Request
Authorization" is not IS the already-authorized explanation.

Applied at the three sites those errors came from: `authFlow.ts`,
`unassignedTasks.ts`, `scheduleWorkPackageForm.ts`'s `openGeneratedOrder`.
`describeMissingLink` is pure and unit-tested against a real captured
order-page action bar.

`MAX_ATTEMPTS` for the vendor-grid search was also set to 2 (from 3) —
3 was too slow in practice.

### Quote writer: two fixes (2026-08-28)

**1. A real quote was excluded for being "already completed work".**

`P000BE8G` — email subject `[EXTERNAL] QUOTE P000BE8G`, attachment
`QUOTE P000BE8G.pdf` — was classified `other_not_a_quote` because the model
reasoned it was "an invoice for work already performed... not a prospective
quotation but a billing document for completed repair work."

That reasoning came straight from the prompt, which listed "invoices for
already-completed work" as a `other_not_a_quote` example. Per the analyst:
**vendors routinely send priced paperwork after the part has been repaired
and even after it has been shipped back**, and those still have to be
reviewed and priced into the order. The prompt now says to decide by
CONTENT, not by TENSE — a document carrying a repair price for a PSA order
is a quote however it is titled, and "Work Order Invoice", past-tense
wording and already-totalled amounts explicitly do not disqualify it.

Deliberately unchanged: a document with no repair price at all is still not
a quote. The Honeywell Service Bulletin correctly excluded on 2026-08-26
stays excluded.

**2. A failed extraction was being recorded as a claim about the document.**

`failureResult()` returned `documentKind: 'other_not_a_quote'`, and
`quoteIngestRunner` turns any non-quote into `excluded_other` — dropping the
row from the write set. So when the API call failed, the row was excluded as
"not a quote" although nothing had been read. Five real PDFs went that way
on 2026-08-26 after the TLS certificate error, including files named
`Work Order Quote #WQP1147030`.

New `QuoteDocumentKind` value `extraction_failed`, which is not a kind of
document — it means the document was never read. It stays `pending` rather
than excluded, carries a review reason saying so first, renders in the UI as
"Could not be read — not assessed", and the write runner skips it with the
same wording. It still cannot be written (no order number, no price), so the
change is visibility, not permission. Same silent-degradation class as the
ESD side's `inference_unavailable`, fixed the same way.

**3. Two locator timeouts on the same order (`P000BEJY`).**

- `locator.fill: Timeout ... waiting for getByRole('textbox', { name:
  'Password:' })`. `performReauthorization` filled the password
  UNCONDITIONALLY. The prompt is intermittent — already known, already
  handled everywhere else by `enterPasswordIfPrompted`, which the scrap
  flow has used from the start. This path simply never adopted it.
- `locator.click: Timeout ... waiting for getByRole('link', { name:
  'Edit Lines' })`. `findOrderByNumber` now confirms a selectable order
  line exists before checking it (an absent line is the likelier real
  cause, and "Edit Lines" is unusable without one) and clicks through
  `clickActionLink`, so a failure names what was on the page.
