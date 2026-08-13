# Handoff: Open Order ESD Finder build + Aero Repair "Unassigned Task Present"

Written to resume in a fresh session without re-deriving this session's work. Read this first, before touching any of the files below — then independently re-verify anything you're about to rely on (see "Before you touch anything" at the bottom). Two unrelated pieces of work happened in this session, in this order: (A) a small aeroRepair addition, (B) the full Open Order ESD Finder tab, built and proven end to end across 5 stages.

---

## Read this before anything else: repo state

1. **Nothing in this repo is committed.** `git log --oneline` shows exactly 4 old commits (`Initial UI shell...`, `Implement isSessionAlive()...`, `auto ESDs and write ups for aero repair`, `added .env.example.txt`). Everything described below — this session's work AND a large amount of pre-existing backend/frontend code — is uncommitted (`M` or `??` in `git status`). Do not assume "committed" means "safe" here; it doesn't apply.
2. **Another session is actively working on this same repo in parallel, right now or very recently.** `git status` shows real, modified/untracked files this session never touched: `backend/src/writeUps/aeroRepair/unassignedTaskAssignment.ts`, `backend/src/writeUps/shared/createOrderOnly.ts`, `removalTaskInfo.ts`, `usageTableDiagnostics.ts`, `vendorCodeGridDiagnostics.ts`, `VENDOR_MODULE_REFACTOR_SPEC.md`, plus modifications to `eslint.config.js`, `src/lib/theme.tsx`, `src/main.tsx`, `src/components/ui.tsx`, `src/lib/sidebar.tsx`, and several `writeUps/aeroRepair`/`writeUps/shared` files. **`unassignedTaskAssignment.ts` in particular looks like it could be the auto-assign follow-up to Part A below** (deliberately deferred, not built by this session) — check its contents directly before assuming anything about it.
3. Given (2), **treat every file path/content claim in this document as "true as of this session's end" — re-read the actual file before relying on it**, exactly the same discipline this whole project already runs on for its own MXI-state claims.

---

## Part A: Aero Repair — "Unassigned Task Present" detection (small, self-contained)

**What it does:** the write-up flow's existing detour through the "Unassigned Tasks" sub-tab was previously a pure navigational pass-through (no content ever read). Added a real check there: if the sub-tab shows anything other than its confirmed-exact empty-state text, that's a genuine unassigned task blocking write-up — skip with a new `unassigned_task_present` exception, log to the xlsx `Exceptions` sheet with the real task detail, don't touch anything else.

**Files touched:**
- `backend/src/writeUps/aeroRepair/constants.ts` — added `NO_UNASSIGNED_TASKS_TEXT`
- `backend/src/writeUps/aeroRepair/selectors.ts` — added `readUnassignedTasksAreaText`
- `backend/src/writeUps/aeroRepair/noTaskException.ts` — added `isUnassignedTaskPresent`
- `backend/src/writeUps/aeroRepair/writeUp.ts` — wired the check in between `navigateToUnassignedTasksView`/`closeUnassignedTasksView`, new `unassigned_task_present` outcome on `AeroRepairWriteUpOutcome`
- `backend/src/writeUps/aeroRepair/processLine.ts` — handles the new outcome, real `write_up_actions` row, xlsx logging
- `backend/src/writeUps/aeroRepair/discoveryLog.ts` — new `'Unassigned Task Present'` issueType
- `backend/src/db/db.ts` — widened `write_up_actions.outcome` type
- `backend/src/aeroRepairWriteUpCli.ts` — new case in its outcome switch (kept exhaustive)
- `backend/PHASE2_MXI_WRITER_SPEC.md` — full addendum documenting this (search for "Unassigned Task Present")

**Tested:** read-only, against the real named example (`JUN10-1572`, found under `5013642-1` not the guessed part number). Result: it currently shows the empty state, not a real task — the named example's state had moved on since observed (shared production system). Ruled out a hidden day-range filter as the explanation (found and inspected `idDayCount`, already defaulted to 9999). Scanned ~10 more current real lines, no live positive case found this session. **The detection logic is proven correct on every negative case tested, including a same-run cross-check showing it's independent of the existing Assigned-Tasks-tab check** — but a genuine positive case (a real unassigned task actually present) was never observed live. If you get a report of one, that's the first real chance to confirm the positive branch.

**Non-goal honored:** no auto-assignment built — `unassignedTaskAssignment.ts` in the parallel session's changes may be exactly that follow-up; check it before assuming it's unrelated.

---

## Part B: Open Order ESD Finder — full build, all 5 stages complete and proven

### What it is

A new top-level tab (`/esd-finder`) that replaces the manual Excel-paste step of the existing ESD matcher with drag-and-drop: drop Vendor OOR file(s) + one CRA OOR file → review matched/inferred rows (actionable vs. non-actionable) → remove unwanted rows → write the survivors to MXI. Full original spec was a pasted document (not saved to the repo) — the build order it specified was followed exactly, one stage at a time, each proven with real data before moving to the next:

1. File ingestion + header-based parser + duplicate detection
2. Compare endpoint + job model, wired to the *existing* inference pipeline
3. Upload/review UI (State A/B)
4. Write endpoint + write UI (State C), stage-first
5. Production enablement

**Explicit, load-bearing rule throughout:** reuse the existing matching/inference/MXI-write pipeline (`parseVendorOor`, `parseCraOor`, `matchOrders`, `applyInferenceRules`, `AnthropicEsdProvider`, `writeEsdAndNotes`, `exportExcel`) — none of it was reimplemented. Everything new is ingestion, job/endpoint wiring, and duplicate detection.

### File map

**Backend — new:**
- `backend/src/api/esdFinder/ingestion.ts` — header validation (rejects a file naming the exact missing header(s), never silently produces 0 rows or nulled fields), multi-file vendor concatenation with source-file tracking, duplicate-order-number detection (`detectDuplicateOrderNumbers`), and `peekEsdFinderFile` (single-file row-count preview for State A).
- `backend/src/api/esdFinder/esdFinderJobManager.ts` — in-memory job registry for this tab. `startEsdCompareJob` and `startEsdWriteJob` share ONE `activeRunId` concurrency slot (compare and write are two phases of the same tab and shouldn't run concurrently) — this is a **separate** slot from `jobManager.ts`'s own `activeRunId` used by Order Write-Ups (those two tabs are independent).
- `backend/src/api/jobRunners/esdCompareRunner.ts` — spawned child process. Calls `ingestEsdFinderFiles` → `matchOrders` → `applyInferenceRules` (real Anthropic calls) → `exportExcel`, inserts into the real `runs`/`esd_inferences` tables, emits one final JSON envelope with the full result. Adds three **display-only** fields per row not present on the shared `InferenceRecord` type: `actionable` (`flag === 'ok'`), `notesToReceiverPreview` (via the existing `assembleNoteText`), and `partNumber`/`serialNumber` (zipped in by array index from `matched[i]` ↔ `records[i]` — see gotcha #3 below).
- `backend/src/api/jobRunners/esdWriteRunner.ts` — spawned child process for the actual MXI write. **Creates its own `MxiClient` via `createReadyMxiClient(env)`, using the `env` this specific job was started with — never touches `server.ts`'s shared, server-lifetime `mxiClient`.** See gotcha #1, this is the single most important design point in the whole build.

**Backend — modified:**
- `backend/src/server.ts` — added `multer`, and: `POST /api/esd/peek`, `POST /api/esd/compare`, `GET /api/esd/active-job`, `GET /api/esd/runs/:runId` (handles both compare and write job kinds), `POST /api/esd/write`.
- `backend/src/api/jobManager.ts` — `spawnRunner` changed from private to `export` (one-line change, zero behavior change) so the ESD Finder job manager could reuse it instead of duplicating its Windows-shell-quoting-avoidance and secret-handling logic.
- `backend/package.json` / `package-lock.json` — added `multer`, `@types/multer`.

**Frontend — new:**
- `src/pages/EsdFinder.tsx` — the whole tab: State A (drop zones with live per-file peek/validation), State B (actionable/non-actionable toggle, duplicate banner, Output-file link), State C (environment bar, Run Updates, live per-row write status, Retry-failed).
- `src/lib/esdFinderApi.ts` — API client. Has its own multipart `uploadRequest` helper distinct from `lib/api.ts`'s JSON-only `request` (mixing the two would silently send the wrong Content-Type).
- `src/components/EnvironmentBar.tsx` — extracted from `OrderWriteUps.tsx`'s already-proven inline version (same stage-default, production-needs-confirmation-modal design) so it could be reused **without touching `OrderWriteUps.tsx` at all** — zero regression risk to that already-working tab.

**Frontend — modified:**
- `src/App.tsx` — added `/esd-finder` route.
- `src/lib/nav.ts` — added the nav entry under "Orders & Repairs".

### The 4 real gotchas worth knowing before touching this code

1. **The shared-`mxiClient` trap (the most important one).** `server.ts`'s existing `/esd-updates/:orderNumber/approve` endpoint uses ONE `MxiClient` created at server boot from `.env`'s `MXI_ENV` — there's no per-request environment selection there. At the time of writing, the server boots with `MXI_ENV=production`. If `esdWriteRunner.ts` had reused that shared client, the ESD Finder's environment selector would have been **cosmetic** — it would always write to whatever the server happened to boot with, regardless of what the UI showed. Instead, `createReadyMxiClient(env)` (already-existing, already-proven-correct utility from the aeroRepair work) is called fresh per write job, with the job's own explicit `env`. **This was proven, not just built** — see "What's proven" below.

2. **`writeEsdAndNotes` is not idempotent — retry-safety needs a real DB check, not just UI bookkeeping.** Notes to Receiver is an accumulating log; re-submitting an already-successful write would duplicate the note entry and reissue the order again for nothing. `esdWriteRunner.ts` checks `mxi_writes` for an existing `write_status='success'` row tied to the same `esd_inference_id` before ever attempting a write, and reports `skipped` if found — this makes "retry only touches genuinely-failed orders" a structural guarantee, independent of whatever the frontend's retry button happens to request.

3. **`partNumber`/`serialNumber` on the display row are zipped in by array index**, since `InferenceRecord` itself doesn't carry them and `applyInferenceRules.ts`'s `BaseFields` never needed to. This relies on `applyInferenceRules()` processing `matchedOrders` in one unfiltered `for` loop and pushing exactly one record per order in the same order (confirmed true by reading the function). **If that function's internals ever change to filter or reorder, this zip breaks silently** — worth a defensive re-check if `applyInferenceRules.ts` is ever touched.

4. **The existing parsers silently produce wrong-looking-fine data on a missing header — in two different ways, not one.** If the missing header is `Order Number` itself, every row is silently dropped (0 rows — looks like an empty file). If it's any *other* required header, the row **survives** with that field silently `null` (looks like a complete, normal row missing nothing). `ingestion.ts`'s header validation runs before either parser can be reached, catching both — this was directly demonstrated, not just reasoned about (see "What's proven").

### API surface

```
POST /api/esd/peek        multipart: file, role ('vendor'|'cra')  →  { fileName, rowCount }  |  400 with a named-header error
POST /api/esd/compare      multipart: vendorFiles[] (1+), craFile (1)  →  202 { runId }  |  400  |  409 (job already active)
GET  /api/esd/active-job                                          →  { activeRunId }
GET  /api/esd/runs/:runId                                         →  { runId, kind, status, phase, startedAt, completedAt,
                                                                        fatalError, result, writeEnv, writeResults }
POST /api/esd/write        json: { runId, orderNumbers[], env }    →  202 { runId, env }  |  400 (any order not actionable/
                                                                        non-duplicate under that run — rejects the WHOLE
                                                                        request)  |  409
```
All gated by the existing `X-Automation-Key` header, same as every other endpoint on this server.

### What's proven (real evidence, this session)

- **Step 1 (ingestion):** real split-file test against the actual `OOR Matcher.xlsb.xlsx` — 473 correctly-concatenated rows, 2 deliberately-planted real duplicate order numbers correctly caught with correct file attribution, a deliberately-broken file correctly rejected naming the exact 2 missing headers. Both real missing-header failure modes (gotcha #4) directly demonstrated via a raw-parser-vs-guarded-wrapper contrast test.
- **Step 2 (compare):** ran for real against the real, unmodified Vendor OOR + CRA OOR data (`run_id=19`, 690 records). Diffed every one of 158 `explicit_date` rows against the pre-existing Output sheet — all fully explained (31 exact matches, 98 correctly-nulled by the time-sensitive Step 4 sanity check, 26 orphaned-vendor rows never expected in the Output sheet's own filter, 3 a genuine "AI recognized delivery-commitment language but honestly couldn't extract a calendar date" edge case). Zero unexplained mismatches.
- **Step 3 (UI):** live-driven with Playwright against the real running app — file upload/peek, real comparison, real actionable/non-actionable rendering (had to specifically hunt for real still-future-ESD rows to get a non-empty actionable table, per the staleness effect below), live X-remove interaction, found-and-fixed one real display bug (`mxiEsdRaw` showing a raw ISO timestamp — traced to the shared, pre-existing `cleanCell()`, fixed as a display-only frontend formatting trim, not a pipeline change).
- **Step 4 (write, stage):** real UI-driven write with Stage selected. **Independently verified via a completely separate read path** (`npm run mxi:read-esd`, shares no code with the write's own verification): stage gained the new note entry, production was **provably unchanged**. Duplicate-order case exercised for real (planted a real duplicate across two files) — UI showed the Duplicate badge with no write control, AND a direct API call bypassing the UI trying to write the duplicate order got a structural 400 rejection. Retry-safety exercised for real: first write succeeded, immediate retry of the same order was skipped (not re-attempted), confirmed by an independent MXI read showing exactly 2 real note entries (from 2 genuine successes across two test runs), not 3.
- **Step 5 (write, production):** same test in the *opposite* direction — real UI-driven write with Production selected (clicked through the real confirmation modal). Independently verified: production gained the new note entry, **stage was provably unchanged**. This completes the bidirectional proof that the environment selector is real, not cosmetic.

### What's NOT tested / open items

- **The "Write failed — needs retry" UI state was never exercised against a genuine live failure.** Every real write attempted in testing succeeded. The rendering (amber/red, technical-details toggle, plain-English summary) is built and should be correct by inspection, but hasn't been seen live. Given roughly half of production order numbers are known not to exist in stage (documented extensively elsewhere in this project), a real "not found" failure is very plausible to hit naturally on a normal stage run — worth confirming the first time it happens rather than assuming the UI renders it right.
- **No full-batch write has been run** — every write test this session was deliberately scoped to exactly one order. The first real multi-order batch write (through the UI, not a script) hasn't happened yet.
- **`approvedBy` on every ESD Finder write is hardcoded to `'esd-finder-ui'`** — there's no analyst-identity capture in this UI (Order Write-Ups doesn't have this either, for context). Fine for now, worth flagging if attribution ever matters.
- **The compare/write job registry is in-memory only** — a server restart between a compare and its write loses the job (same limitation Order Write-Ups already has and accepts, "acceptable for v1, localhost, single analyst").

### Real MXI side effects from this session's testing (for your own awareness — real data was touched)

Two real orders had real Notes-to-Receiver entries added during testing, all dated `8.10.26` (the session's "today"):
- **`P000ANMH`** — stage: gained 2 new entries (2 separate real successful test writes across two different test runs); a 3rd attempt was correctly skipped, not written. Production: untouched, still exactly what it was before this session.
- **`P000AUBE`** — production: gained 1 new entry (Step 5's real production test write). Stage: untouched.
- **`P000AGPC`** — used only in the duplicate-exclusion test; never actually written in either environment.

No ESD *values* changed on any of these (the underlying RO ESD field was already at the value the tool would have written — these were all real, genuine writes, just to already-correct data). Also: 9 `data/esd-finder-output-*.xlsx` files accumulated in `backend/data/` from test runs (gitignored, harmless, not cleaned up — fine to delete anytime). Several new `runs`/`esd_inferences` rows exist in the real audit DB from test compares (append-only by design, not a problem, just larger history than before).

---

## Before you touch anything

1. `cd backend && npm run typecheck` and `cd .. && npm run build` — confirm the state this handoff describes still typechecks/builds (a parallel session may have changed something since).
2. `git status` — re-check what's changed since this was written; don't trust the file list above as current without checking.
3. If continuing the ESD Finder work: pick up specifically at "What's NOT tested" above — a real failure-case UI check and a real multi-order batch write are the two most concrete next steps.
4. If touching `applyInferenceRules.ts` for any reason: re-verify gotcha #3 above (the index-zip) still holds.
