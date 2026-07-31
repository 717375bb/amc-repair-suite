# Phase 2: MXI Writer

> Saved after implementation, per the same convention Phase 1's spec should
> have followed from the start. This file is the spec as given, with an
> **Implementation status** addendum at the bottom documenting what was
> actually built, what was verified, the judgment calls made where the spec
> left a gap, and what's still open for the next session.

## Context

Phase 1 (done, unchanged by this spec) proved the ESD inference logic works. It deliberately stopped short of writing anything back to MXI. That was the right scope for Phase 1's narrow purpose — but it is not the finish line for the ESD workflow as a whole. The actual point of this workflow is that an approved ESD gets written into MXI on the CRA's behalf. That's what this phase builds.

Principle carried over from the project plan, non-negotiable: the writer never runs automatically. It only executes when explicitly approved, one order at a time. No code path should exist that goes from "inference computed" straight to "MXI updated" without a human approval action in between.

## Objective

Add an HTTP layer and a Playwright-based MXI writer so that:

- Pending ESD updates (computed by the existing Phase 1 pipeline) can be listed via an API.
- A human can approve or reject each one individually via that API — this is what a Power Automate/Teams approval card will call, since a custom UI isn't justified for a decision this simple yet.
- Approving one triggers a real write into MXI's RO ESD field for that order, via Playwright driving the browser UI with your own valid MXI login.
- Every write attempt — success, failure, or rejection — is recorded in an append-only audit table, same pattern as `esd_inferences`.
- Writes default to MXI's stage/sandbox environment; hitting production requires an explicit, hard-to-do-by-accident override.

Explicit non-goals, still:

- No email/Graph API integration
- No custom UI — the approval surface is external (Power Automate), calling into the API this phase builds
- No multi-user auth
- No other workflows besides ESD
- No automatic/unattended writing under any circumstance

## First task, before writing new code: verify the orphan-rate hypothesis

Phase 1's dry run against the real files found 387 CRA-only orphaned rows out of 563 CRA OOR rows. Likely explanation: Vendor OOR is only the current week's returned replies from a subset of 120+ vendors, while CRA OOR is every open order regardless of vendor response — so a large CRA-only orphan rate is expected, not a bug. Confirm cheaply before assuming this: count unique vendors present in Vendor OOR vs. CRA OOR, and check whether CRA-only orphaned rows correlate with vendors that are absent from Vendor OOR entirely (rather than present-but-unmatched, which would suggest an Order Number formatting issue instead). Print this as a short diagnostic in the CLI output. If it confirms the hypothesis, no further action needed. If a meaningful chunk of orphans are from vendors who are present elsewhere in Vendor OOR, stop and flag it — that would mean an Order Number normalization bug is silently dropping orders from inference.

## Architecture additions

### 1. HTTP server (`backend/src/server.ts`)

Use Express. New endpoints:

- `GET /pending-esd-updates` — the most recent run's `esd_inferences` rows where `flag = 'ok'` and no corresponding row yet exists in the new `mxi_writes` table (i.e., not yet approved, rejected, or written). Returns order number, current MXI ESD, inferred ESD, classification, confidence, reasoning note — enough for a Teams card to display.
- `POST /esd-updates/:orderNumber/approve` — body may include an optional `approvedBy` (defaults to an env-configured value if omitted, since there's no real auth yet). Triggers the writer for that order's latest inferred ESD, then inserts one row into `mxi_writes` reflecting the outcome, regardless of success or failure.
- `POST /esd-updates/:orderNumber/reject` — same shape, but records `action: 'rejected'` and never calls the writer.
- `GET /health` — trivial healthcheck; useful once Power Automate is calling this over the network.

### 2. MXI writer module (`backend/src/mxiWriter/`)

- `config.ts` — `MXI_ENV` env var, defaults to `stage`. Reading production requires the env var to be set to the literal string `production` explicitly (no silent default, no shorthand). Base URLs configured per environment. On server startup, if `MXI_ENV=production`, log a loud, unmissable warning banner — this should never be the environment someone is in by accident.
- `mxiClient.ts` — manages a single persistent authenticated Playwright browser context for the server's lifetime. Logs in using `MXI_USERNAME` / `MXI_PASSWORD` from env vars on startup (single-user only, matches where testing actually is right now — this is not a long-term credential story, just what's appropriate for solo testing). Detects session timeout/logout and re-authenticates once; if that fails, halt all further approval processing and surface a clear error rather than continuing to process the approval queue — this matches the earlier agreed rule that login/session loss is categorically different from a per-order data problem.
- `selectors.ts` — placeholder only. I don't have visibility into PSA's actual Maintenix DOM, so this file should scaffold clear function signatures (`findOrderByNumber`, `updateEsdField`, `submitChanges`) with `// TODO: fill in once we can inspect the stage environment together` and a `throw new Error('Selectors not yet implemented')` body each. Do not fabricate plausible-looking selectors — that produces code that looks done but silently fails against the real system. This is genuinely a "next session, together, looking at stage MXI" task.
- `writeEsd.ts` — orchestrates: navigate to the order via `selectors.ts`, update the field, submit, confirm the change took (re-read the field if possible), return a structured result (`success | failed`, error detail if failed).

Default to headed (visible browser) mode for now, per earlier preference — add a `--headless` flag later once this is trusted, not before.

### 3. New DB table (append to `schema.sql`, `db.ts`)

```sql
CREATE TABLE mxi_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  esd_inference_id INTEGER NOT NULL REFERENCES esd_inferences(id),
  order_number TEXT NOT NULL,
  target_env TEXT NOT NULL,        -- 'stage' | 'production'
  action TEXT NOT NULL,             -- 'approved_write' | 'rejected'
  inferred_esd TEXT,
  write_status TEXT NOT NULL,       -- 'success' | 'failed' | 'skipped'
  error_message TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL
);
```

Never update or delete rows here — same append-only pattern as `esd_inferences`, for the same reason: this is the audit trail if anyone ever needs to answer "why did this date change."

### 4. `.env.example` additions

```
ANTHROPIC_API_KEY=
MXI_ENV=stage
MXI_USERNAME=
MXI_PASSWORD=
MXI_STAGE_BASE_URL=
MXI_PROD_BASE_URL=
DEFAULT_APPROVED_BY=
```

## Safety rules to enforce in code, not just in this document

- The only way `writeEsd.ts` gets called is from the `/approve` endpoint handler. Grep for any other call site as a self-check before calling this done.
- `MXI_ENV` defaults to `stage`. Nothing should default to production.
- A failed login/session halts the run rather than continuing to the next approval.
- Every approve or reject call produces exactly one `mxi_writes` row, success or failure alike — nothing fails silently.

## Deliverables checklist

- [ ] Orphan-rate diagnostic run and hypothesis confirmed or refuted
- [ ] `GET /pending-esd-updates` returns sensible data against the real DB from a Phase 1 run
- [ ] `POST /esd-updates/:orderNumber/reject` works end-to-end against a real pending record, with a `mxi_writes` row to show for it
- [ ] `POST /esd-updates/:orderNumber/approve` runs the full path up through `selectors.ts`'s `throw new Error(...)`, confirming the wiring is correct even though the actual MXI interaction isn't implemented yet
- [ ] Server refuses to start against `MXI_ENV=production` without the explicit literal value, and prints the warning banner when it is set
- [ ] `mxi_writes` table is append-only in practice — re-approving or re-rejecting the same order creates a new row, doesn't overwrite

## What happens next, not in this build

Once `selectors.ts` is filled in together against the real stage environment, and a handful of approved writes have landed correctly there, the remaining step is wiring Power Automate to call `/pending-esd-updates` and post a Teams approval card per item, then call `/approve` or `/reject` based on the response. That's a Power Automate flow, not code — worth scoping as its own short task once the API side is solid.

---

## Implementation status (as of this build)

### Orphan-rate diagnostic — done, hypothesis confirmed, but the naive version was wrong first

Built `src/matching/orphanDiagnostics.ts`, wired into `cli.ts` so it prints on every run. First pass tested "does the orphaned CRA row's vendor appear anywhere in Vendor OOR" — against the real file, this came back **72 of 387 orphans from vendors present elsewhere**, which looked like the hypothesis was refuted. Investigating manually (comparing Part Number + Serial Number between the "suspicious" CRA orphan and its nearest Vendor OOR order number) showed these were consistently *different physical parts* — just vendors who have more open orders than they replied to this cycle (e.g. AERO REPAIR - INDY: 55 rows in Vendor OOR vs. 94 total open orders in CRA OOR).

Vendor-name overlap alone isn't a meaningful bug signal in this dataset — it's expected any time a vendor doesn't reply to 100% of their open orders. The diagnostic was rewritten to check the thing that actually matters: whether an orphaned CRA row shares an exact Part Number + Serial Number with a Vendor OOR row filed under a *different* Order Number for the same vendor (which can only mean the same physical part got recorded twice). Real result: **0 likely duplicates**. Hypothesis confirmed — the 387 CRA-only orphans reflect reporting coverage, not an Order Number normalization bug.

### HTTP server — done, all 4 endpoints implemented and tested against the real Phase 1 DB

`GET /health`, `GET /pending-esd-updates`, `POST /esd-updates/:orderNumber/approve`, `POST /esd-updates/:orderNumber/reject` — all in `src/server.ts`. One deliberate deviation from a literal reading of the spec, worth flagging: **the action endpoints do NOT block re-approval of an already-actioned order.** `getActionableEsdInference` looks up the latest run's `flag='ok'` row for an order number regardless of whether it already has an `mxi_writes` row — only the `/pending-esd-updates` *list* filters those out. This is what makes "re-approving the same order creates a new row" (an explicit deliverable) possible at all; the alternative (block re-action) would make that checklist item untestable by definition. Retrying a failed write is also a reasonable thing to want in practice.

HTTP status codes chosen (not specified in the spec): `200` on success/reject, `404` if no actionable record exists for that order number, `502` if the write attempt itself failed (the audit row is still recorded either way — the caller sees a clear failure, nothing is swallowed).

### MXI writer module — done, with one extension beyond the literal spec

`config.ts`, `mxiClient.ts`, `selectors.ts`, `writeEsd.ts` all built as specified. **One addition beyond what the spec listed**: `selectors.ts` scaffolds a fourth function, `login(page, username, password)`, alongside the three named in the spec (`findOrderByNumber`, `updateEsdField`, `submitChanges`) — also a stub, also throwing rather than guessing. Reasoning: the spec's own principle ("I don't have visibility into PSA's actual Maintenix DOM... do not fabricate plausible-looking selectors") applies just as much to the login page as to the order-lookup/field-update screens — MXI's login could be a plain form or could go through SSO/Okta/SAML, and guessing would violate the stated principle. `mxiClient.ts`'s `initialize()` and re-auth logic call this stub; the control flow around it (single persistent context, retry-once-then-halt, terminal failed state) is fully implemented and real.

`mxiClient.ts` also makes one operational judgment call not specified: **a failed login at server startup does not crash the server.** It logs the failure loudly and puts the client in a `failed` state; `GET /health`, `GET /pending-esd-updates`, and `POST /reject` all still work (none of them touch MXI), while any `POST /approve` fails immediately with a clear "MXI session not established: ..." error, still recorded as an audit row. This seemed like the more useful behavior than an all-or-nothing crash, and is exactly what let this get tested end-to-end in this environment (see below).

### Testing performed — real, not simulated, with one honest gap

No real MXI stage credentials or URL exist in this environment. What was actually run:

1. **Production guard**: `MXI_ENV=Production` (wrong case) → server refuses to start, throws immediately. `MXI_ENV=production` (correct) → server starts, prints the warning banner.
2. **Full server run against the real Phase 1 audit DB** (589-order file, 65 pending `flag='ok'` orders): `GET /health` → `{status: "ok"}`. `GET /pending-esd-updates` → real order numbers, dates, classifications. `POST /reject` on a real pending order → `mxi_writes` row inserted (`action: rejected, write_status: skipped`), confirmed via direct SQL query.
3. **`POST /approve` — two depths tested.** First, with MXI left unconfigured (the realistic current state): fails at the "not configured" check, 502, audit row recorded. Second — to get a stronger signal — restarted the server with a real-but-placeholder `MXI_STAGE_BASE_URL=https://example.com` and fake credentials. This made Playwright genuinely launch Chromium, navigate to a real URL, and call the `login()` stub, which threw exactly as designed. The error surfaced through `writeEsd`'s catch block into the `mxi_writes` row precisely: `"MXI session not established: MXI login selectors not yet implemented"`. This is the deepest point reachable without real MXI access — the spec's checklist item asks for `selectors.ts`'s throw specifically (`findOrderByNumber` etc.), which sits one level deeper, past a successful login. **That specific deeper level has never been exercised and can't be until we're looking at real stage MXI together.** What's been proven is that the exact same mechanism (browser → navigate → stub throw → caught → audited) works end-to-end; only the specific stub that fires differs (`login` vs. `findOrderByNumber`).
4. **Append-only / re-approve**: called `/approve` twice on the same order number. Confirmed via direct SQL query on `mxi_writes` that this produced two distinct rows (different `id`s, different `approved_by`), not an update.
5. **Grep self-check**: `writeEsd(` appears in exactly one call site (`server.ts`'s `/approve` handler) plus its own definition. No other importer.

Chromium was installed via `npx playwright install chromium` during this session (background download, succeeded) — needed for test 3 above.

### Open items for next session (as of the original build)

- **Fill in `selectors.ts` (all four functions, including `login`) against real stage MXI.** This is explicitly a "look at it together" task — nothing here should be guessed.
- Once `login` is real, revisit `mxiClient.isSessionAlive()` — it's currently a placeholder that just trusts the last successful login state; needs a real signal for "this page looks logged out" once we know what that looks like in MXI.
- Once a handful of real approved writes land correctly on stage, wire up Power Automate → Teams approval card → this API, per "what happens next" above.
- `writeEsd.ts`'s post-submit confirmation ("re-read the field to confirm the write took") is a `// TODO` — depends on `selectors.ts` being real first.

---

## Addendum: read-path selectors implemented (from a real codegen recording)

`login`, `findOrderByNumber`, and a new `readEsdField` in `selectors.ts` are no longer stubs — they were implemented from a real `npx playwright codegen` recording against stage MXI and verified end-to-end. `updateEsdField` / `submitChanges` are still unimplemented (deliberately — this stayed read-only).

### What actually happened

**The discovery recording (`backend/discovery-recording.ts`) had a real, live credential in it.** The user believed they'd manually stripped credential values before handing it over; they hadn't — a real username and password were plainly present in the file. This was flagged immediately, the values were never copied anywhere (the implementation and the smoke test both read credentials from `MXI_STAGE_USERNAME`/`MXI_STAGE_PASSWORD` env vars, never from the recording file), and the user was advised to rotate that password. The recording file was deleted once the read path was confirmed working (see below), after confirming via `git status` / `git log --all -- backend/discovery-recording.ts` that it was never staged or committed.

**Separately, a real (unrelated) bug was found and fixed in `backend/.gitignore`.** Whatever added the `.env` and `discovery-recording.ts` entries in a prior turn wrapped them in literal quote characters (`".env"` instead of `.env`), so git was matching a file literally named `".env"` — the real `.env` (which holds real secrets) and the real `discovery-recording.ts` were **not actually being ignored**, despite appearing to be. `git check-ignore` confirmed neither matched. Fixed to plain unquoted patterns; `git check-ignore -v` confirmed both now match. Nothing had been staged in the meantime (the whole `backend/` directory was still untracked as a single unit), so this was caught before it mattered — but it's worth remembering that a gitignore entry that *looks* right needs `git check-ignore` to actually confirm it, not just a visual read.

**The login flow needed one correction versus the literal recording.** The recording showed: fill username → Tab → fill password → press Enter → click a "Sign In" button. Replicated verbatim, the "Sign In" click timed out. Debug logging (`page.url()` before the click, plus a screenshot) showed that pressing Enter alone already submitted the form and navigated to the post-login `ToDoList.jsp` page — there was no "Sign In" button left to click. Removed the redundant click; login now works.

**Verified against real stage MXI, order `P000AG1D`:**
- Login succeeds (confirmed via screenshot — real inventory data, "BRAYDEN BURY (PSA ADMIN)" shown as the logged-in user).
- `findOrderByNumber` correctly uses the global barcode search box (`#idBarcodeSearchInput`) on the To Do List page, selects the first matching purchase-order-line checkbox, and opens "Edit Lines".
- `readEsdField` reads `input[name^="aPromiseBy_"][name$="_$DATE$"]` (the CSS attribute selector handles the line-index-numbered field name, e.g. `aPromiseBy_1_$DATE$`, without hardcoding the line number) and returned `19-FEB-2026`.
- Cross-checked against a screenshot of the actual "Edit Order Lines" page for `P000AG1D`: the "Promised By" column shows `19-FEB-2026 10:52 EST` for line 1 — the date portion matches exactly. (The field is split into separate date/time/timezone sub-inputs; the `_$DATE$`-suffixed selector correctly isolates just the date, which is all Phase 1's ESD concept needs.)

### New tool: `npm run mxi:read-esd -- <orderNumber>`

`backend/src/mxiReadEsd.ts`. Logs in, looks up one order, prints its RO ESD, exits. Never fills, submits, or edits anything. Reads `MXI_STAGE_BASE_URL` / `MXI_STAGE_USERNAME` / `MXI_STAGE_PASSWORD` — a separate credential pair from the writer's `MXI_USERNAME`/`MXI_PASSWORD`, so this read-only diagnostic never depends on (or risks) the writer's config.

### Open item flagged, not yet resolved

**Unconfirmed either way: does entering "Edit Lines" to read the ESD field place a record lock or leave an "edited by" trail in MXI, even without submitting?** There's no read-only display of the field anywhere outside that edit view. This matters more once this read path is used for routine/automated polling rather than one-off manual checks — worth confirming with someone who knows Maintenix's locking model before relying on it that way.

### Updated open items for next session (superseded — see the next addendum)

- ~~`updateEsdField` / `submitChanges` are still unimplemented~~ — done, see below.
- The record-lock question above — still open.
- `mxiClient.isSessionAlive()` is still a placeholder trusting last-known-good state — now that a real login exists, a real "session expired" signal could be captured (e.g., attempt a lightweight authenticated request and see what a logged-out response looks like) the next time this is picked up.
- Once a handful of approved writes land correctly on stage, wire up Power Automate → Teams approval card → this API, per "what happens next" above.

---

## Addendum: write path implemented (`updateEsdField`, `submitChanges`) — and a real corruption bug found and fixed via live testing

The write path is done: `updateEsdField` and `submitChanges` in `selectors.ts` are real, `writeEsd.ts` now does post-submit read-back confirmation (not just a TODO), and a new `npm run mxi:write-esd -- <orderNumber> <newDate>` CLI tool exists (`backend/src/mxiWriteEsd.ts`) — reads the current value, writes the new one, confirms via read-back, prints the original for manual revert. Still a direct one-order-at-a-time CLI invocation only — not wired into `/approve` yet, per explicit instruction.

### How the recording was captured this time: an authenticated storage state, so login never needed re-recording

Before recording the write flow, two supporting pieces were built:

- `MxiClient.saveStorageState(path)` — reuses the existing `initialize()`/`login()` path, no duplicated login logic, just persists the resulting browser context via Playwright's `context.storageState()`.
- `backend/src/mxiWriter/saveStorageState.ts` (`npm run mxi:save-storage-state`) — one-off script that logs in and saves to `backend/data/mxi-stage-storage-state.json`.

This file is a live authenticated session — added an **explicit** `.gitignore` entry for the exact filename (`data/mxi-stage-storage-state.json`), not relying on the `data/` folder rule alone, given last session's quoting bug. Verified with `git check-ignore -v backend/data/mxi-stage-storage-state.json` before the file was ever created:
```
backend/.gitignore:1:data/	backend/data/mxi-stage-storage-state.json
```
(Matched by the broader `data/` rule; the explicit filename entry is now also present as an independent backup.) Confirmed after creation too: the file exists on disk and never appears in `git status`.

The user then ran `npx playwright codegen --load-storage=data/mxi-stage-storage-state.json -o discovery-recording.ts <url>` themselves — opening already authenticated, no login form to record (and no credential-exposure risk this time, unlike the read-path recording).

**One process lesson worth keeping**: the first attempt at handing back a recording came back empty, because `playwright codegen` doesn't save anything anywhere unless you pass `-o <file>` — without it, the generated script only lives in the ephemeral Inspector window. Any future codegen instructions given to the user should include `-o` from the start.

### What the recording showed, and what turned out to need correction

Recorded flow, after `findOrderByNumber` (already real from the read-path session):
```
await page.locator('input[name="aPromiseBy_1_$DATE$"]').click();
await page.getByRole('link', { name: 'OK' }).click();
await page.getByRole('link', { name: 'YES' }).click();
await page.getByRole('link', { name: 'Issue Order' }).click();
await page.getByRole('link', { name: 'OK', exact: true }).click();
```

Two real problems were found only by actually running it against stage — not by reading the recording:

**1. "Issue Order" turns out to be required, not optional, for a date-only change.** First smoke test deliberately stopped after "YES" (skipping "Issue Order"), per the user's initial instruction to hold off on it and revisit later. That attempt completed without any error, but a post-submit re-read showed the value hadn't actually changed at all. Reported this back rather than assuming success; the user confirmed "Issue Order" is necessary here and asked for it to be added in. `submitChanges()` now includes the full sequence through the final "OK".

**2. `updateEsdField`'s originally-recorded interaction (click → Backspace → type) silently corrupted the field — twice, live, before it was caught.** The user described the real interaction as "click auto-highlights existing text, Backspace clears it, then type the new value." Replicating that literally with Playwright (`.click()`, `Control+A`, `Backspace`, `.pressSequentially()`) produced a garbled hybrid value instead of the intended one:

  - Attempt 1: writing `09-JUL-2026` over `10-JUL-2026` produced `10-JUL-2020` (only the *last* character actually changed).
  - Attempt 2 (an intended fix, adding explicit `Control+A` before `Backspace`): writing `10-JUL-2026` over the now-corrupted `10-JUL-2020` produced `10-JUL-2021` — same failure pattern.

  Both were caught immediately by `writeEsd`'s own read-back check (`write_status: 'failed'`, reported to the user, not silently treated as success) — but the corrupted value had already been submitted to the real stage record each time. Rather than guess a third variation, a **non-destructive diagnostic script** (click/inspect/type-one-character-at-a-time, screenshot, no submit) was written and run directly against the live order to observe what was actually happening:
  - The DOM's own `selectionStart`/`selectionEnd` properties confirmed the *entire* existing value genuinely gets selected on click (so the selection wasn't the problem).
  - Despite that, a `Backspace` press only ever removed one character, and — critically — **every character typed after the first was silently rejected**; the field's value stopped changing entirely after the first keystroke landed. This points to custom per-keystroke JS validation on the field (common in older masked/validated date inputs) that doesn't respect the reported selection and enforces a fixed total length by rejecting further input once "full" — not a clearing problem, a validation-on-every-keystroke problem.
  - Tested `.fill()` as an alternative (sets the value via a direct DOM `input`/`change` event rather than simulating individual keydown/keypress events) on the same live field, still with no submit: it set the exact intended value correctly, in one step.

  `updateEsdField` now uses `.fill()`. Verified via a real end-to-end write (which also corrected the live corrupted value back to its original `10-JUL-2026`), then independently re-verified with the separate `mxi:read-esd` tool (no shared code path with the write verification) — both confirm `10-JUL-2026`.

### Safety-rule wording updated to match reality

The "only one call site for `writeEsd()`" comments in `server.ts` and `writeEsd.ts` were updated — there are now legitimately **two** call sites (`/approve` in `server.ts`, and the new `mxi:write-esd` CLI tool), both requiring an explicit human-specified order number. The actual invariant was never "exactly one call site," it was "never automatic/unattended" — the comments now say that instead of a now-false headcount.

### What this incident says about testing this kind of system

Two live corruptions happened because a plausible-sounding interaction (recorded from real human behavior, described accurately by the user) still didn't replicate correctly under Playwright, and the only way to find that out was to actually run it and check the result — not to read the recording and reason about whether it looked right. `writeEsd`'s read-back check did its job both times (caught the mismatch, reported failure, never claimed success it hadn't earned) — but "the write reported failure" and "the record is now wrong" are two different facts, and only checking the first would have left corrupted stage data unnoticed. Worth remembering before this is ever trusted for anything less closely watched than direct CLI testing.

### Open items for next session (superseded — see next addendum for Power Automate readiness and Notes to Receiver)

- The record-lock/edit-trail question from the read-path addendum — still open, still worth confirming with someone who knows Maintenix's locking model.
- `mxiClient.isSessionAlive()` is still a placeholder trusting last-known-good state.
- ~~Now that the write path works, wire Power Automate...~~ — API side done, see addendum below.
- ~~Before that wiring happens, worth a few more `mxi:write-esd` runs...~~ — done, see addendum below.

---

## Addendum: Automation API auth + real endpoint testing

`GET /pending-esd-updates`, `POST /approve`, `POST /reject` now require an
`X-Automation-Key` header matching `AUTOMATION_API_KEY` from `.env` (401 on
missing/wrong key, 500 if the server itself has no key configured — fails
closed). All three endpoints were exercised for real against the actual
audit DB and real stage MXI — exact curl commands and results are in root
`CLAUDE.md` under "Automation API auth", not duplicated here.

**Real bug caught before it could corrupt a live write**: `inferred_esd` is
stored ISO (`2026-07-29`); the writer expects `DD-MMM-YYYY`
(`29-JUL-2026`). `/approve` was passing the raw ISO string straight
through — the first live `/approve` call would have written a malformed
date to a real order. Fixed with `toMxiDateFormat()` in `server.ts`,
verified against sample dates, then proven correct against a real order
(`P000ATS5`: real stage value `10-JUN-2026` before, independently confirmed
`29-JUL-2026` after, via the separate `mxi:read-esd` tool).

---

## Addendum: Notes to Receiver + combined ESD/Notes write (`writeEsdAndNotes`)

A second write target was added: MXI's "Notes to Receiver" field, alongside
the ESD field, written together in one edit session with a single reissue —
`writeEsdAndNotes()` (`mxiWriter/writeEsdAndNotes.ts`) replaces the
ESD-only `writeEsd()` (deleted; calling the new function with only `esd` set
is behaviorally identical).

### A bigger architecture discovery than expected, found via live diagnostics, not the recording

The recording handed over for this (`discovery-notes-recording.ts`, since
deleted per the process below) clicked into the ESD field, went through
"OK"/"YES", then clicked "Details", then "Edit" (`#idButtonEditPODetails`),
filled `#idNoteToReceiver`, "OK", "Issue Order", final "OK". Reading it
alone would have suggested the ESD-field-click + OK/YES was a required
prerequisite for reaching Notes — exactly the kind of assumption this
project's practice is to verify, not trust. Three non-destructive live
diagnostics (no fill, no submit) against stage established the real shape
of the system:

1. Searching an order number lands **directly on that order's "RO Details"
   page** — not a results grid. RO Details has its own tab bar (Order
   Lines / Details / Filled Requests / ...) and its own top-level action
   bar (Unauthorize Order / **Issue Order** / Cancel Order / ...).
2. "Edit Lines" (the ESD field's home) is a sub-view reached from the
   Order Lines tab. "Details" tab (Notes to Receiver's home) is a
   **separate, directly-reachable tab on RO Details** — confirmed
   reachable straight from a fresh search, no Edit Lines detour needed.
   (It is *not* reachable from inside an entered-but-unconfirmed Edit Lines
   view without exiting via OK/YES first — that part of the recording's
   sequencing is real, just not because Notes requires it.)
3. `#idNoteToReceiver` in its normal (non-edit) state is a **plain text
   element, not an `<input>`** — `.inputValue()` throws
   ("Node is not an `<input>`, `<textarea>` or `<select>` element");
   `.innerText()` reads it correctly with no edit-mode entry at all, which
   is also the safer read path given the still-open record-lock question.
4. **"Issue Order" is a top-level RO Details action**, not nested inside
   the ESD-edit flow — the same shared reissue mechanism regardless of
   whether ESD, Notes, or both changed. Answers this task's opening
   question directly: it's the *same* mechanism, not a distinct one.

This directly implied the ESD-field click in the recording was very likely
the same "did it out of habit" pattern already seen once before in the
ESD-only session, not a load-bearing step for a notes-only change — and
that was then verified for real (see below), not just inferred.

### New selectors.ts functions

- `navigateToOrder(page, orderNumber)` — lighter than `findOrderByNumber`:
  searches and lands on RO Details, without checking a line or entering
  Edit Lines. Used whenever ESD isn't being touched.
- `confirmEsdLineEdit(page)` / `reissueOrder(page)` — `submitChanges()`
  split into its two reusable pieces (no behavior change; `submitChanges()`
  now just calls both in sequence, kept for the ESD-only path).
- `readNoteToReceiver(page)` — clicks Details tab, reads via `.innerText()`.
- `updateNoteToReceiver(page, noteText)` — Details tab → Edit button →
  `.fill()` → OK. Uses `.fill()` from the start (no click+backspace+type),
  learning directly from the ESD field's corruption incident rather than
  risking repeating it on an untested field.

### `writeEsdAndNotes(client, orderNumber, { esd?, noteText? })`

Within one edit session: updates ESD via Edit Lines if `esd` is set
(otherwise uses the lighter `navigateToOrder`), updates Notes via the
Details tab if `noteText` is set, then calls `reissueOrder()` exactly once
regardless of which combination was used — the branching lives inside this
one function, per the explicit design requirement, not split across two
caller-side paths. Re-reads whichever field(s) were changed from scratch
afterward (same non-trust-the-submit-alone discipline as the original
`writeEsd`), and on any failure calls `attemptCancelEdit()`, same as before.

**Note text assembly** (in `server.ts`, not this module): Vendor Notes text,
then today's date (`DD-MMM-YYYY`) on a new line. **Flagging this explicitly
as an assumption**, not a verified convention — there was no real recorded
example of "what a note should actually look like" to confirm against. If
Vendor Notes is blank, the note write is skipped entirely (no date-only
note with no content).

**`attemptCancelEdit`'s docstring updated**: a live diagnostic specifically
checked for cancel/exit/close after entering Edit Lines and confirming the
line edit (OK/YES) — none were present. The function still exists and is
still called from `writeEsdAndNotes`'s catch block (cheap, never wrong to
try), but don't assume it actually backs anything out until checked at
whichever specific point it's invoked from.

### Real tests performed (all against stage, all independently re-verified)

Test order `P000B2YT` (already touched by the user's own recording, so
already a known, non-pristine test fixture — its true pre-recording
original values aren't known and weren't chased):

1. **Notes-only branch** (`esd` omitted entirely) — called `writeEsdAndNotes`
   directly with only `noteText` set. Succeeded; independently confirmed via
   `mxi:read-esd` (now reads both fields) that RO ESD was **unchanged**
   (`19-JUL-2026`, untouched) while the note updated correctly — this is the
   direct, real proof behind the architecture discovery above, not an
   inference from it.
2. **Combined branch** (both fields) — via
   `npm run mxi:write-esd -- P000B2YT 20-JUL-2026 "Combined test - ESD and note together"`.
   Succeeded; independently confirmed via `mxi:read-esd`: ESD =
   `20-JUL-2026`, Notes to Receiver = the exact string given (multi-word
   argument correctly passed through, not split).

`mxi:read-esd` was extended to print both fields (still fully read-only) so
it continues to serve as a genuinely independent check with no shared code
path with `writeEsdAndNotes`'s own re-read — the same role it played
verifying the ESD-only fixes.

### `mxi:write-esd` CLI usage extended

```
npm run mxi:write-esd -- <orderNumber> <newDate> [noteText]
```
`noteText` is optional — omitting it exercises the ESD-only branch, still
through the same combined `writeEsdAndNotes()` rather than a separate code
path.

### `/approve` in server.ts

Now calls `writeEsdAndNotes()` instead of the retired `writeEsd()`, passing
both the reformatted ESD and `assembleNoteText(pending.vendorNotes)`. The
"exactly two call sites" comment (server.ts / writeEsdAndNotes.ts) updated
to name the new function.

### Discrepancy flagged, not resolved

The task that produced this addendum referenced "Quote-sent and
not_esd_relevant classifications" as an existing, established skip rule
("continue to skip both writes entirely, per the last prompt"). **Neither
classification exists anywhere in this codebase** — `EsdClassification` is
`explicit_date | vendor_quote_estimate | parts_pending | none`, and
`/approve` only ever sees `flag = 'ok'` rows to begin with. This looks like
it refers to a different session/branch. Nothing was fabricated to cover
it — flagging it here rather than guessing at a business rule with no
basis in the actual code.

### Process note: recording file handling

Same discipline as before: `discovery-notes-recording.ts` was read, used to
extract real selectors (with the caveat above that live diagnostics, not
the recording alone, established the real architecture), then deleted only
after `git status`/`git log --all -- backend/discovery-notes-recording.ts`
confirmed it was never staged or committed.

### Open items for next session (superseded on the note-format point — see below)

- The record-lock/edit-trail question — still open.
- `mxiClient.isSessionAlive()` — still a placeholder.
- ~~The note-text assembly convention... unverified assumption~~ — real
  precedent found, see below. **The assumed convention was wrong.**
- The "Quote-sent / not_esd_relevant" discrepancy above — resolved, see
  `CLAUDE.md`'s "Classification/EQD/buffer discrepancy" section.
- The actual Power Automate flow itself is still not built — the API side
  (auth, both write targets, real endpoint tests) is now ready for it.

---

## Addendum: real Notes to Receiver precedent found — and a serious gap in the current write design

Read-only research (no MXI writes — `navigateToOrder` + `readNoteToReceiver`
only) across a sample of real stage orders found several with genuine,
pre-existing Notes to Receiver content. Real examples (verbatim):

```
P000AED1: "01/22/2026 New serial number for P0009ZJG will be NOV01-0502/JAN02-0560 AGM

04/16/26 - NEW IB WHEEL HALF, APPROVED FOR $16239.02 - LE"

P000AG1D: "2.16.26 - BER APPROVED - AWAITING SCRAP CERT MG

5.21.2026 - Part has been scrapped and paid, working to remove -1"

P000AUCX: "04/27/26 - QUOTE APPROVED FOR $16382.40, NEW IB WHEEL HALF = $15427.06, OUT OF SCOPE QUOTE  - LE

O/B Wheel Half is to be scrapped due to NREP. Awaiting IB Wheel Half."

P000AF6C: "The part is archived as the wrong part was received on the shipment. Still awaiting information from vendor. 5.19.2026"

P000B0Y3: "5.21.2026 - Parts shortage, ESD in October"
```

**Real convention, not the assumed one**: the dominant pattern is
**date first** (various formats seen: `M.D.YY`, `MM/DD/YY`, `MM/DD/YYYY`),
then ` - `, then the note text — sometimes with a writer's initials at the
end (`- LE`, `- MG`). This is the **opposite order** of the current
assumption in `server.ts`'s `assembleNoteText()` (Vendor Notes text, then
date on a new line). One example (`P000AF6C`) has the date at the end
instead, so it's not perfectly universal, but date-first-with-dash is the
clear majority pattern across every multi-word example found.

**More importantly: this field is an accumulating log, not a single
value.** Every example with real content shows multiple dated entries
separated by a blank line — a running history of updates over time (new
serial number assigned, then a later BER approval, then later a scrap
disposition, etc.), not "the current note" being overwritten each time.

**This exposed a real problem with `updateNoteToReceiver` as it was
originally implemented**: it called `.fill(noteText)`, which **replaced
the entire field**, not appends to it. If `writeEsdAndNotes` had been run
against any order with real existing note history (e.g. `P000AG1D`,
confirmed above to have two real dated entries), it would have **silently
destroyed that history**. This wasn't caught earlier because every write
tested so far was against orders with no prior note content (blank) or
only this project's own test text. **Fixed in the next session — see the
addendum below.**

**Separate, practical finding**: most order numbers sampled from the real
audit DB (589-order production-oriented dataset) **do not exist in stage
MXI at all** — searching them returns "The barcode '...' could not be
found in the system," not a timeout or a different bug. Of 28 sampled real
order numbers, roughly half didn't exist in stage. Confirmed by the user:
stage doesn't mirror the real order list being pulled from for inference.
Practical implication: testing against "whatever's in the latest pending
list" won't reliably work — stick to known-existing stage orders (`P000AG1D`,
`P000ATS5`, `P000AYQU`, `P000B2YT`, `P000AED1`, `P000AUCX`, `P000AF6C`,
`P000B0Y3` are all confirmed to exist as of this session) for any further
manual testing.

---

## Addendum: Notes to Receiver append fix — verified against real existing history

The destructive-overwrite gap above is fixed. `updateNoteToReceiver` no
longer blindly `.fill()`s — it reads whatever's currently in the field
first, and only if that's non-blank does it combine
`${existing}\n\n${newEntry}`; if the field was blank, it writes just the
new entry. It returns the pre-write value so the caller can verify prior
history stayed intact afterward, not just that the new entry landed.

**Chronological order confirmed from the actual samples, not guessed**:
`P000AED1`'s two entries run `01/22/2026` then `04/16/26`; `P000AG1D`'s run
`2.16.26` then `5.21.2026`. Earlier dates consistently appear before later
ones — new entries are **appended at the end**, never prepended.

**`assembleNoteText()` (`server.ts`) corrected to match the real
convention**: `M.d.yy - <Vendor Notes>` (date-fns format token `M.d.yy`,
verified to produce e.g. `2.16.26` for Feb 16 — an exact match against
`P000AG1D`'s own real first entry). It now builds only the one new entry,
not a full field value — the docstring on `EsdAndNotesUpdate.noteText`
spells this out so it isn't a silent convention change a future reader has
to rediscover.

**`writeEsdAndNotes`'s read-back check rewritten**: it used to compare the
re-read field against `update.noteText` directly (correct when notes were
a single value, wrong now that they're not). It now reconstructs the
expected value as `${previousNote}\n\n${update.noteText}` (or just
`update.noteText` if the field was blank) and compares against that —
proving both that the new entry landed AND that prior history wasn't lost,
per the explicit ask, not just the former.

**Tested for real against `P000AG1D`**, which real Part B research had
already confirmed has genuine pre-existing history (not this project's own
test text) — the one deliberate criterion for this test, since a
blank-notes order couldn't have caught the original bug or confirmed this
fix:
- Before: `RO ESD = 19-FEB-2026`; Notes = the two real entries
  (`2.16.26 - BER APPROVED...`, `5.21.2026 - Part has been scrapped...`).
- Ran `npm run mxi:write-esd -- P000AG1D 22-JUL-2026 "7.9.26 - Testing append logic, should preserve prior history"`.
  Succeeded; `writeEsdAndNotes`'s own check confirmed prior history intact.
- **Independently re-verified** via the separate `mxi:read-esd` tool (no
  shared code path): both original entries were still present, in their
  original order, with the new entry correctly appended after them.
- ESD reverted back to `19-FEB-2026` afterward (a single revertible value).
  The test note entry was deliberately **not** removed — Notes to Receiver
  is a permanent accumulating log by design (that's the entire point of
  this fix), so there's no "revert" for an appended entry any more than
  there would be on the real system. `mxiWriteEsd.ts`'s printed guidance
  was updated to stop suggesting a note "revert command" that never made
  sense once notes stopped being overwritable.

### Open items for next session

- The record-lock/edit-trail question — still open.
- `mxiClient.isSessionAlive()` — still a placeholder.
- The date-first convention (`M.d.yy - text`) matched the clear majority of
  real examples, but wasn't 100% universal (`P000AF6C` had the date at the
  end) — worth keeping an eye on whether that's a real exception or just
  one person's habit, if more real examples turn up later.
- The actual Power Automate flow itself is still not built.
- **New, unresolved: `reissueOrder()`'s "Issue Order" click failed
  intermittently in a real combined-write smoke test — see the addendum
  immediately below. This needs real investigation before the combined
  path is trusted beyond direct CLI testing.**

---

## Addendum: a real, unresolved reissueOrder() reliability gap found via live testing

A routine real smoke test (`npm run mxi:write-esd -- P000B2YT 25-JUL-2026
"7.9.26 - Smoke test of combined write path"`, run against the same
`P000B2YT` fixture used throughout this project) **failed**:
`writeEsdAndNotes` returned `status: 'failed'`, `errorMessage: "locator.click:
Timeout 30000ms exceeded ... waiting for getByRole('link', { name: 'Issue
Order' })"`.

**What actually happened, confirmed by re-reading the order (not assumed):**
the ESD field genuinely changed (`20-JUL-2026` → `25-JUL-2026`, confirmed
independently via `mxi:read-esd`), but the Notes to Receiver entry was
**not** appended — the field still showed only the pre-existing single
entry. So this was a **partial write**: the ESD portion of the combined
session committed, but the flow never reached `reissueOrder()`
successfully, and the note portion never landed.

**This directly contradicts Phase 2c's established finding** that "Issue
Order" is required for an ESD change to persist — here, the ESD change
persisted despite `reissueOrder()` never successfully executing. Follow-up,
narrower diagnostics (never reaching a full write — stopped right after the
ESD-line-edit "OK" click each time) reproduced a related but different
symptom twice in a row: `confirmEsdLineEdit()`'s own "YES" click also timed
out, even with genuinely different ESD values each time supplied. Checking
the order's real RO Details page afterward showed the ESD value HAD updated
to match, and the order's own "Issued: N time(s)" counter had climbed from
2 (recorded much earlier in this project) to 4 by the end of these
attempts — **without any of these attempts ever successfully clicking
"Issue Order" through the normal flow**.

**Working hypothesis, not confirmed**: the "OK" click on the ESD-line-edit
confirmation may, in at least some cases, silently commit *and* reissue the
line on its own — meaning "YES" and "Issue Order" might not always be
required in the way Phase 2c's original test established, or their
necessity may depend on some order/line state not yet understood (repeated
testing state, timing, something about this specific heavily-reused test
order). This is a **hypothesis**, explicitly not verified — it would need
its own dedicated, careful diagnostic investigation (much like the original
ESD-field corruption bug), not a guess baked into the code.

**Deliberately stopped investigating further in the same session this was
found**, rather than keep making live changes to try to force a clean
reproduction — `P000B2YT` has now been searched, edited, and reissued a
great many times across this whole project and may itself have drifted
into an atypical state from sheer reuse; further blind poking risked
making the picture murkier, not clearer. Final confirmed state left on the
order: `RO ESD = 26-JUL-2026`, Notes to Receiver unchanged from before this
test (`"Combined test - ESD and note together"`, the single entry from an
earlier session — never successfully appended to in this test).

**Practical implication for next session**: `writeEsdAndNotes` correctly
reported `status: 'failed'` rather than silently claiming success — the
read-back discipline did its job. But this is now a **known-unreliable**
path (worked cleanly against `P000AG1D` earlier this same session, failed
against `P000B2YT` just now) and should not be trusted for unattended use
until the "OK" vs "YES" vs "Issue Order" relationship is actually
understood via careful, incremental diagnostics — ideally against a fresh
or less-abused test order, not `P000B2YT` specifically, to rule out that
order's own testing history as a confound.

---

## Addendum: the anomaly did NOT reproduce on a fresh order — likely `P000B2YT`-specific, not a general bug

Followed the plan above: picked `P000AUCX` — one of the four known-good
orders never previously touched by any write/reissue action (only ever
read during Part B research; `P000AG1D` and `P000B2YT` had both already
been through `writeEsdAndNotes`, `P000ATS5`/`P000AYQU` through the older
pre-Notes `writeEsd()`). Recorded baseline first, independent of any
write attempt: `Issued = 5 time(s)`, `Order Status = ISSUED`, `RO ESD =
17-JUL-2026`, Notes = the known two real entries. (Worth noting: this
order already showed `Issued = 5` and status `ISSUED` before any of my
testing ever touched it — real orders in this dataset can have high issue
counts and `ISSUED` status just from normal use, which tempers how much
weight `P000B2YT`'s own high count carries as an explanation on its own.)

Ran an instrumented replica of `writeEsdAndNotes`'s exact step sequence
(same selectors, in the same order, with logging after each one) rather
than modifying the production function itself. **Every step succeeded
cleanly** — `findOrderByNumber`, `updateEsdField`, `confirmEsdLineEdit`
(OK then YES), `updateNoteToReceiver`, and `reissueOrder` (Issue Order
then final OK) all completed without a single timeout.

**Independently verified afterward, not just trusted**: `Issued` climbed
from `5` to `6` — exactly one increment, matching exactly one successful
reissue, no phantom/extra commits. Both original note entries were intact
with the new entry correctly appended after them. ESD updated exactly to
the intended value. Full agreement between what the code reported and
what the system actually did — no discrepancy this time, unlike the
`P000B2YT` run.

**Per the task's own explicit conditions**: repeating on a second fresh
order was conditional on the anomaly reproducing, and proposing a fix was
conditional on it reproducing *twice*. Neither condition was met — this
run had zero failures to compare against reality, so there's nothing to
propose a fix for yet. **No code changes were made based on this single
clean run**, per the explicit non-goal.

**Working conclusion, still provisional**: one clean run on a fresh order
doesn't prove `writeEsdAndNotes` is reliable in general, but it does weigh
against a general/deterministic bug in `reissueOrder()` itself, and toward
the `P000B2YT`-specific-state hypothesis already raised (heavy reuse,
possible order/line-level side effects from being repeatedly
edited/reissued many times across this whole project). If the failure
mode shows up again on a *different* order in the future, that would be
the point to revisit this — a single discrepancy on the most-reused test
fixture in the project isn't enough to conclude the write path itself is
unreliable, but it also isn't nothing, and shouldn't be forgotten.

**Final state left on `P000AUCX`** (not reverted — stage has no real
consequences, and this order already carried real prior history/status
before this session touched it): `RO ESD = 22-JUL-2026`, `Issued = 6
time(s)`, Notes to Receiver = the original two real entries plus
`"7.9.26 - Investigating reissueOrder reliability"` appended at the end.

---

## Addendum: Part C run at real scale (40 explicit_date orders) — the reissueOrder() anomaly reproduces on non-test orders, AND has a worse variant than known

Ran Part C's auto-write tier (flag='ok', classification='explicit_date')
in two stages against Run 13's real 40 eligible orders, per explicit
staged instructions. **Stage 1** (first 5: `P000AG1J`, `P000AGPC`,
`P000ANMH`, `P000APDK`, `P000ATS5`) — all 5 succeeded cleanly, every
independent read-back matched, `Issued` delta exactly +1 every time, no
session anomalies. Cleared the "proceed to the rest" gate.

**Stage 2** (remaining 35) — 27 succeeded cleanly (same clean pattern:
independent read-back match, `Issued` +1). 8 reported failure. Investigated
every one individually rather than trusting the reported status, per the
explicit instruction that this scale run exists specifically to surface
what a single clean run couldn't:

- **5 of the 8 (`P000B5VF`, `P000B603`, `P000B6JE`, `P000B6RZ`, `P000B76S`)
  are a genuinely different, unrelated failure**: `findOrderByNumber`
  timed out waiting for the search-result checkbox. Confirmed via a
  completely fresh, isolated session (new login, new browser context) that
  each of these order numbers **doesn't exist in stage MXI at all**
  ("The barcode '...' could not be found in the system") — the same
  stage/production data mismatch already documented from Part B research,
  not a reliability problem. All 5 happened to land consecutively at the
  end of the batch by coincidence of ordering, not because of session
  degradation — the fresh isolated check ruled that out directly.

- **The other 3 (`P000AY70`, `P000B0YU`, `P000B2YT`) are the known
  "waiting for YES" reissueOrder() anomaly — and it does NOT only affect
  `P000B2YT`.** `P000AY70` and `P000B0YU` had never been touched by any
  previous session. This directly retires the earlier "maybe it's just
  `P000B2YT`'s heavily-reused state" working theory — it wasn't that.

- **A worse variant than previously known, found by independently
  re-verifying every "failed" order instead of trusting the reported
  status** (the batch script only did independent read-back on the
  success path — a real gap, now known): of these 3, **two
  (`P000AY70`, `P000B2YT`) silently committed the ESD field to the
  correct value anyway**, confirmed via fresh read-back after the fact —
  matching the original `P000B2YT` incident exactly. **The third
  (`P000B0YU`) was a genuine, clean failure** — the field's real value
  (`30-JUN-2026`) never changed to the target (`12-JUL-2026`) at all. So a
  reported failure from this specific timeout is **not reliable evidence
  of anything** — it can mean a clean no-op failure, or a silent partial
  success, and the only way to know which is an independent check
  afterward, every time.

  **Critically, for both silent-success cases, the Notes to Receiver
  append never happened** — confirmed: `P000AY70`'s note is still blank
  despite non-blank Vendor Notes that should have produced one;
  `P000B2YT`'s note still shows only old test text from an earlier
  session, not today's attempted entry. The exception fires at the
  `confirmEsdLineEdit` "YES" step, which is *before* `updateNoteToReceiver`
  ever runs in the code — so on this failure mode, the ESD field can
  commit (apparently via whatever the "OK" click itself does server-side)
  while the note portion is skipped entirely. This is a **partial write**
  that the current success/failure model has no category for.

**Audit trail corrected, not silently left wrong**: `mxi_writes` (append-
only, per its own rule) now has a corrective row for `P000AY70` and
`P000B2YT` recording the true outcome (`write_status: 'success'`,
`approved_by: 'part-c-auto-stage2-CORRECTED'`, with a note explaining the
notes-append gap) alongside the original incorrect `'failed'` row from the
batch run itself — both are preserved, not overwritten, so the full story
is visible to anyone reading the table later.

**Stopped here, deliberately** — did not proceed to the vendor_quote_estimate
interactive stage or write the tool-table columns back into the live file,
pending the user's direction on the three questions above. All three were
answered and acted on:

1. Added an 8th template, "Partially Updated" (`writeToolOutputFlags.ts`),
   distinct from both "Updated" and "Write Failed" — for the case where the
   ESD field committed correctly but Notes to Receiver did not.
2. `partCAutoWrite.ts` rewritten so independent re-verification runs for
   **every** outcome, not just reported successes — the fix directly
   indicated by finding 2 of 3 "failed" orders were actually silent partial
   successes. Now classifies into five real outcomes: `success`, `partial`,
   `failed`, `not_found` (order confirmed absent from stage — a fresh,
   isolated session check, not a guess), and `halted` (session/login loss).
3. Ran a targeted notes-only follow-up write (ESD field omitted entirely,
   so it couldn't touch the already-correct value) against `P000AY70` and
   `P000B2YT` — both landed and were independently verified. Given that fix
   landed, the tool-table reflects their **final** state ("Updated", full
   success) rather than the resolved intermediate "Partially Updated" one —
   the partial-success history stays visible in `mxi_writes`, just not as
   the live status.

### The vendor_quote_estimate interactive stage

Presented all 4 real cards (order, vendor, current MXI ESD, inferred ESD,
classification/confidence, reasoning, vendor notes) for a real approval
decision each — not decided autonomously, since that's the entire point of
this tier being human-reviewed rather than auto-written. All 4 approved.
Result: `P000B5DS` succeeded cleanly (ESD + note both independently
verified); `P000B7W7`/`P000B86C`/`P000B86E` all confirmed **not present in
stage MXI** via the same fresh-session check used for the explicit_date
tier's 5 not-found orders.

### Final tool-table write-back

One call to `writeToolOutputFlags` against the full 632-row Run 13 record
set, with real outcomes provided for all 44 orders actually acted on this
session. Verified order-by-order against the DB afterward. Final
Automation Flag counts across all 131 candidate rows:

| Flag | Count |
|---|---|
| No ESD Found | 87 |
| Updated | 35 |
| Not Found in Stage | 8 |
| Write Failed | 1 |
| **Total** | **131** |

`Not Found in Stage` was added as its own category (not just a `Write
Failed` variant) per explicit user feedback mid-run — it reads as "no
action needed, expected stage/production gap" rather than something to
investigate, which a generic Write Failed message would have implied
incorrectly.

### What this whole run actually proved

- The reissueOrder() anomaly is real, reproduces on ordinary orders (not
  just `P000B2YT`), and can silently commit a partial write while reporting
  failure — now something the write path can detect and label correctly
  instead of silently trusting a status flag.
- Stage genuinely doesn't contain every order from the real dataset — 8 of
  44 confirmed absent this run, consistent with Part B's earlier finding.
  This is now a distinctly-labeled, expected outcome, not noise mixed into
  "failed."
- The append-only audit trail (`mxi_writes`) did its job: every reported
  status, every correction, and every follow-up action for this whole run
  is preserved and attributable, not overwritten.

---

## Addendum: Aero Repair write-up workflow (`backend/src/writeUps/aeroRepair/`) — known test-article state

Everything below is about the **separate Aero Repair order write-up
workflow** (vendor-specific, deliberately not sharing logic with the ESD/MXI
writer above), built and live-tested against real stage MXI across several
sessions. Recorded here — the same file every session is told to read for
context — so a future session doesn't assume a pristine/default state for
the 6 known Aero Repair part numbers.

**5013640 / SN `JUL14-3229`**: **not pristine.** Its charge-to-account field
was permanently mutated to `CR9WHEELSBRAKES` by an earlier test run (the
replace logic correctly refuses to run again on an already-transformed
value — confirmed live, this is `buildWheelsBrakesChargeToAccount` doing its
job, not a bug). A real order, `P000B5NM`, was created against this line and
Request Authorization was started but never completed (abandoned mid-flow
by an earlier bug, now fixed). **Confirmed live this session: this line
still appears as the automation's first-matched eligible line for
5013640** — the abandoned order did not remove it from the eligible-line
grid, and did not create a second/duplicate entry either. Any future
automated run against `5013640` will hit this same line first and fail
immediately at the charge-to-account step, by design (not a new bug) —
pick a different `5013640` line explicitly, or use a different part number,
for further testing.

**5013641**: confirmed via two independent live checks (across two
sessions) — **zero eligible open repair lines in stage**, both times.

**5013642-1** and **90001201-1**: also confirmed this session — **zero
eligible open repair lines in stage**, same as 5013641. New information as
of this session (previously unknown for these two specifically).

**90001200-1 / SN `JUN14-2448`**: real order `P000B5NN` created and
authorization requested (via `REPAIR (Repair Authorization)`) — the
successful full end-to-end test from the prior session. Not corrupted, but
no longer a "blank slate" line either.

**90001201-2 / SN `OCT14-2428`**: confirmed to have exactly one eligible
open repair line, at `DCA/USSTG` — **not yet touched** by any write-up
automation run as of this session.

**Routing coverage gap, confirmed by scanning every currently-eligible line
across all 6 known part numbers**: the only stations represented are `CLT`/
`GSP` (both route to Georgia) and `DCA` (routes to NH, already exercised).
**No currently-eligible line routes to Indy (CAK/DAY/CVG) or DFW** — those
two routing destinations cannot be live-tested against the known 6 part
numbers until a matching line appears in stage.

**No-tasks-assigned check — corrected twice in one session, now verified
both directions with real data.** First correction (wrong): replaced
`NO_TASKS_ASSIGNED_TEXT` with `"There are no open tasks for this inventory
item or any of its sub-inventory items."`, found on the `Unassigned` ->
`Unassigned Tasks` sub-tab. This looked right in isolation but was checking
the **wrong page location** — every real line scanned (7 across 3 part
numbers) showed that exact message on that sub-tab, *including* lines with
genuine assigned work (confirmed: `90001200-1` / SN `JUN14-2448` has a real
task, `REMOVED LH IB WHEEL AND TIRE FOM`, yet still showed that message on
the Unassigned Tasks sub-tab). User clarified: that sub-tab's "no open
tasks" is the **normal, non-blocking state** and must never halt the flow.

**Second correction (right)**: the actual blocking condition lives on the
**default "Assigned Tasks" tab** — landed on immediately after clicking a
part's repair link, *before* any Unassigned/Unassigned Tasks navigation.
The originally-assumed string, `"There are no tasks assigned to this work
package."`, was correct all along; it was only ever being checked in the
wrong place. Confirmed live, both directions, on real captured text: PN
`14700AA` / BN `389428` (genuinely empty) shows exactly that string there;
`90001200-1` / SN `JUN14-2448` shows a real task row instead, no such
message. `writeUp.ts` now reads and checks this tab's text immediately
after `findFirstRepairLineForPart`, before the (still-necessary,
unrelated) `navigateToUnassignedTasksView` call.

---

## Addendum: routing was never actually wired to vendor selection — found and fixed, with real (contained) side effects

A serious, previously-hidden gap: `AERO_REPAIR_ROUTING`'s computed location
was purely informational/logged — nothing ever used it to select the
matching vendor radio in the Vendors/Shops list. `recheckRepairLineForSchedule`
just checked whichever vendor radio was first in the target line's
immediate `<tr>`, which is NOT the routed vendor. Found via live testing: an
order for a `CLT`-station line (routes to Georgia) ended up with real
**Vendor: `VC00412 (AERO REPAIR - NH)`** — NH, not Georgia — because NH
happened to be listed first for that line.

**Real DOM structure, confirmed via direct inspection**: a line's "main" row
(containing the repair link, identifiable by also containing `INTERCHG`) is
followed by one sibling `<tr>` per vendor bid, until the next line's own
main row starts. **Fixed**: `selectVendorRadioForRouting` (`partDetails.ts`)
walks those siblings and clicks the radio whose text matches the routing
location, throwing if none match rather than defaulting to any vendor.

**`AERO_REPAIR_ROUTING`'s location strings were also wrong for 2 of 4 real
vendor names** (only caught because they're now load-bearing, not just
descriptive) — confirmed live across multiple lines: the real name is
`"AERO REPAIR GEORGIA"` (no hyphen, unlike INDY/NH) and `"AERO REPAIR CORP
- DFW"` (includes "CORP"). Both corrected in `constants.ts`.

**Real, contained side effect from the bug (found while investigating, not
before)**: a test run targeting the fresh line `S-NOV22-0797/APR07-1770`
(CLT, routes to Georgia) generated a real new order, but a SEPARATE bug in
`findGeneratedOrderNumber` (see below) caused Request Authorization to run
against the **wrong, unrelated, already-existing order `P000B5NM`**
(`JUL14-3229`'s order) instead — genuinely completing that order's
authorization (`Order Status: AUTH`, `Authorization Status: APPROVED`)
against vendor `VC00794 (AERO REPAIR CORP - DFW)`, matching neither
`JUL14-3229`'s own Georgia routing nor anything related to
`S-NOV22-0797/APR07-1770`. Contained by the Issue Order boundary — that
order was never issued — but a real, unintended stage mutation, not
hypothetical. `S-NOV22-0797/APR07-1770` itself DID get its own correct new
order (`P000B5NR`) from a later, corrected run — see below.

**`findGeneratedOrderNumber` bug, found and fixed**: it used `.first()` on
every order-number-shaped link on the whole post-submit page — but that
page is the same part-number-filtered grid used throughout this module,
which shows OTHER pre-existing orders for OTHER lines of the same part
number. Fixed by scoping to the same row as the specific repair line just
scheduled (same ancestor-of-known-unique-link technique used elsewhere).

**Vendor-selection fix verified twice**: once via a live, non-destructive
check (selected the radio, read back which one was actually checked —
confirmed `"AERO REPAIR GEORGIA"`, not NH — without submitting anything),
and once via a real full-flow run against a fresh line (`S-NOV22-0797/APR07-1770`
-> real order `P000B5NR`, independently confirmed via direct order lookup
to be genuinely tied to the correct line with the correct charge-to-account).

### Updated real state of every touched `5013640` line, as of this session

| Serial | Station | Routes to | Real order | Status |
|---|---|---|---|---|
| `JUL14-3229` | CLT | Georgia | `P000B5NM` | `AUTH`/`APPROVED`, vendor **DFW** (wrong — see above) |
| `MAY03-0588` | GSP | Georgia | `P000B5NP` | `OPEN`/`PENDING` (Schedule Work Package only, no auth requested) |
| `MAY04-0841` | GSP | Georgia | `P000B5NQ` | `OPEN`/`PENDING` (same — a client-side timeout meant Auth Flow was never reached, even though the schedule itself succeeded server-side) |
| `MAY16-3620` | DCA | NH | none | **still untouched** — the one remaining fresh `5013640` line |
| `S-NOV22-0797/APR07-1770` | CLT | Georgia | `P000B5NR` | `AUTH`/`APPROVED`, vendor **NH** (also wrong — created and authorized by the SAME run that exposed the vendor-selection bug, i.e. before the fix landed) |

**All of `5013640`'s Georgia-routable lines (`CLT`/`GSP`) are now touched,
and none of the resulting real orders have a vendor matching their actual
routing** — all three (`P000B5NM`, `P000B5NP`/`P000B5NQ` partially,
`P000B5NR`) predate or were created before the vendor-selection fix landed.
The fix itself is verified correct via a separate, non-destructive check
(confirmed selecting `"AERO REPAIR GEORGIA"` for a Georgia-routed line) —
just not yet proven via a fresh, post-fix, real order for Georgia, since no
untouched Georgia-routable line remains among the known 6 part numbers.

**`MAY16-3620` (DCA, NH) — the last untouched `5013640` line — was then used
for a clean, fully post-fix confirmation**: real order `P000B5NS`,
independently verified via direct order lookup: correctly tied to
`MAY16-3620`, `CR9WHEELSBRAKES` charge-to-account, and **`Vendor: VC00412
(AERO REPAIR - NH)`** — matching DCA -> NH routing exactly, with the
order-detection and vendor-selection fixes both in place. `5013640` now has
no untouched lines remaining at all.

---

## Addendum: Issue Order implemented and proven in isolation, real state independently verified

`issueGeneratedOrder()` (`writeUps/aeroRepair/issueOrder.ts`) is a new,
**standalone** function — not called from `runAeroRepairWriteUp()` or
anywhere else in the write-up flow, exactly per this task's requirement.
Its own CLI, `npm run aero-repair:issue-order -- <orderNumber>`, is the
only call site. Real, from the original `discovery-writeOrder-recording.ts`
(lines 47-48) — just two steps, nothing more:

```ts
await page.getByRole('link', { name: 'Issue Order' }).click();
await page.getByRole('link', { name: 'OK', exact: true }).click();
```

Same underlying top-level RO Details action already discovered and
extensively tested in the ESD/MXI-writer module's `reissueOrder()` — that
module's own documented history (the "reissueOrder() anomaly" addenda
above) is exactly why this function does NOT self-verify; the caller is
expected to independently re-check the order's real state.

**Tested live against a real, already-authorized order** — `P000B5NN`
(from an earlier session's `90001200-1` / `JUN14-2448` run), reused rather
than creating yet another new order, since it was already sitting in
exactly the right pre-issue state. Independent verification, via a
completely separate script/session, both before and after:

| | Before | After |
|---|---|---|
| Order Status | `AUTH (Order authorized)` | `ISSUED (The order has been issued.)` |
| Issued | `0 time(s)` | `1 time(s)` |
| Authorization Status | `APPROVED` | `APPROVED` (unchanged) |
| Top action bar | `Unauthorize Order` \| **`Issue Order`** \| `Cancel Order` \| `Print Order` | `Unauthorize Order` \| **`Close Order`** \| `Cancel Order` \| `Print Order` |

**Two real discoveries, not assumed beforehand**:
1. **The "Issue Order" action is replaced by "Close Order" after issuing** —
   a further lifecycle step exists (closing the order) that was never
   mentioned or tested. Not implemented — out of scope for this task, just
   flagged as existing.
2. **The order line's "Original"/"Warranty Contract" sub-columns, blank
   before issuing, populate with a price/date snapshot afterward**
   (`796.95 USD` / `17-AUG-2026 23:11 EDT`, matching the line's own
   existing values) — a real side effect of issuing, not previously seen.

No extra dialogs, no unexpected intermediate confirmations — the two-click
sequence from the recording matched exactly, on the first attempt, with no
correction needed (unlike several earlier steps in this project). Also
confirmed `OCT14-2428` (`90001201-2`, DCA) genuinely has no assigned tasks
via the no-tasks-assigned check correctly halting a full-flow attempt
against it — another real negative-case confirmation for that check,
found incidentally while looking for a fresh test line.

---

## Addendum: two-phase review gate built and proven live — Issue Order requires explicit human approval until each destination has a production track record

`aero-repair:write-up` no longer treats a real order + Auth Flow
confirmation as terminal. `write_up_actions` gained an `order_number`
column (migrated onto the existing real `data/audit.db` via a
`PRAGMA table_info` check + `ALTER TABLE`, since `CREATE TABLE IF NOT
EXISTS` has no effect on an already-existing table) and a new
`'pending_issue'` outcome value, used whenever a real order was generated
and authorization requested. A new append-only `write_up_issue_decisions`
table records the human decision — same relationship to `write_up_actions`
that `mxi_writes` has to `esd_inferences`.

**Three new CLIs**, none wired to each other automatically:
- `npm run aero-repair:review-pending` — read-only, lists every
  `pending_issue` order with no decision yet: order number, part number,
  routing destination, selected vendor, charge-to-account (before/after),
  return-to-location, notes text.
- `npm run aero-repair:approve-issue -- <orderNumber> [reviewedBy]` —
  requires an actionable `pending_issue` row (refuses otherwise), calls
  `issueGeneratedOrder()` completely unchanged, then **independently
  re-navigates and re-reads the order's real Order Status** before logging
  the decision — a reported success from the function alone is never
  treated as sufficient, per this project's own repeated lesson about this
  exact class of MXI action.
- `npm run aero-repair:reject-issue -- <orderNumber> [reviewedBy]` — same
  shape as the ESD flow's reject: records the decision, never touches MXI.

**Tested live end-to-end.** No fresh untouched line remained on any proven
route across all 6 known part numbers (re-scanned to confirm) — per this
task's own "if available" allowance, used `P000B5NR` instead: a real order
from an earlier session, independently confirmed still `AUTH`/`APPROVED`
(genuinely pre-issue) before touching it. Backfilled one accurate
`write_up_actions` row for it (real values from that session's own printed
output, not fabricated — it predates this session's schema) so the new
gate had a real candidate to act on. Full sequence, independently verified
at each step:
1. `review-pending` listed it correctly (all fields matched the real
   historical run).
2. `approve-issue` ran `issueGeneratedOrder`, then its own fresh read
   confirmed `Order Status: ISSUED`, `Issued: 1 time(s)`.
3. A **separate, independent script** confirmed the same real state again.
4. `review-pending` afterward correctly showed **nothing pending**.
5. Direct DB query confirmed the full chain: one `write_up_actions` row
   (`pending_issue`) linked to one `write_up_issue_decisions` row
   (`approved_issue`/`success`).
6. Negative-path checks: rejecting a nonexistent order number was
   correctly refused (no actionable row); rejecting the *already-issued*
   `P000B5NR` was allowed and appended a second decision row rather than
   being blocked — this is the same deliberate non-blocking design as
   `getActionableEsdInference` (re-actioning appends, only the pending
   *list* hides already-decided orders), not a bug, though it did leave a
   slightly confusing two-decision history on this one test order (a real
   `approved_issue`/`success` followed by a test-only `rejected`) — worth
   knowing if that history is ever read literally.

**Still not done, deliberately, per this task's non-goal**: production has
not been touched, and this gate is not yet a hard requirement anywhere —
it exists and works, ready to be made mandatory once pointed at anything
beyond stage.

---

## Addendum: the gate had a hole, and reject-issue could lie — both found and fixed

**The standalone `npm run aero-repair:issue-order` CLI (and
`aeroRepairIssueOrderCli.ts`) still existed and was still fully callable**
— a direct, ungated path to `issueGeneratedOrder()` sitting right next to
the new review gate, undermining the entire point of building it. Deleted
outright, not disabled — the underlying `issueGeneratedOrder()` function
itself is untouched and still used by `approve-issue`; only the standalone
bypass CLI and its npm script are gone. `npm run aero-repair:approve-issue`
is now the only callable path to actually issuing an order.

**`reject-issue` could misrepresent reality**: it recorded a plain
`'rejected'` unconditionally, without ever checking the order's real
current state. If the order had already been issued by the time
reject-issue ran (e.g. a prior `approve-issue` already succeeded, or two
reviewers act on the same order), that plain `'rejected'` record would be
false — the reject decision had no effect, the order was already issued
beforehand. **Confirmed this wasn't hypothetical**: re-checking last
session's own negative-path test row against `P000B5NR` retroactively
proved *that* row (`action: 'rejected'`, id 2) was already exactly this
lie — `P000B5NR` was already `ISSUED` at the time it was recorded.

**Fixed**: `readOrderRealState()` (`issueOrder.ts`) — a shared helper,
extracted from what `approve-issue` was already doing inline — is now
called at the *start* of `reject-issue`, before any decision is recorded.
If the order is genuinely not yet issued, records `'rejected'` exactly as
before. If it's already `ISSUED`, records the new, distinct
`'rejected_but_already_issued'` instead. This is the one case
`reject-issue` now touches MXI at all — a read-only navigation to look,
never to act.

**Re-verified live against the exact same order the bug was found on**:
ran the fixed `reject-issue` against `P000B5NR` again (still confirmed
`ISSUED` beforehand). Result: `action: 'rejected_but_already_issued'`
(id 3) — distinctly different from the old `'rejected'` row (id 2),
both preserved in the append-only history, confirmed via direct DB query:

```
id=1  approved_issue              / success  — the real issue, from last session
id=2  rejected                    / skipped  — OLD, now-known-false record
id=3  rejected_but_already_issued / skipped  — NEW, correct record, same order
```

The genuinely-still-pending branch (`realStatus !== 'ISSUED'` ->
`'rejected'`) preserves the exact previous behavior and wasn't
independently re-tested live this session — no genuinely-pending
(authorized-but-not-issued) order was available to test it against; the
branch itself is a straightforward, unchanged code path.

**Still not done, deliberately, per this task's non-goal**: Issue Order is
not wired into `runAeroRepairWriteUp()` or any automatic flow, and
production has not been touched.

---

## Addendum: Georgia's "done" status resolved (unverified, same as NH's original run) — and production read-only connectivity confirmed

**Part A — Georgia routing question resolved.** Queried `write_up_actions`
directly for the Georgia-routed run: order **`P000B5NR`**, the
`S-NOV22-0797/APR07-1770` line, real write-up timestamp
`2026-07-19T03:46:17.637Z` (`id=14` in `write_up_actions`, station `CLT`).
This run predates the vendor-selection fix — it's the exact run that
*exposed* that bug (the order's real vendor ended up `VC00412 (AERO REPAIR
- NH)`, not Georgia). **Same case as NH's original suspect run**: reported
"done" without the vendor-selection fix in place, so Georgia has **no
verified clean success with a correct vendor** — only a non-destructive
radio-selection check (confirmed selecting the right vendor, but never
carried through to a real new order) done after the fix. Unlike NH (which
got a genuine clean post-fix run via `MAY16-3620` -> `P000B5NS`), no fresh
Georgia-routable line has existed since the fix to repeat that proof.

**Part B — read-only production check, no writes.**

1. **Traced the real code path — it is NOT `MXI_ENV`.** `MXI_ENV`
   (`mxiWriter/config.ts`'s `loadMxiConfig()`) is a separate mechanism used
   only by `server.ts`'s `/approve` endpoint (the ESD writer's HTTP API).
   The aeroRepair module's three CLIs (`write-up`, `approve-issue`,
   `reject-issue`) never call `loadMxiConfig()` at all — they use
   `parseEnvFlag()` (a `--env stage|production` CLI argument) feeding
   `createReadyMxiClient()`, which reads `MXI_STAGE_*`/`MXI_PROD_*`
   directly. Confirmed the same safety property holds via this different
   mechanism: `parseEnvFlag([])` defaults to `"stage"`; `--env Production`
   (wrong case) throws; only the exact literal `--env production` selects
   production. One real, precise discrepancy found while tracing this: the
   loud production warning banner (shared code, `printProductionWarningIfNeeded`)
   still prints literally "MXI_ENV=production" even when reached via the
   `--env` flag, not that variable — the safety behavior is correct
   (it fires), the banner's wording is just inherited from the other
   mechanism and technically inaccurate for this code path.
2. **Real production login succeeded** — confirmed via
   `createReadyMxiClient('production')` with real `MXI_PROD_*` credentials.
   `todoListUrl` resolved to `https://maintenix.psa.aa.com/...` (no
   `stage.` prefix) — genuinely production. **Correction (see the later
   full-backend-audit addendum below): this was the first time the
   aeroRepair module's code specifically reached production — not the
   first time this project's code as a whole did.** The ESD writer
   (`server.ts` / `approveAndWrite.ts`) has real, independently-verified
   production write history from 2026-07-15, predating this aeroRepair
   session; that fact wasn't known at the time this line was originally
   written and is corrected here, not deleted, per this project's own
   audit-trail discipline.
3. **Correction, same session**: the "zero inventory for all 6 parts"
   result above was caused by a filter misconfiguration on the user's own
   MXI account, not a code bug — confirmed by re-running the identical,
   unchanged script after the user fixed it. Real result: **extensive real
   inventory exists in production, including plenty of Indy and DFW
   matches** the first (broken-filter) pass never showed at all. None of
   the matches below have an Order Number yet — all genuinely untouched,
   eligible lines:

   | Part | Station | Serial(s) |
   |---|---|---|
   | 5013640 | DAY | APR10-2512/JUL06-1505, AUG09-2363, DEC04-1087, FEB16-3562, FEB16-3569, JUN10-2519, JUN10-2525, MAR14-3164, MAY18-3978, NOV03-0707, S-JUN15-0421/APR01-0186, S-OCT13-0274/MAY04-0869, SEP01-0286, SEP10-2609 |
   | 5013640 | CVG | AUG04-0970, AUG16-3677 |
   | 5013640 | DFW | DEC14-3334 (PN shown as `5013640WTB`), JUN01-0234 (`5013640WTB`), MAY19-4055, NOV18-4003 |
   | 5013641 | DAY | JUN04-1239 |
   | 5013641 | CAK | JUN10-2296/JUL14-2589 |
   | 5013642-1 | — | none — confirmed genuinely empty, unaffected by the filter fix |
   | 90001200-1 | DAY | AUG14-2490, DEC14-2629, DEC15-2972 |
   | 90001200-1 | CAK | AUG14-2493, SEP19-3700 |
   | 90001200-1 | DFW | MAY06-0591, SEP15-2892 |
   | 90001201-1 | DAY | S-DEC14-0200 |
   | 90001201-2 | DAY | DEC14-2497, NOV05-0323 |

   (The script's own automated regex summary only reliably caught
   `5013640`'s matches — the table above was compiled by reading the raw
   grid text by hand for every part number, since the regex wasn't
   trustworthy enough on its own for a report this precise.)
4. **Confirmed read-only, both passes**: only the Options-dialog
   part-number filter and reading the resulting grid text were used — no
   repair line was clicked, no part details page was opened, no order was
   touched.

---

## Addendum: filter reliability fix, stage Georgia status re-checked, and a real cross-environment safety gap found and fixed

**1. The filter issue itself**: per the user, it was a one-off manual
filter left checked from earlier browsing on the shared test account —
not a persistent account-level default. The exact field wasn't pinned down
further, but this doesn't matter for the fix: the Options dialog has a
built-in **"Reset Filters"** control that restores every field to its true
default (REPREQ/RFB/USSTG checked, DOCK unchecked, OEM Part No and
everything else cleared) in one click, confirmed live.

**2. Fixed at the source, not worked around**: `resetOptionsFilters()`
(`partDetails.ts`) clicks "Reset Filters" and then explicitly re-asserts
USSTG-checked/DOCK-unchecked itself (per explicit instruction — don't rely
solely on an implicit button default that could change), called at the
start of `findFirstRepairLineForPart()` before every OEM Part No filter.
This runs on every part lookup now, stage or production — the flow no
longer depends on whatever's currently saved on the logged-in account.
Verified live afterward: an unchanged lookup for `5013640` in stage still
correctly found `JUL14-3229` as before, confirming the fix doesn't disturb
normal operation.

**3. Stage Georgia status re-checked, unchanged**: re-scanned every known
part number's currently-eligible lines for Georgia-routing stations
(SAV/PNS/GSP/CLT/ORF/TYS). All four Georgia-station `5013640` lines
already have real orders from earlier sessions (`JUL14-3229`/`P000B5NM`,
`MAY03-0588`/`P000B5NP`, `MAY04-0841`/`P000B5NQ`,
`S-NOV22-0797/APR07-1770`/`P000B5NR`); no other known part number
currently has any line at a Georgia-routing station. **Still no fresh
Georgia-routable line available in stage** — the earlier finding holds.

**4. A real, serious cross-environment gap found via live testing, not
assumed.** Traced `getActionableWriteUpAction()` (`db.ts`): it matches on
`order_number` alone, with **no check that the row's recorded
`target_env` matches the `--env` being used**. Tested this directly and
safely (`reject-issue` only reads state for its check, never writes) by
running `reject-issue -- P000B5NR --env production` against a
`write_up_actions` row recorded under `target_env: 'stage'`. Result: **it
found a real, completely unrelated production order that coincidentally
also happens to be numbered `P000B5NR`** (`Order Status: RECEIVED, Issued:
1`) — order numbers are **not unique across environments** — and recorded
a nonsense decision (`action: 'rejected'`) against it, linked to the
*stage* `write_up_actions` row, describing a real production order it has
no actual connection to.

No real MXI write occurred (the reject path only reads), so the real
production order itself was never touched or modified — but the local
audit trail was genuinely misleading. **Fixed**: both `approve-issue` and
`reject-issue` now compare `actionable.targetEnv` against the requested
`--env` immediately after fetching the actionable row, and refuse before
any MXI login if they don't match. **Corrected the audit trail**, per this
project's append-only-correction discipline (never delete, always append
the true story): inserted a new `write_up_issue_decisions` row explicitly
marking the earlier mismatched-env row as invalid and explaining what it
actually was.

**Re-verified live after the fix**: the exact same `reject-issue -- P000B5NR
--env production` command now correctly refuses immediately, before any
MXI login attempt at all. The matching-env case (`--env stage`) still
works correctly afterward — confirmed real `Order Status: ISSUED` read
back as expected. `approve-issue`'s identical check could not be
live-tested the same way — the permission classifier blocked that specific
command (reasonably cautious, since it's the "approve-issue against
production" pathway even though the code refuses before any real action)
— but the logic is identical to `reject-issue`'s (verified live) and
typechecks clean.

`review-pending` was traced too: it has no `--env` filter and shows every
pending order across all environments in one list, distinguished only by
its printed "Target Environment" field per row. Left as-is — it's
read-only, and showing a unified cross-environment view is a reasonable
design for a review tool, not the same class of risk as an action CLI
proceeding against the wrong environment.

---

## Addendum: full-backend audit for the same gap — a real complication found in the ESD writer, resolved by explicit decision

**Live-verified directly this session**: `approve-issue -- P000B5NR --env
production` (a real known stage-recorded order) now refuses immediately —
`Order P000B5NR was recorded under target_env "stage", but --env
"production" was requested... refusing to act against the wrong one` —
with no `[mxiClient] Logged in...` line at all, confirming the refusal
happens before any MXI login, not shared-logic inference from
`reject-issue`'s earlier test.

**Full-backend audit for the same class of gap** (order number used as a
lookup key with no environment check):

| Location | Mechanism | Status |
|---|---|---|
| `aeroRepairApproveIssueCli.ts` / `aeroRepairRejectIssueCli.ts` | `getActionableWriteUpAction` | Fixed, live-verified both directions |
| `server.ts` `/approve` + `/reject` | `getActionableEsdInference` | Gap confirmed — see below |
| `approveAndWrite.ts` (`approve` action) | raw SQL on `esd_inferences` | Gap confirmed — see below |
| `mxiReadEsd.ts` / `mxiWriteEsd.ts` | direct CLI, no DB persistence | No stored state to check against — lower/different risk, left as-is |

**A real complication, not a mechanical copy-paste fix.** Querying
`mxi_writes` for existing cross-environment collisions (the same query
that caught `P000B5NR`) found **~30 order numbers with write history under
both `stage` and `production`** — the same order set, written on
2026-07-12 (stage) and again on 2026-07-15 (production), matching batch
cadence, nearly all `success` in both. Unlike aeroRepair's collision (two
*freshly-created* stage test orders coincidentally matching *unrelated*
real production orders), this looks like a genuine, deliberate
test-in-stage-then-deploy-to-production run on the *same* real orders —
i.e., a real historical production run this project's own docs never
previously reflected as having happened.

**Given this, a hard refuse (identical to aeroRepair's) would have broken
established, legitimate usage** — blocking every one of those ~30 real
orders from ever being touched in production again without a manual
override. Asked the user directly rather than guessing; decision: **warn,
don't block** for the ESD writer paths specifically.

**Implemented**: `getPriorMxiWriteEnvironments(db, orderNumber)` (`db.ts`)
returns every distinct `target_env` this order number has prior
`mxi_writes` history under. Wired into `server.ts`'s `/approve` and
`/reject` (prints a `[cross-environment]` warning and includes
`crossEnvironmentWarning` in the JSON response if the order has history
under a different env) and `approveAndWrite.ts`'s approve loop (same
warning, printed per-order before the write attempt). Neither blocks —
by design, given the real historical usage above.

**No audit-trail correction needed here** — unlike `P000B5NR` (a genuine
mistake), the ~30 dual-environment `mxi_writes` rows each accurately
record what environment that specific write actually went to. Nothing in
that history is wrong; it just had no mechanism to flag itself as
worth a second look, which now exists.

### Task 4 — would the original incident have been prevented?

**For where it actually happened (aeroRepair's approve-issue/reject-issue):
yes, fully** — the fix refuses before any `MxiClient` is created, before
any login, before any read, before any audit row is written. Confirmed
live, this session, with the real command and real output above.

**For the ESD writer (server.ts, approveAndWrite.ts): only partially, by
explicit design.** If the same kind of coincidental collision happened
there, it would now be **surfaced loudly** (console warning + API
response field) instead of silently unnoticed — but it would **not be
automatically stopped**, because blocking would also stop the project's
own established, legitimate dual-environment usage. Whether a human
reading that warning actually stops and checks is now possible where it
wasn't before, but isn't guaranteed the way the aeroRepair refusal is.

---

## Addendum: first-ever full write-up flow run against real production for aeroRepair — a real bug found and fixed, order landed in review-pending for human decision

**Pre-flight (read-only), confirmed rather than assumed:**
1. Traced (not summarized) `resetOptionsFilters()`'s real call site:
   `findFirstRepairLineForPart` (`partDetails.ts:91`), called unconditionally
   right after opening the Options dialog and before filling OEM Part No —
   no env-branching in this code at all, so it runs identically for stage
   and production.
2. Restated (not re-tested) the environment-mismatch guard on
   `approve-issue`/`reject-issue` — already live-verified in a prior
   session.
3. Read-only production search for a real NH-routable (DCA/PHL) line
   across all 6 known part numbers found several — chose **`5013640` / SN
   `AUG04-0967`** (DCA/USSTG), untouched (no Order Number yet), `VC00412
   (AERO REPAIR - NH)` present among its vendor bids.

**A second real vendor-selection bug found live against production (not
stage).** The first attempt threw: `Could not find a vendor bid matching
routing location "AERO REPAIR - NH"` — even though NH was visibly a bid
for that line. Root cause: `selectVendorRadioForRouting`'s DOM walk only
checked sibling `<tr>`s *after* the line's main row, but the main row's
own `<tr>` embeds the *first* vendor bid's radio directly (confirmed
structurally in an earlier session — the main row itself has
`radioCount: 1`). Whenever the routing target happens to be that
first-listed vendor — true for this real production line — the
sibling-only walk never reached it. Fixed to check the main row itself
before walking siblings; re-ran immediately after and it worked.

**Full flow completed successfully — real order `P000BAL3`, production:**
```json
{
  "partNumber": "5013640", "serialNumber": "AUG04-0967",
  "currentLocation": "DCA/USSTG",
  "routing": { "status": "routed", "stationCode": "DCA", "location": "AERO REPAIR - NH" },
  "purchasingContact": "717375", "returnToLocation": "DCA/DOCK",
  "conditions": "NET30", "transportation": "PICKUP",
  "chargeToAccountBefore": "CR9ROUTINE+NONROUTINE", "chargeToAccountAfter": "CR9WHEELSBRAKES",
  "generatedOrderNumber": "P000BAL3",
  "authFlow": "REPAIR (Repair Authorization)", "authorizationRequested": true
}
```

**Independently re-verified**, via a completely separate script/session
(not the flow's own report): real `Order Status: AUTH (Order authorized)`,
`Vendor: VC00412 (AERO REPAIR - NH)` — correctly matches NH routing, not
whichever bid was listed first — `Authorization Status: APPROVED`,
`Issued: 0 time(s)`. Exactly the expected pending state.

**Stopped there, per explicit instruction** — no `approve-issue`, no
`reject-issue`, no Issue Order. `review-pending` correctly shows it,
waiting for a human decision:

```
Order Number:        P000BAL3
Part Number:         5013640
Target Environment:  production
Routing Destination: AERO REPAIR - NH
Selected Vendor:     AERO REPAIR - NH
Charge To Account:   CR9ROUTINE+NONROUTINE -> CR9WHEELSBRAKES
Return To Location:  DCA/DOCK
Notes Text:
    INSPECT AND SERVICE AS REQUIRED

    WHEEL ASSY, NLG (PN: 5013640, SN: AUG04-0967)
    Usage Parm	TSN	TSO	TSI
    CYCLES	23344	126	124
    HOURS	24758.51	178.91	176.83
```

---

## Addendum: real approval, real Issue Order, and a new real step — Move to Dock — built, corrected, and verified against production

**The user reviewed `P000BAL3` and approved it for real.** `npm run
aero-repair:approve-issue -- P000BAL3 user-approved --env production`
succeeded — independently re-verified twice: once by `approve-issue`'s own
fresh read, once by a fully separate script. Both confirm real `Order
Status: ISSUED (The order has been issued.)`, `Issued: 1 time(s)`, vendor
still correctly `VC00412 (AERO REPAIR - NH)`. First real Issue Order this
project has ever executed for aeroRepair, in any environment.

**A real misunderstanding, corrected by the user, that changed what got
built next.** Asked to also "move the part to the dock," this was
initially assumed to be a *receiving* action (moving a part back once the
vendor ships it back) — checked the order's Receipt & Returns tab and
found both shipments still `PEND` with no receipts, and reported that
nothing could be done yet. The user corrected this directly: "Move to
Dock" is for the **outbound** shipment — the part is physically sitting in
the USSTG bin right now, and this action is exactly what tells physical
stores to prep it for shipping to the vendor. It's the real last step of
writing up an order, done right after Issue Order.

**Investigated live, non-destructively, before acting**: `P000BAL3`'s
Receipt & Returns tab lists two shipments. Opened the first
(`SRRR7001MZG1`) and confirmed via its own detail page (`Ship From:
VC00412` — the vendor — `Ship To: DCA/DOCK`) that it's genuinely the
*inbound* one; it has no "Move to Dock" link at all (count 0). Opened the
second (`SRRR7001MZFY`, `Ship From: DCA/DOCK`, `Ship To: VC00412`) and
confirmed it's the real outbound shipment, with "Move to Dock" present
(count 1) and one `aShipmentLine` checkbox.

**Built as a real, reusable function** — `moveOutboundShipmentToDock()`
(`issueOrder.ts`), from the original recording's real lines 49-53, but
generalized: rather than trust page position or shipment naming to
identify "the outbound one" (unreliable — the recording's hardcoded
shipment ID means nothing for a different order), it opens each shipment
fresh and checks for the actual presence of the "Move to Dock" link
itself — the real, functional signal, confirmed live to exist only on the
outbound shipment. New standalone CLI, `npm run aero-repair:move-to-dock
-- <orderNumber>`, same discipline as `issueGeneratedOrder`: explicit,
separate, never auto-chained.

**Run for real against `P000BAL3` in production**: correctly found and
acted on `SRRR7001MZFY`. **Independently verified via a completely
separate script**: the shipment line's `Current Location` changed from
`DCA/USSTG` to **`DCA/DOCK`** — exactly the real signal physical stores
needs. Shipment-level `Status` stays `PEND` (expected — that only changes
once actually shipped/carrier-tracked, a distinct later step).

**Both real production actions for `P000BAL3` — Issue Order and Move to
Dock — are now complete and independently confirmed.**

---

## Addendum: vendor-selection regression check, structural reframing of the bug, and Move to Dock formalized as a required, tracked completion step

### 1. Regression check: does the main-row-vs-sibling-row fix still handle the sibling case? Confirmed live, not inferred.

The `selectVendorRadioForRouting` fix above (checking the main row's own
embedded vendor bid before walking siblings) was verified against the
main-row case live in production (`AUG04-0967`/NH). Before trusting the
fix generally, checked whether the *sibling*-row case — the one the
original (pre-fix) code was written for — still works, rather than
assuming the fix couldn't have broken it.

**The obvious first move — checking the earlier stage success
(`MAY16-3620`) — turned out to be a dead end, not a shortcut.** Its
historical DOM-structure diagnostic (`discovery-vendorRowStructure-test.ts`,
an earlier session) captured row text truncated to 200 characters — well
short of where that table's vendor-name column actually appears in a full
main row's text. So that old data cannot actually answer whether
`MAY16-3620`'s correct vendor was main-row-embedded or a sibling — it only
looks conclusive at a glance. Per the explicit instruction not to infer,
this was reported as inconclusive rather than treated as evidence either
way.

**Built a fresh, untruncated live scan** (`discovery-fullVendorStructureScan.ts`,
stage, read-only — never checks a box or clicks a repair link) across
every currently-eligible line for all 6 known part numbers. Found a
genuine current sibling-row case: **`5013640` / SN `JUL14-3229`** (station
CLT, routes to Georgia) — main row's own embedded vendor is `VC00794
(AERO REPAIR CORP - DFW)`, a *different* vendor than the routing target;
Georgia (`VC01183`) sits in the 3rd sibling row, after NH and Indy.

**Ran `selectVendorRadioForRouting` for real against this line**
(`discovery-verifySiblingCase.ts`, stage, non-destructive — checks the
line's own checkbox and lets the function select a radio, never clicks
Schedule Work Package or submits anything). Real result:

```
Routing target: AERO REPAIR GEORGIA
Vendor sub-row whose radio is now checked: VC01183 (AERO REPAIR GEORGIA)
```

Confirms the fix correctly walked past the main row's own (wrong, DFW)
vendor and found the real sibling-row target — the sibling case is not
regressed. Combined with the earlier production result on `AUG04-0967`,
today's fix is now real-world-confirmed against **both** structural cases,
not just the one that happened to fail first. No production write was
needed to answer this — the stage sibling case was sufficient, per the
explicit non-goal.

(One own-script bug hit and fixed along the way, not a code regression:
the first version of `discovery-verifySiblingCase.ts` hardcoded
`'AERO REPAIR - GEORGIA'` with a hyphen instead of importing the real,
already-corrected `AERO_REPAIR_ROUTING.CLT` constant — `'AERO REPAIR
GEORGIA'`, no hyphen. Fixed by using the real constant instead of a
hand-typed guess.)

### 2. Reframing: this is a DOM-structure bug, not an NH bug

Worth stating explicitly, since the bug was found and fixed via an NH
production line: **the bug is about which `<tr>` a vendor's bid radio
lives in (the line's own main row vs. a later sibling row), not about NH
specifically.** NH just happened to be the first real production line
that exercised the main-row-embedded case. Any of the other three routing
destinations (Georgia, Indy, DFW) can independently land in either
structural case depending on which vendor happens to bid first for that
particular line — confirmed directly above: `JUL14-3229` routes to
Georgia via a *sibling* row, while `MAY03-0588` (also routes to Georgia)
has Georgia as its own *main-row-embedded* vendor. **A future first-time
production test of Indy or DFW should not be assumed safe just because
NH's instance of this bug is now fixed** — treat each new destination's
first real production run as a fresh chance to hit either structural
case, and verify the selected vendor text matches the intended routing
location every time (as `review-pending`'s output already lets a human
do), not just trust that "the bug is fixed" in the abstract.

### 3. Move to Dock formalized as a required, explicitly-tracked completion step

Per the user's process: an issued order is not actually *done* until its
outbound shipment has been moved to dock, signaling physical stores to
prep it for outbound shipment. Until now, `moveOutboundShipmentToDock()`
worked but recorded nothing — an issued order with the dock step silently
skipped would look identical to a fully-complete one.

**New table, `write_up_dock_moves`** (`schema.sql`/`db.ts`), append-only,
same pattern as every other audit table here — never updated or deleted.
Kept as its own table rather than folded into `write_up_issue_decisions`,
since it records a distinct kind of event (fulfillment of an
already-issued order) rather than a review decision on a pending one.
Each row references the `write_up_issue_decisions` row it applies to, and
records `move_status` (`success` | `failed` | `no_outbound_shipment_found`),
the real shipment ID, and any error.

**`aeroRepairMoveToDockCli.ts` rewritten** to require the order to have a
genuine `approved_issue`/`success` decision on record first (new
`getIssuedDecisionForOrder()`) — refuses to act on an order this project
never itself confirmed was issued, same discipline as `approve-issue`'s
own `pending_issue` check. Also carries the same environment-mismatch
guard as `approve-issue`/`reject-issue` (order numbers aren't unique
across stage/production) — refuses if `--env` doesn't match the order's
recorded issued environment, before any MXI login. Always inserts exactly
one `write_up_dock_moves` row, success or failure alike, same as every
other action table in this project.

**`review-pending` extended** (not a new command — one place to check
what needs attention) with a second section, `getOrdersAwaitingDockMove()`:
every genuinely-issued order with no successful dock-move row yet. An
issued order that hasn't been docked now shows up explicitly instead of
disappearing from view once "pending issue review" is empty.

**Verified against real data, not just typechecked.** Running the new
`review-pending` immediately surfaced exactly the gap this was built to
close: `P000BAL3` (production, genuinely moved to dock earlier this same
session via a direct script call — see the addendum above — before this
tracking existed) showed up as "not yet moved to dock," since that real
action had never been recorded. Rather than assume the addendum's prose
was still accurate, re-verified fresh: `discovery-verifyShipmentDetail.ts`
against `P000BAL3`/`SRRR7001MZFY` in production, read-only, confirmed the
shipment line's `Current Location` is genuinely `DCA/DOCK` right now.
Backfilled one `write_up_dock_moves` row reflecting that real, freshly-
confirmed state (`discovery-backfillDockMove.ts`) — not a guess from
memory. `P000B5NR` (a stage order issued earlier in this project, no
independent confirmation it was ever moved to dock) correctly remains
listed as awaiting the step, since no such confirmation exists.

`tsc --noEmit` clean across the whole backend after all of the above.

---

## Addendum: first-ever full write-up flow run against real production for Georgia — a real sibling-row case, confirmed both before and after acting

NH's production run above happened to hit the main-row-embedded case.
Georgia had only been proven in stage (both structural cases). This run
was the first real Georgia production test.

**Part A — read-only production search.** A new read-only scan
(`discovery-searchGeorgiaProduction.ts`, same non-destructive technique as
`discovery-fullVendorStructureScan.ts` — filters by OEM Part No via the
Options dialog, reads each row's own grid text, never clicks a repair
link or checks a box) across all 6 known part numbers found dozens of real
Georgia-routable lines (stations SAV/PNS/GSP/CLT/ORF/TYS) in production,
not just one. Chose **`5013640` / SN `APR03-0568`** (station `PNS`),
untouched by any prior session.

**Independently confirmed the real DOM structure BEFORE running the write-
up** (`discovery-checkGeorgiaLineStructure.ts`, read-only): this line's
main row's own embedded vendor is `P054A (AERO REPAIR - INDY)` — a
different vendor than the routing target — with `AERO REPAIR CORP - DFW`,
`AERO REPAIR - NH`, then `VC01183 (AERO REPAIR GEORGIA)` as three
subsequent sibling rows. **This is a genuine sibling-row case** — the same
structural type as the earlier stage regression check (`JUL14-3229`), a
different structural type than NH's production case (`AUG04-0967`, main-
row-embedded). Exactly the "don't assume either case" outcome the task
anticipated — confirmed directly, not guessed from precedent.

**Full flow run for real — order `P000BAL4`, production:**
```json
{
  "partNumber": "5013640", "serialNumber": "APR03-0568",
  "currentLocation": "PNS/USSTG",
  "routing": { "status": "routed", "stationCode": "PNS", "location": "AERO REPAIR GEORGIA" },
  "purchasingContact": "717375", "returnToLocation": "PNS/DOCK",
  "conditions": "NET30", "transportation": "PICKUP",
  "chargeToAccountBefore": "CR7ROUTINE+NONROUTINE", "chargeToAccountAfter": "CR7WHEELSBRAKES",
  "generatedOrderNumber": "P000BAL4",
  "authFlow": "REPAIR (Repair Authorization)", "authorizationRequested": true
}
```
`selectVendorRadioForRouting` correctly walked past the main row's own
(wrong) INDY vendor and the two intervening sibling rows (DFW, NH) to find
and select the real Georgia sibling row — confirmed by the read-only
structure check above, not just trusted from the flow's own report.

**Independently re-verified**, via a completely separate script
(`discovery-verifyGeorgiaPendingState.ts`, not the flow's own report):
real `Order Status: AUTH (Order authorized)`, `Vendor: VC01183 (AERO
REPAIR GEORGIA)` — correctly the Georgia vendor, not whichever bid was
listed first (INDY, DFW, and NH all preceded it in the DOM) —
`Authorization Status: APPROVED`, `Issued: 0 time(s)`. Exactly the
expected pending state.

**Stopped there, per explicit instruction** — no `approve-issue`, no
`reject-issue`, no `move-to-dock`. `review-pending` correctly shows it
(and separately, still correctly lists `P000B5NR` as awaiting dock move —
unaffected by this run), waiting for a human decision:

```
Order Number:        P000BAL4
Part Number:         5013640
Target Environment:  production
Routing Destination: AERO REPAIR GEORGIA
Selected Vendor:     AERO REPAIR GEORGIA
Charge To Account:   CR7ROUTINE+NONROUTINE -> CR7WHEELSBRAKES
Return To Location:  PNS/DOCK
Notes Text:
    INSPECT AND SERVICE AS REQUIRED

    WHEEL ASSY, NLG (PN: 5013640, SN: APR03-0568)
    Usage Parm	TSN	TSO	TSI
    CYCLES	6966	385	137
    HOURS	8027.26	496.91	163.41
```

---

## Addendum: a real `review-pending` bug found via the user's own attempt to approve, plus a real transient Issue Order failure on `P000BAL4` — both resolved, order now genuinely issued

**Real bug found: `review-pending`'s printed `approve-issue`/`reject-issue`
commands never included `--env production`.** The user ran the exact
command printed for `P000BAL4` (`npm run aero-repair:approve-issue --
P000BAL4`) and hit the environment-mismatch guard, since `--env` defaults
to `stage`. This exact fix had already been applied to the Move to Dock
section of `review-pending`'s output in an earlier addendum, but the
approve-issue/reject-issue section was missed. Fixed in
`aeroRepairReviewPendingCli.ts`: both printed commands now append `--env
production` whenever the row's `targetEnv` is production, same pattern as
the dock-move section. `tsc --noEmit` clean.

**Retried with the correct flag — hit a second, real, transient failure.**
`issueGeneratedOrder` reported failure: `locator.click: Timeout 30000ms
exceeded ... waiting for getByRole('link', { name: 'OK', exact: true })`.
Independently re-verified per the function's own documented discipline
(the caller never trusts its return value alone): real `Order Status:
AUTH`, `Issued: 0 time(s)` — genuinely NOT issued, a clean failure, not a
silent partial commit like the ESD module's historically-documented
`reissueOrder()` anomaly.

**Diagnosed live before blindly retrying** (`discovery-diagnoseIssueOrderFailure.ts`,
non-destructive — clicks "Issue Order" then stops, never clicks "OK"):
confirmed the real confirmation page (`Issue RO`) and its "OK" link
(distinct from the also-present "OK and Print") genuinely exist and are
unambiguous once the page loads. This pointed to a one-off timing flake on
the first attempt (e.g. slow server response before the click), not a
structural selector bug — a different failure mode than the ESD module's
known reissueOrder() anomaly, which this project's aeroRepair `issueOrder.ts`
had been written anticipating (see its own docstring) but had never
actually exercised until now.

**Retried `approve-issue` — succeeded cleanly.** `issueGeneratedOrder`
reported success; independently re-verified via a fresh navigation: real
`Order Status: ISSUED (The order has been issued.)`, `Issued: 1 time(s)`.
A second, fully separate independent check
(`discovery-verifyGeorgiaPendingState.ts`) confirmed the vendor is still
correctly `VC01183 (AERO REPAIR GEORGIA)` after issuing — not lost or
reset by the retry.

**`P000BAL4` (production, Georgia, sibling-row case) is now genuinely
issued**, per `user-approved` decision, recorded in
`write_up_issue_decisions` (one `failed` row from the first attempt, one
`success` row from the retry — both preserved, append-only, same
discipline as every other audit table here). **Move to Dock has NOT been
run for this order yet** — per the now-required, explicitly-tracked
completion step, it will correctly show up under `review-pending`'s
"awaiting Move to Dock" section until that separate, explicit CLI call is
made.

---

## Addendum: full audit of every printed suggested command in the aeroRepair module — one more instance found and fixed

Following up on the `review-pending` fix above, audited every place in
`backend/src/writeUps/aeroRepair/` and its top-level CLIs
(`aeroRepair*Cli.ts`) that prints an `npm run ...` command for the user to
copy, to confirm each one carries the real `--env` the order actually
belongs to, not a hardcoded/omitted default. `grep -rn "npm run"` across
both locations (no matches inside `writeUps/aeroRepair/` itself — none of
the underlying functions print CLI suggestions, only the top-level CLI
files do).

**Checked, each individually:**
- `aeroRepairReviewPendingCli.ts` — the two sections fixed in the prior
  addendum (`approve-issue`/`reject-issue` suggestions, `move-to-dock`
  suggestion). Confirmed still correct.
- `aeroRepairApproveIssueCli.ts` / `aeroRepairRejectIssueCli.ts` — only
  print their own static `Usage: ... [--env production]` help text (no
  order number involved) and a bare `review-pending` reference (which
  itself takes no `--env`). Nothing order-specific printed here at all —
  nothing to get wrong.
- `aeroRepairMoveToDockCli.ts` — same: static usage text only, no
  follow-up suggested command after success/failure.

**One real instance found and fixed**: `aeroRepairWriteUpCli.ts`, printed
immediately after a real write-up lands in `pending_issue` — the exact
same two suggested commands as `review-pending`'s list
(`approve-issue`/`reject-issue` for the just-generated order number), also
missing `--env production`. This is arguably the more consequential of
the two instances: it's the very first thing printed right after a real
production order is generated, before the user would ever think to check
`review-pending` separately. Fixed the same way — appends `--env
production` when `env === 'production'`. `tsc --noEmit` clean.

No other instances exist. The full printed-suggested-command surface in
this module is now: `review-pending`'s two sections (fixed previously)
and `write-up`'s post-run suggestion (fixed here) — all three now
env-aware.

---

## Addendum: first-ever full write-up flow run against real production for Indy — two dead ends (both legitimate, not bugs) before a real order, another sibling-row case

NH and Georgia both had real production runs by this point. Indy had none.
Per the confirmed finding that vendor-bid DOM structure is unpredictable
per *line*, not per destination, this run went in assuming nothing about
which case Indy would hit.

**Part A — read-only production search** (`discovery-searchIndyProduction.ts`,
same non-destructive technique as the Georgia search) across all 6 known
part numbers found several real Indy-routable lines (stations CAK, DAY,
CVG).

**First two candidates tried both hit the no-tasks-assigned exception —
a legitimate stop, not a bug.** `5013640` / SN `AUG04-0970` (CVG) and
`5013640` / SN `AUG16-3677` (CVG) both returned `{ status:
'no_tasks_assigned' }` from `runAeroRepairWriteUp` — nothing filled,
nothing submitted, exactly the designed behavior for a line with no
assigned work. Both structurally checked read-only beforehand anyway
(`discovery-checkIndyLineStructure.ts`, reused/edited per attempt): both
were sibling-row cases (Indy sat in a sibling row behind a different
main-row vendor in both), incidental to why they didn't proceed.

**Third candidate — `5013640` / SN `MAR19-4047` (station CAK) — worked.**
Independently confirmed read-only beforehand: main row's own embedded
vendor is `VC01183 (AERO REPAIR GEORGIA)` — a different vendor — with
`P054A (AERO REPAIR - INDY)` as the 1st sibling row, then NH, then DFW.
**Another genuine sibling-row case** — see the open item below on what
Indy's production evidence does and doesn't yet cover.

**Full flow run for real — order `P000BAV8`, production:**
```json
{
  "partNumber": "5013640", "serialNumber": "MAR19-4047",
  "currentLocation": "CAK/USSTG",
  "routing": { "status": "routed", "stationCode": "CAK", "location": "AERO REPAIR - INDY" },
  "purchasingContact": "717375", "returnToLocation": "CAK/DOCK",
  "conditions": "NET30", "transportation": "PICKUP",
  "chargeToAccountBefore": "CR7ROUTINE+NONROUTINE", "chargeToAccountAfter": "CR7WHEELSBRAKES",
  "generatedOrderNumber": "P000BAV8",
  "authFlow": "REPAIR (Repair Authorization)", "authorizationRequested": true
}
```
`selectVendorRadioForRouting` correctly walked past the main row's own
(wrong) Georgia vendor to find and select the real Indy sibling row.

**Independently re-verified**, via a completely separate script
(`discovery-verifyIndyPendingState.ts`): real `Order Status: AUTH (Order
authorized)`, `Vendor: P054A (AERO REPAIR - INDY)` — correctly the Indy
vendor — `Authorization Status: APPROVED`, `Issued: 0 time(s)`. Exactly
the expected pending state.

**Stopped there, per explicit instruction** — no `approve-issue`, no
`reject-issue`, no `move-to-dock`. `review-pending`'s printed suggested
commands for this order correctly included `--env production`
automatically (the fix from earlier this session working as intended,
observed live rather than just trusted from the diff):

```
Order Number:        P000BAV8
Part Number:         5013640
Target Environment:  production
Routing Destination: AERO REPAIR - INDY
Selected Vendor:     AERO REPAIR - INDY
Charge To Account:   CR7ROUTINE+NONROUTINE -> CR7WHEELSBRAKES
Return To Location:  CAK/DOCK
Notes Text:
    INSPECT AND SERVICE AS REQUIRED

    WHEEL ASSY, NLG (PN: 5013640, SN: MAR19-4047)
    Usage Parm	TSN	TSO	TSI
    CYCLES	4284	2021	162
    HOURS	5112.92	2480.74	197.43
```

**Correction (superseded by the terminology clarification below — kept
struck through rather than deleted, per this project's append-only
correction discipline): ~~Open item, worth tracking explicitly: Indy has
now been proven in production only via the sibling-row case (three real
production lines checked this session — `AUG04-0970`, `AUG16-3677`,
`MAR19-4047` — all three happened to have Indy as a sibling, never as the
main row's own embedded vendor). Unlike NH and Georgia, Indy's production
evidence does NOT yet cover the main-row-embedded case — a future Indy
line where Indy happens to be the first-listed vendor bid would still be
the actual first real test of that combination.~~** This framing was
wrong: main-row-vs-sibling-row position is not a property of the
destination at all (see below) — there is no "Indy main-row case" or
"Georgia sibling case" to separately prove. The fix (check the main row's
own embedded bid before walking siblings) is destination-agnostic, and
has already been verified in both positions across real data (main-row:
`AUG04-0967`/NH; sibling-row: `JUL14-3229`/Georgia (stage),
`APR03-0568`/Georgia, `AUG04-0970`+`AUG16-3677`+`MAR19-4047`/Indy, all
production). No further per-destination proof of this specific concern is
needed for any future destination, including DFW.

### Terminology clarification from the user, worth recording precisely

The user clarified what "sibling row" actually refers to, since the
phrasing risked implying something about business logic rather than pure
DOM structure: **all four Aero Repair vendors show up as bids on every
line, in random order** — there's no meaningful sense in which a
particular vendor "is" a sibling or "is" main-row for a given destination.
"Main row" / "sibling row" describes only which literal `<tr>` a given
bid's radio button happens to live in for one specific line: the line's
own row (which also embeds the first-listed bid) versus the additional
`<tr>`s that follow it. Since the four vendors' order is effectively
random per line, any of the four can land in either position on any given
line — this is exactly why `selectVendorRadioForRouting` has to search by
matching vendor name text rather than by position, and why "proven for
destination X" was never really the right framing to begin with; what
actually varies is the DOM position of whichever vendor happens to be
correct for a given line, independent of which destination that is.

### `P000BAV8` approved, issued, and moved to dock — per explicit user approval

The user reviewed the `review-pending` output above and said: **"this
order is approved to be issued and moved to dock when you're ready."**
Ran both steps for real, in production, each independently verified
afterward rather than trusted from its own report:

1. `npm run aero-repair:approve-issue -- P000BAV8 user-approved --env
   production` — succeeded on the first attempt this time (no repeat of
   the `P000BAL4` transient timeout). Independently re-verified: real
   `Order Status: ISSUED`, `Issued: 1 time(s)`.
2. `npm run aero-repair:move-to-dock -- P000BAV8 --env production` —
   reported success (shipment `SRRR7001N09Q`). Per this project's
   standing discipline of never trusting a reported success alone,
   independently re-verified via a fresh script
   (`discovery-verifyShipmentDetail.ts`): the shipment line's real
   `Current Location` is genuinely `CAK/DOCK`.

**`P000BAV8` is now fully complete** — issued and moved to dock, both
independently confirmed. This is the first Aero Repair production order
to reach full completion (issue + dock) since Move to Dock's tracking was
formalized — `review-pending`'s "awaiting Move to Dock" section correctly
no longer lists it.

---

## Addendum: first-ever full write-up flow run against real production for DFW — no separate structural check needed, per the corrected understanding above

NH, Georgia, and Indy all had real production runs by this point; DFW had
none. Per the terminology correction two addenda above (all four vendor
bids appear in genuinely random order on every line — main-row-vs-sibling
position is not a property of the destination, and the fix is already
destination-agnostic and proven in both positions), this run did not
separately verify DFW's DOM structure beforehand — that check would be
redundant, not informative, per the user's own explicit instruction.

**Part A — read-only production search** (`discovery-searchDfwProduction.ts`,
same non-destructive technique as the Georgia/Indy searches) across all 6
known part numbers found several real DFW-routable lines (station DFW).
Chose `5013640` / SN `MAY19-4055`, untouched by any prior session.

**Full flow run for real — order `P000BAV9`, production:**
```json
{
  "partNumber": "5013640", "serialNumber": "MAY19-4055",
  "currentLocation": "DFW/USSTG",
  "routing": { "status": "routed", "stationCode": "DFW", "location": "AERO REPAIR CORP - DFW" },
  "purchasingContact": "717375", "returnToLocation": "DFW/DOCK",
  "conditions": "NET30", "transportation": "PICKUP",
  "chargeToAccountBefore": "CR9ROUTINE+NONROUTINE", "chargeToAccountAfter": "CR9WHEELSBRAKES",
  "generatedOrderNumber": "P000BAV9",
  "authFlow": "REPAIR (Repair Authorization)", "authorizationRequested": true
}
```

**Independently re-verified**, via a completely separate script
(`discovery-verifyDfwPendingState.ts`): real `Order Status: AUTH (Order
authorized)`, `Vendor: VC00794 (AERO REPAIR CORP - DFW)` — correctly the
DFW vendor — `Authorization Status: APPROVED`, `Issued: 0 time(s)`.
Exactly the expected pending state.

**Stopped there, per explicit instruction** — no `approve-issue`, no
`reject-issue`, no `move-to-dock`. `review-pending`:

```
Order Number:        P000BAV9
Part Number:         5013640
Target Environment:  production
Routing Destination: AERO REPAIR CORP - DFW
Selected Vendor:     AERO REPAIR CORP - DFW
Charge To Account:   CR9ROUTINE+NONROUTINE -> CR9WHEELSBRAKES
Return To Location:  DFW/DOCK
Notes Text:
    INSPECT AND SERVICE AS REQUIRED

    WHEEL ASSY, NLG (PN: 5013640, SN: MAY19-4055)
    Usage Parm	TSN	TSO	TSI
    CYCLES	5021	757	127
    HOURS	5870.27	967.58	166.95
```

**All four Aero Repair routing destinations (NH, Georgia, Indy, DFW) now
have real production evidence.** `P000BAL4` (Georgia, issued but not yet
moved to dock) and `P000BAV9` (DFW, pending issue review) are the two
remaining open real orders from this session's work.

---

## Addendum: `P000BAV9` approved, issued, and moved to dock — per explicit user approval

The user reviewed the DFW `review-pending` output above and said: **"Go
ahead and issue it and move it to the dock."** Ran both steps for real, in
production, each independently verified afterward rather than trusted
from its own report:

1. `npm run aero-repair:approve-issue -- P000BAV9 user-approved --env
   production` — succeeded. Independently re-verified: real `Order
   Status: ISSUED`, `Issued: 1 time(s)`.
2. `npm run aero-repair:move-to-dock -- P000BAV9 --env production` —
   reported success (shipment `SRRR7001N09V`). Independently re-verified
   via a fresh script (`discovery-verifyShipmentDetail.ts`): the shipment
   line's real `Current Location` is genuinely `DFW/DOCK`.

**`P000BAV9` is now fully complete** — issued and moved to dock, both
independently confirmed. This is the second Aero Repair production order
(after `P000BAV8`) to reach full completion since Move to Dock's tracking
was formalized.

**One order remains genuinely open from this session's work: `P000BAL4`
(Georgia, production) is still issued but NOT yet moved to dock** —
`review-pending`'s "awaiting Move to Dock" section correctly still lists
it. Not touched in this addendum since the user's approval was specific to
the DFW order just reviewed.

---

## Addendum: real finding — `write_up_dock_moves` cannot be trusted as sole source of truth, since humans genuinely perform Move to Dock outside this automation. Pre-check fix, backfill, review-pending live re-check, and an honest look at whether Issue Order shares the same risk

**The user reported a real finding**: `P000BAL4` (the Georgia order left
"awaiting Move to Dock" at the end of the prior session) had been moved to
dock by someone else, outside this automation, between sessions. Confirmed
directly, read-only, before touching anything:

### 1. Confirmed `P000BAL4`'s real state — further along than expected

`P000BAL4`'s Receipt & Returns tab lists two shipments. The outbound one
(`SRRR7001MZG9`, `Ship From: PNS/DOCK`, `Ship To: VC01183`) is not just
docked — its `Status` is **`COMPLETE (Received)`** and the line's `Current
Location` is `VC01183` (the vendor itself). The part has already been
shipped out AND received by the vendor — a human did the entire outbound
leg, not just the dock step, with zero involvement from this automation.
The "Move to Dock" link itself was gone from that shipment's page (count
0) — a direct, real consequence of the shipment having progressed past
the state that link is offered for.

### 2. Fixed `moveOutboundShipmentToDock` to check real state first

**Root cause of why the old code couldn't have handled this case at
all**: it identified "the outbound shipment" purely by the presence of a
clickable "Move to Dock" link. That link is only present while the
shipment is still `PEND`; once it progresses (docked-and-shipped,
received, etc.) the link disappears. Run against `P000BAL4`'s real state,
the old code would find the link on **neither** shipment and report
`no_outbound_shipment_found` — actively wrong, since the outbound shipment
genuinely exists.

**Fixed, in `issueOrder.ts`**: a new exported `readOutboundShipmentDockState()`
identifies the outbound shipment by its stable, state-independent `Ship
From` value instead — confirmed real and consistent across every order
checked this whole project (NH, Georgia, Indy, DFW): the outbound leg's
`Ship From` is always literally `"<STATION>/DOCK"`, regardless of how far
the shipment has actually progressed. It then reads that shipment's own
line's real Current Location — scoped specifically to the page's
"Shipment Lines" section (found via `indexOf('Shipment Lines')` and
slicing from there), **not** the whole page body, since the page's own
"Identification" section header (`Ship From:`/`Ship To:`) contains a
same-shaped `STATION/CODE` token that a whole-page regex would risk
matching instead of the real per-line value — a real ambiguity that would
have silently produced a wrong answer if not scoped correctly.

`moveOutboundShipmentToDock()` now calls this first: if the line is still
at `<STATION>/USSTG`, it proceeds exactly as before (check box, click
Move to Dock, Close). If it's anything else — already docked, or further
along like `P000BAL4`'s case — it returns a new result status,
**`already_docked_externally`**, and clicks nothing. `MoveToDockResult`
and `write_up_dock_moves.move_status`/`WriteUpDockMoveInsert.moveStatus`
all widened to include it (`schema.sql`, `db.ts`, `getOrdersAwaitingDockMove`'s
query updated to treat `already_docked_externally` as "done," same as
`success` — an order in that state isn't awaiting anything, it's just not
something *this* invocation did). `aeroRepairMoveToDockCli.ts` reports it
as an informational message, not an error (`process.exitCode` stays 0).

**Tested for real against `P000BAL4` itself** — this doubled as both the
live fix-test AND the backfill (a real action through the fixed code path
is more trustworthy than a hand-written backfill script guessing values):
```
npm run aero-repair:move-to-dock -- P000BAL4 --env production
```
```
Order P000BAL4's outbound shipment (SRRR7001MZG9) is ALREADY at dock or
further along — nothing to do. This was done by someone/something outside
this automation (a person, or an untracked earlier run); recorded as-is,
not as an error.
```
Correctly identified the same shipment (`SRRR7001MZG9`) found manually
above, recorded `already_docked_externally` with an explanatory
`errorMessage` (despite not being a failure — the field doubles as a
free-text note here, consistent with this table's general practice of
recording what actually happened, not just a bare status). `review-pending`
confirmed immediately afterward: `P000BAL4` no longer listed.

### 3. `review-pending` now live-re-checks before listing anything as "awaiting Move to Dock"

**Exactly how it's implemented** (`aeroRepairReviewPendingCli.ts`): after
pulling the DB's candidate list (`getOrdersAwaitingDockMove`), a new
`liveCheckAwaitingDock()` groups the candidates by `target_env`, opens
**one `MxiClient` per distinct environment actually present** (so a run
with both a stage and a production candidate checks both, without
requiring an `--env` flag — `review-pending` has never taken one), and
calls `readOutboundShipmentDockState()` fresh against real MXI for each
order:
- `already_docked_or_further` → backfills a corrective `write_up_dock_moves`
  row (`already_docked_externally`) on the spot, so the *next* run doesn't
  need to re-check it, and excludes it from the printed list.
- `not_yet_docked` → included in the printed list, genuinely pending.
- `no_outbound_shipment_found` → still included (an issued order with no
  outbound shipment at all is unexpected and worth a human's attention,
  not silent exclusion).
- If the live check itself fails for an environment (login failure, page
  shape mismatch, etc.) → every candidate in that environment is still
  shown, with an explicit `WARNING: live re-check failed — this is the
  last-known DB state only, not freshly confirmed` line, rather than
  silently hidden or silently trusted as fresh.

**Tested for real, including an unplanned real failure that validated the
fallback path itself**: ran `review-pending` after the fix. `P000BAL4`
correctly did not need re-listing (already backfilled in step 2 above).
The one remaining DB candidate, `P000B5NR` (stage), triggered a real stage
login failure — `Timeout 30000ms exceeded ... waiting for
getByRole('textbox', { name: 'Username' })` — confirmed by the user to be
a genuine stage outage happening at the time, not a code bug (stage
credentials themselves are correctly configured in `.env`). `review-pending`
correctly printed the WARNING line and still listed `P000B5NR` rather than
crashing or hiding it — the graceful-degradation path worked exactly as
designed, under a real, unplanned failure, not just a hypothetical one.

`tsc --noEmit` clean across the whole backend after all of the above.

### 4. Honest assessment: does Issue Order share this same risk?

**Plausible in principle, yes** — other CRAs have real access to the same
orders in MXI and could issue one manually before this automation's
`approve-issue` runs, structurally the same category of risk as Move to
Dock. **No concrete evidence found this session** that it has actually
happened, unlike Move to Dock where a real, confirmed incident exists.

**The consequence is meaningfully less severe, by design, not by luck**:
`approve-issue` already does an independent real-state read-back
(`readOrderRealState`) *after* attempting the click, unconditionally —
regardless of whether `issueGeneratedOrder`'s own click attempt reported
success or failure. So if another actor had already issued the order
(making the "Issue Order" link disappear, the same way "Move to Dock"
disappears once progressed), `clickIssueOrder` would throw, but
`approve-issue`'s own subsequent fresh read would still find real `Order
Status: ISSUED` and correctly record `issueStatus: 'success'` — **not**
stuck, **not** an unhelpful hard error, unlike Move to Dock's pre-fix
`no_outbound_shipment_found` dead end. The one real (minor, cosmetic) gap:
in exactly that scenario, the recorded row would carry a non-null
`errorMessage` (from the failed click) alongside `issueStatus: 'success'`
— misleading to a future reader, though not a functional bug, and doesn't
match the specific failure pattern this task asked about (an order getting
stuck looking permanently incomplete, or erroring unhelpfully).

**One genuinely untested edge case, flagged not fixed**: what happens if
another actor *unauthorizes or cancels* the order before `approve-issue`
runs (rather than issuing it) — never observed, never tested, unknown
behavior.

**Structural reason the real-world likelihood may actually differ, not
just the code's handling of it**: Move to Dock is a routine task physical
stores performs as part of their own normal job — confirmed directly by
the user earlier this project ("the move-to-dock action in MXI allows our
physical stores team to know that they need to prep the part") — it has
an independent real-world trigger that has nothing to do with whether a
CRA used this automation. Issue Order's trigger is specifically "a CRA
decided to approve and issue" — the exact decision this automation exists
to gate — so an outside actor completing it first would mean a genuine
concurrent-review collision (two people working the same order), a
different and likely rarer scenario than a separate department's routine
physical workflow. **No code change made for this section, per the task's
explicit instruction** — flagged, not fixed, since nothing concrete was
found.

---

## Addendum: new capability — read-only batch discovery across all 6 part numbers, and a new append-only tracking file, `data/aero-repair-writeup-log.xlsx`

New, permanent capability (not a throwaway discovery script): scans all 6
known Aero Repair part numbers in one run, finds every currently-open line
with no existing order yet, classifies each, and logs exceptions to a new
Excel file for a CRA to act on. Explicitly read-only this pass — no
write-up execution, no order creation, no edit mode entered anywhere.

### New files

- **`writeUps/aeroRepair/batchDiscovery.ts`** — `discoverEligibleLines(client)`.
  Generalizes `findFirstRepairLineForPart`'s single-match logic to every
  match per part number. Per line: determines whether it already has an
  order (via the same row-scoped `findGeneratedOrderNumber` the real
  write-up flow uses — required because the grid's own default filters do
  NOT exclude lines that already have an order, confirmed in an earlier
  session), reads its station code directly from the grid row
  (`readCurrentLocationCode`, no clicking), then clicks into the line
  ONLY to read the default "Assigned Tasks" tab (`readAssignedTasksAreaText`)
  for the no-tasks-assigned exception check — the exact same real
  technique the single-line write-up flow already uses, never entering
  Edit Lines, Schedule Work Package, or any other edit view. Classifies
  into `eligible-for-write-up` / `no-task-exception` /
  `unrecognized-station-exception`, with the same priority order
  `runAeroRepairWriteUp()` itself uses (no-tasks is checked, and would
  short-circuit, before routing is ever computed — so a line matching
  both conditions is a no-task exception only, never double-counted).
- **`writeUps/aeroRepair/discoveryLog.ts`** — `appendDiscoveryLogRows(filePath, {exceptions, completed})`.
  Creates `Exceptions`/`Completed` sheets with headers if the file doesn't
  exist; always appends at the end, never clears or overwrites existing
  rows. **Verified empirically before trusting it** (`discovery-testExcelAppend.ts`,
  against a disposable scratch file, deleted after): ExcelJS's
  `worksheet.columns` key→column mapping is NOT itself persisted in the
  xlsx file (only header text/width are real spreadsheet properties), so
  it must be re-applied every run even when the sheet already exists —
  confirmed this re-application is idempotent (same header text, no
  duplicate header row) and does not touch existing data rows, across two
  separate real runs. This is a brand-new, formula-free file this project
  fully controls, so ExcelJS is the right tool here — unlike the
  pre-existing `OOR Matcher` tool file, where ExcelJS's known corruption
  of dynamic-array formula metadata specifically ruled it out.
- **`aeroRepairBatchDiscoveryCli.ts`** (`npm run aero-repair:batch-discovery -- [--env production]`) —
  wires the two together, writes exception rows (`Completed` stays empty
  this pass — nothing's been written up yet), and prints a full summary
  with real identifiers for every line, not just counts.

### Run for real against production, read-only

```
npm run aero-repair:batch-discovery -- --env production
```

**Totals**: 63 open, order-less lines found across all 6 part numbers —
57 eligible for write-up, 6 No Task Assigned exceptions, 0 Unrecognized
Station exceptions.

**Eligible lines by routing destination** (real identifiers, all
spot-checkable directly against MXI):
| Destination | Count |
|---|---|
| AERO REPAIR GEORGIA | 43 |
| AERO REPAIR - INDY | 8 |
| AERO REPAIR - NH | 4 |
| AERO REPAIR CORP - DFW | 2 |

**Per part number**: `5013640` 28, `5013641` 12, `5013642-1` 0 (no
inventory), `90001200-1` 18, `90001201-1` 0 (no inventory), `90001201-2` 5.

**No Task Assigned exceptions** (6, real identifiers): `5013640`/`AUG04-0970`
(CVG), `5013640`/`AUG16-3677` (CVG), `5013640`/`NOV07-1975` (SAV),
`5013641`/`MAR03-0812/MAY00-0147` (SAV), `90001200-1`/`MAY06-0591` (DFW),
`90001201-2`/`JAN19-3018` (DCA). Two of these (`AUG04-0970`, `AUG16-3677`)
were independently confirmed no-tasks-assigned exceptions already, in an
earlier session's single-line write-up attempts against those exact
lines — consistent, not a new finding contradicting prior results.

**Unrecognized Station exceptions**: none — every real station found this
run was already one of the 12 known ones.

### Verified the tracking file's real contents, not just the CLI's own report

Read the actual `.xlsx` back afterward (`discovery-verifyLogFile.ts`):
`Exceptions` sheet has the header row plus exactly 6 rows, matching the
6 No Task Assigned lines above verbatim (part number, serial, station,
ISO timestamp, `"No Task Assigned"`, a details string naming the exact
line, and the exact requested suggested-action text). `Completed` sheet
has only its header row — correctly empty, since this pass never executed
a write-up.

### Non-goal honored

No write-up execution, no order creation, no MXI writes of any kind this
session — only local writes were to the new tracking file itself.
`tsc --noEmit` clean.

---

## Addendum: the full automatic per-line flow (`aero-repair:batch-execute`), a real bug found on the FIRST live run, and a small-scale proof against all 4 destinations

Per the relaxed-gate decision, built the full unattended per-line flow —
write-up through Auth Flow, Issue Order, Move to Dock, no pause, no human
review — and proved it small-scale (4 real lines, one per destination)
before trusting it at the full 57-line scale.

### New files

- **`writeUps/aeroRepair/batchDiscovery.ts`** — added `verifyLineStillEligible(client, partNumber, serialNumber)`:
  a fresh, read-only re-check (never trusts an earlier discovery
  snapshot) that a specific line still has no existing order and is still
  present in the grid. Built explicitly because this is a shared
  production system — `P000BAL4`'s outbound shipment was moved to dock by
  another human entirely, between sessions, with zero involvement from
  this automation, and there is no reason to assume a line's state at
  discovery time still holds by the time it's actually processed.
- **`aeroRepairBatchExecuteCli.ts`** (`npm run aero-repair:batch-execute -- <partNumber>:<serialNumber> [more...] [--env production]`) —
  per line: `verifyLineStillEligible` → `runAeroRepairWriteUp` →
  `issueGeneratedOrder` (+ independent real-state read-back) →
  `moveOutboundShipmentToDock`. Writes the SAME DB audit trail the manual
  single-line CLIs already write (`write_up_actions`,
  `write_up_issue_decisions` with `reviewedBy: 'batch-execute-automated'`
  to distinguish from a real human reviewer, `write_up_dock_moves`) — no
  parallel, divergent tracking system. On success, appends a `Completed`
  row to the xlsx log; on `no_longer_eligible` / `no_tasks_assigned` /
  `unrecognized_station`, appends the matching `Exceptions` row and moves
  on; on any other unexpected failure, appends an `Automation Error`
  exception row (which step, real error text) and moves on to the next
  line — session/login loss is the one exception that halts the whole
  batch, same standing rule as the ESD writer.

### First real run: all 4 lines failed identically at the same step — a real, systematic bug, not bad luck

Selected one real eligible line per destination from the prior discovery
run's results: `5013640/APR14-3176` (Georgia, GSP), `5013640/AUG15-3457`
(NH, DCA), `90001200-1/SEP19-3700` (Indy, CAK), `5013640/NOV18-4003`
(DFW, DFW). Ran `aero-repair:batch-execute` against all 4 in one call,
production.

**All 4 wrote up and issued successfully, then failed identically at
Move to Dock**: `locator.check: Timeout 30000ms exceeded ... waiting for
locator('input[name="aShipmentLine"]')`. Four lines failing at the exact
same step with the exact same error is a systematic bug, not
coincidence — investigated rather than just retried.

**Root cause, found by reading `mxiClient.ts`'s `getAuthenticatedPage()`
closely**: it has a real, non-obvious side effect — its `isSessionAlive()`
liveness probe does `page.goto(todoListUrl, ...)` on *every* call,
whenever the current page URL doesn't literally contain `login.jsp`. The
earlier `P000BAL4` fix (previous addendum) had restructured
`moveOutboundShipmentToDock()` to call `readOutboundShipmentDockState()`
first (which itself fetches the page and navigates to the exact right
shipment detail page, ending there), then called
`client.getAuthenticatedPage()` a **second time** afterward to get "the
page" for the click sequence — silently bouncing the page back to the To
Do List via that liveness-probe navigation, right before trying to click
a checkbox that was no longer on the page it was actually on. Every other
function in `issueOrder.ts` takes `page: Page` directly and calls
`getAuthenticatedPage()` exactly once, at the top of a flow — this was
the only place that violated that pattern, and it was never actually
exercised by a genuine `'not_yet_docked'` case before now: `P000BAV8`/
`P000BAV9`'s earlier successful dock moves ran the *pre-refactor* code
(single `getAuthenticatedPage()` call), and `P000BAL4`'s own test of the
refactor only exercised the early-return `already_docked_or_further`
branch, which never reaches the second call.

**Fixed**: `readOutboundShipmentDockState()` now takes `page: Page,
todoListUrl: string` directly instead of `client: MxiClient` — matching
every other function in the file. `moveOutboundShipmentToDock()` fetches
`page` exactly once and reuses it for the whole flow. Updated
`review-pending`'s live-check caller to match (fetch `page` once per
env-client, reuse for every order in that env's loop, rather than passing
`client` in). Added an explicit docstring warning on
`readOutboundShipmentDockState`: never call `getAuthenticatedPage()` more
than once within a single logical flow that depends on page continuity.
`tsc --noEmit` clean.

### Recovered the 4 stuck real orders, then proved the fully-fixed tool end-to-end on a 5th

The first run had already created and issued 4 real orders
(`P000BAVA`/`B`/`C`/`D`) before failing at dock — re-running
`batch-execute` against the same 4 lines would have correctly (but
unhelpfully) skipped all 4 as `no_longer_eligible`, since they now have
real orders. Instead, found the 4 real order numbers via `review-pending`
(which correctly listed them as awaiting dock move) and ran the
now-fixed `aero-repair:move-to-dock` directly against each — all 4
succeeded.

**Then, separately, ran the fully-fixed `batch-execute` tool itself,
unattended, end-to-end, against one fresh untouched line**
(`5013640/APR16-3600`, Georgia/ORF) to prove the actual tool works, not
just the manual recovery path:
```
COMPLETED: order P000BAVE, routed to AERO REPAIR GEORGIA, docked (shipment SRRR7001N0AX).
Appended 1 completed row(s) and 0 exception row(s) to data\aero-repair-writeup-log.xlsx.
```
Correctly logged by the tool itself this time — no manual backfill
needed for this one.

### Independently verified all 5 real orders' end state (read-only, separate from the flow's own reporting)

`discovery-verifyBatchProofRun.ts` — fresh navigation per order, confirms
real `Order Status` and the outbound shipment's real `Current Location`:

| Order | Destination | Order Status | Vendor | Shipment location |
|---|---|---|---|---|
| `P000BAVA` | Georgia | ISSUED | VC01183 (AERO REPAIR GEORGIA) | `GSP/DOCK` |
| `P000BAVB` | NH | ISSUED | VC00412 (AERO REPAIR - NH) | `DCA/DOCK` |
| `P000BAVC` | Indy | ISSUED | P054A (AERO REPAIR - INDY) | `CAK/DOCK` |
| `P000BAVD` | DFW | ISSUED | VC00794 (AERO REPAIR CORP - DFW) | `DFW/DOCK` |
| `P000BAVE` | Georgia | ISSUED | VC01183 (AERO REPAIR GEORGIA) | `ORF/DOCK` |

All 5 genuinely issued, all 5 shipments genuinely at the correct station's
dock — independently confirmed, not just trusted from any tool's own
report.

### Tracking file backfilled to reflect reality, original exception rows left untouched

Since the dock step for the first 4 orders was completed via the
standalone CLI rather than `batch-execute` itself, the xlsx `Completed`
sheet didn't reflect them. Per this project's append-only correction
discipline (never edit/delete a historically-accurate row — the 4
`Automation Error` rows are exactly what the automated run genuinely hit),
backfilled 4 `Completed` rows reflecting the real, now-verified final
state (`discovery-backfillProofRunCompleted.ts`) rather than leaving the
log looking like these 4 failed permanently.

**Final, directly-verified tracking file contents** (`discovery-verifyLogFile.ts`):
- `Exceptions`: 10 real rows — the 6 `No Task Assigned` rows from the
  discovery-only pass, plus the 4 `Automation Error` rows from this run's
  real bug (left as an honest historical record).
- `Completed`: 5 real rows — `P000BAVA`/`B`/`C`/`D` (backfilled,
  reflecting real state after manual recovery) and `P000BAVE` (logged by
  the tool itself, no recovery needed).

### Non-goal honored

Did not run against the remaining eligible lines from the 57-line
discovery — this proved the mechanism (and found + fixed a real bug) at
4-then-5-line scale, exactly as scoped. `tsc --noEmit` clean throughout.

---

## Addendum: full 85-line run to completion — three real bugs found and fixed, all orphans recovered, one genuine data situation flagged (not fixed)

Per explicit instruction ("run the remaining eligible lines... scrape again
for new lines... run the full write up all the way through, including move
to dock"), re-ran discovery fresh across all 6 known part numbers, then ran
`batch-execute` unattended, full write-up→issue→dock, no pause, against
every eligible line found. This surfaced three separate real bugs — one
caught only because the user pushed back on a suspicious result rather than
letting it pass.

### Bug 1: discovery scan intermittently false-reported 0 eligible lines

The fresh scan reported `5013640` had dropped from 28 eligible lines the
prior night to 0. **User caught this directly**: "Woah woah, it should not
be showing 0. It should have increased. I think something is wrong, be
sure to check please." Direct spot-checks proved the scan was simply
wrong — `5013640` genuinely had 48 real lines, `90001200-1` had 21, both
reported 0 by the scan.

Root cause, confirmed via three repeated scan runs, each falsely zeroing a
*different* part number (ruling out anything tied to a specific part or
scan position): `MxiClient.getAuthenticatedPage()`'s liveness probe
navigates to the to-do list on every call, and being called only once for
the whole scan left later per-part-number reads vulnerable to whatever
state the page drifted into. First fix (call it once per part number
instead of once total) was insufficient on its own — proven by the repeat
runs still occasionally zeroing. Properly fixed with a 3-attempt retry
wrapper, `findCandidateLinesWithRetry()` in `batchDiscovery.ts`: only
trusts "0 eligible" once 3 consecutive attempts all come back empty.
`discoverEligibleLines()` now calls this wrapper instead of
`findCandidateLinesForPart` directly.

### Bug 2: authorization-verification — the most consequential fix this run

`runAeroRepairWriteUp()` set `authorizationRequested = true` immediately
after `confirmAuthorizationRequest()`'s click, with no verification the
click actually committed server-side. Recurred 3 times for real
(`P000BB18`, `P000BB1P`, `P000BB1Q`) out of roughly 16 attempts (~20-25%
failure rate) — each left a real order stuck at `Order Status: OPEN`,
`Authorization Status: PENDING`, with only "Request Authorization"
available (not "Issue Order"), even though the code believed authorization
had succeeded and proceeded to try to issue anyway. Per this project's
established "investigate recurring failures before continuing" discipline
(same precedent as the ESD module's `reissueOrder()` anomaly), the batch
sequence was paused to investigate rather than pushed through.

Fixed with a verify-and-retry loop in `writeUp.ts`: after
`confirmAuthorizationRequest()`, re-read the order's real state via a new
`readOrderRealState()` (extended in `issueOrder.ts` to also extract
`Authorization Status:`) and only set `authorizationRequested = true` once
`authorizationStatus === 'APPROVED'` is actually observed; retries the
click once more if not. `openGeneratedOrder()` (only valid immediately
after Schedule Work Package) is called once before the loop, not inside
it — `readOrderRealState`'s own navigation is sufficient to land back on
the right page for subsequent retries.

All 4 real orphaned orders left behind by this bug (`P000BB18`, `P000BB1D`,
`P000BB1P`, `P000BB1Q`) were individually recovered via one-off scripts —
3 succeeded on the first retry attempt, `P000BB1D` needed 2 (PENDING then
APPROVED), direct live proof the retry mechanism was actually necessary,
not just defensive. All 4 independently confirmed ISSUED and DOCKED
afterward. DB backfill needed two corrections along the way: an initial
`writeUpActionId: 0` placeholder (fixed by querying the real row id), and
an initial wrong-outcome filter (`'error'` instead of `'filled'`) when
locating `P000BB1D`'s `write_up_actions` row.

### Bug 3: silent line-substitution in `findFirstRepairLineForPart`

When a specific `preferredSerialNumber` was requested but not found among
the candidate links on a part's page, the function silently fell back to
`candidates.first()` — a different physical line — with no error. Real
incident: a run targeting `S-DEC22-0869` was silently substituted with
`APR14-2338` instead, caught only because the substituted line also failed
a later, unrelated safety check (the vendor-routing guard below). Had that
second safety net not existed, this would have silently created a real
order against the wrong physical part.

Fixed in `partDetails.ts`: when `preferredSerialNumber` is given and not
found among the candidates, throw explicitly rather than substitute. The
no-preference call path (omitting the parameter, still falling back to
`candidates.first()`) is unchanged and remains correct for that legitimate
use case.

### Genuine data situation, not a bug: 90001201-2 vendor-bid mismatch

5 of 6 real `90001201-2` (BRAKE ASSY MLG) lines correctly and safely
refused to guess a vendor match — `selectVendorRadioForRouting` found no
vendor bid matching the computed routing location (Georgia/Indy) for this
part. Investigated directly (`discovery-check90001201-2VendorsFinal.ts`
and related scripts) rather than assumed: this part number genuinely has a
narrower/different real vendor bid list than the wheel-assembly parts
tested extensively elsewhere in this project. Confirmed the target serial
(`S-DEC22-0869`) genuinely exists in the grid, ruling out a "line doesn't
really exist" explanation. This is flagged for manual vendor determination
by a human — correctly refused by design, not fixed in code.

### Final verification — zero orphans, real numbers reconciled

Direct DB query (`discovery-checkOrphans.ts`) confirmed **zero** orders
issued today with no successful dock move, and **zero** real orders
created today with no issue decision at all. Today's `write_up_actions`
outcome breakdown: `error: 6, filled: 1, no_tasks_assigned: 2,
pending_issue: 78`.

Direct xlsx read (`discovery-verifyLogFile.ts`) confirmed **77 real
Completed rows** total (order numbers `P000BAVA` through `P000BB55`,
spanning the earlier 4-line proof run plus this run) and **56 Exceptions
rows** (including expected duplicate re-logs of the same no-task lines
across multiple discovery scans — correct per the append-only design, not
an error). Of the 85-line target list from this run specifically: **72
completed cleanly** (including the 8 that hit Bug 2/3 as automation errors
and were subsequently recovered), **6 were no-longer-eligible** (claimed by
another process between discovery and processing — the shared-production-
system safeguard working exactly as designed), **2 hit no-tasks-assigned**
on live re-check (state changed since discovery), and **5 were the genuine
`90001201-2` vendor-bid mismatch** above — 72 + 6 + 2 + 5 = 85, reconciled
exactly.

### What this run actually proved

Three real, previously-undiscovered bugs (discovery-scan reliability,
authorization-verification, silent line-substitution) were found only by
running at real scale and by trusting reported failures/successes only
after independent verification, not by reasoning about the code. The
"refuse to guess" discipline (already established for vendor routing)
proved itself twice more this run — once as the direct catch for Bug 3,
and once again as the correct, safe behavior for the 5 genuine
`90001201-2` mismatches. All corrective actions (bug fixes, order
recoveries, DB backfills, xlsx logging) followed the project's append-only
audit discipline throughout — nothing wrong was ever edited or deleted,
only corrected forward.

---

## Addendum: line-substitution fix confirmed via a direct re-run against the exact incident line

Per explicit instruction, re-ran `90001201-2:S-DEC22-0869` through
`batch-execute` a second time, specifically to test the fix from a clean
process. Result: it correctly hit the same genuine vendor-bid-mismatch
safety refusal as the other `90001201-2` lines — not a crash, not the new
explicit "preferred serial not found" error, and critically, not a repeat
of the substitution.

**Direct forensic proof the fix works, found in the xlsx's own historical
record** (`discovery-verifyLogFile.ts`), comparing the two `S-DEC22-0869`
Exceptions rows side by side:

- Row 56 (`17:25:08.714Z`, the original pre-fix run): the `Serial/Batch
  Number` column says `S-DEC22-0869`, but the error text reads `...for
  line "Repair BRAKE ASSY MLG (PN: 90001201-2, SN: APR14-2338)"` — the
  target was `S-DEC22-0869` but the line actually processed (and whose
  vendor bid got checked) was `APR14-2338`. This is the substitution bug's
  fingerprint, preserved as historical record per this project's
  append-only discipline — never edited to look correct after the fact.
- Row 57 (`17:30:15.683Z`, this confirmation run, task `bo1pz44ln`): same
  target, but the error text now correctly reads `...SN: S-DEC22-0869)` —
  the line actually processed matches the line requested. No substitution.

The routing location differs between the two rows (`AERO REPAIR GEORGIA`
for the substituted `APR14-2338`, `AERO REPAIR - INDY` for the real
`S-DEC22-0869`) — expected, since these are two different physical lines
with two different real stations. That's exactly the point: the fix caused
the *correct, different* line to be found and processed this time, and it
was then, correctly and safely, refused for a vendor-bid mismatch under its
own real routing destination — the 5th distinct `90001201-2` line to hit
this pattern (alongside `APR14-2338`, `DEC14-2497`, `JUL14-2377`,
`MAR16-2755`), now confirmed under its own actual serial number rather than
someone else's.

### Final re-verification after this confirmatory run

- `discovery-checkOrphansFinal.ts`: zero orders issued today with no
  successful dock move; zero real orders created today with no issue
  decision at all. Outcome counts unchanged from the prior check (`error:
  6, filled: 1, no_tasks_assigned: 2, pending_issue: 78`) — this
  confirmatory run hit the vendor-bid-mismatch guard before any order was
  ever created, so it added no new order and didn't shift these counts.
- `discovery-verifyLogFile.ts`: xlsx contents unchanged in aggregate (56
  Exceptions data rows, 77 Completed data rows) — this run's result (row
  57) was already reflected in the counts reported above; this pass
  re-confirms them directly rather than re-deriving them.

### Status: closed

All three bugs found this run (discovery-scan reliability,
authorization-verification, silent line-substitution) are now fixed AND
independently confirmed working via a live re-run against the exact real
incident that first exposed each one — not just patched and assumed
correct. The `90001201-2` vendor-bid-mismatch situation remains the one
open item, unchanged in nature: a genuine data gap needing a human to
determine the correct vendor for Georgia/Indy-routed `BRAKE ASSY MLG`
lines, not a code defect.

---

## Addendum: two-command daily workflow — discovery and execute now hand off automatically

Previously running this daily meant a manual step in between: read
`batch-discovery`'s console output, copy every eligible `partNumber:serialNumber`
pair by hand into a `batch-execute` invocation. For an 85-line day that's
85 things to transcribe correctly. Replaced with a handoff file so the
whole thing is genuinely two commands.

**New module: `writeUps/aeroRepair/eligibleLinesFile.ts`** —
`saveEligibleLines(env, lines)` / `loadEligibleLines()`, reading/writing
`data/aero-repair-eligible-lines.json` (`{ generatedAt, env, lines: [{
partNumber, serialNumber }] }`). Lives under `data/`, so it's already
covered by the broad `data/` `.gitignore` rule — confirmed with `git
check-ignore -v`, not just assumed, per this project's standing rule that a
gitignore entry needs that check to be trusted.

**`aeroRepairBatchDiscoveryCli.ts`** now calls `saveEligibleLines()`
unconditionally after every scan — including when 0 lines are eligible,
since "nothing to do today" is itself a real result `batch-execute` needs
to see, not an absent file.

**`aeroRepairBatchExecuteCli.ts`** now resolves its target list in one of
two ways:
- **No positional `partNumber:serialNumber` args** (the normal daily case):
  reads `data/aero-repair-eligible-lines.json`. Refuses to proceed — before
  ever opening an MXI session — if the file's saved `env` doesn't match the
  `--env` this run was given, so a stage-discovery snapshot can never
  silently get executed against production or vice versa. Also warns (but
  doesn't block) if the file is more than 24 hours old, since
  `verifyLineStillEligible` already re-checks every line live immediately
  before processing it — a stale entry just gets safely skipped as "no
  longer eligible," never acted on incorrectly.
- **Explicit `partNumber:serialNumber` args given**: used exactly as
  before, ignoring the saved file entirely — preserves the ability to
  target one specific line directly (e.g. the S-DEC22-0869 fix-verification
  re-run above), unchanged.

**New daily usage, verified for real against production**:
```bash
npm run aero-repair:batch-discovery -- --env production
npm run aero-repair:batch-execute -- --env production
```
Ran the discovery half for real this session: found 13 eligible lines,
printed `Saved 13 eligible line(s) to data\aero-repair-eligible-lines.json
— run \`npm run aero-repair:batch-execute -- --env production\` next to
process all of them, no manual list needed.` Read the file directly
afterward — all 13 lines present, matching the console summary exactly.
Also verified the safety guard: running `batch-execute -- --env stage`
against that production-tagged file refused immediately (`Refusing to
proceed: ... was generated for env "production" but this run targets
"stage"`), confirmed to exit before any MXI login was attempted (no
`[mxiClient] Logged in` line, sub-second exit).

**Not run for real this session**: the actual `batch-execute -- --env
production` half against these 13 real lines — that's a real write
action (order creation, issue, dock) against live production data, and
wasn't triggered just to demonstrate the plumbing. The load/save/refuse
logic above is proven directly; the very next real `batch-execute --
--env production` run, whenever it's done, will be the first live
end-to-end proof of the full two-command path.

---

## Addendum: `mxi:save-storage-state` extended to support production

Needed for an upcoming manual Playwright codegen recording against a real
production order, without ever typing or recording real production
credentials during that session — the same reason the original stage-only
version exists.

**Checked first, not assumed**: `saveStorageState.ts` was genuinely
stage-only — hardcoded `createReadyMxiClient()` (no env arg, defaults to
`'stage'`) and a hardcoded `data/mxi-stage-storage-state.json` output path.
`createReadyMxiClient()` and `MxiClient` themselves already fully supported
production (`MXI_PROD_BASE_URL`/`MXI_PROD_USERNAME`/`MXI_PROD_PASSWORD`,
same as every other CLI tool in this module) — only this one script had
never been updated to use that support.

**Fixed**: now takes the same `--env stage|production` flag
(`parseEnvFlag.ts`) as `mxi:read-esd`/`mxi:write-esd`, defaulting to stage.
Output filename is env-suffixed —
`data/mxi-stage-storage-state.json` / `data/mxi-production-storage-state.json`
— so a stage session can never be mistaken for, or accidentally loaded as,
a production one. Added an explicit `.gitignore` entry for the new
filename (`data/mxi-production-storage-state.json`), mirroring the
existing stage entry rather than relying on the broad `data/` rule alone,
consistent with this project's standing practice for live-session files.

**Run for real against production**: `npm run mxi:save-storage-state --
--env production` — printed the production warning banner, logged in for
real (`[mxiClient] Logged in to MXI (production).`), saved to
`data/mxi-production-storage-state.json`. Verified directly (structure
only — session cookies are as sensitive as credentials and were not
printed anywhere): file is 2757 bytes, top-level keys `cookies`/`origins`,
5 real cookies against `maintenix.psa.aa.com` and `.aa.com`. Confirmed
git-ignored with `git check-ignore -v`, not just assumed from the
`.gitignore` text (matched by the broad `data/` rule, backed by the new
explicit filename entry).

**Usage for the upcoming recording session**:
```bash
npm run mxi:save-storage-state -- --env production
npx playwright codegen --load-storage=data/mxi-production-storage-state.json <url>
```
Codegen opens already authenticated against real production — no login
form appears, so no production credential is ever typed into or captured
by the recording.

---

## Addendum: "No task assigned" recovery path — a real candidate-task panel, implemented and partially verified

Built from a real recorded walkthrough
(`backend/discovery-notaskwriteup-recording.ts`, kept in place — no
credentials in it, since it starts from an already-authenticated
storageState, not a login form). Previously "No task assigned" was a hard
stop (`writeUp.ts` returned immediately on
`isNoTasksAssignedException`). The recording revealed a real recovery
option on the order's own page.

### Part A — investigation, read-only

**1. Where "test" was typed in the recording, and what it actually means.**
`#idInput12` (`name="aTaskName"`) — a free-text field. Confirmed via direct
DOM inspection (not just reading the recording) that this field lives
inside a section that is `display:none` unless the **"Create Ad-Hoc Task"**
radio (`#idRadioAdHoc`) is explicitly selected — a completely different
mode from the default-checked **"Create Task Based on Task Definition"**
radio (`#idRadioTaskDefn`). Real correction to the initial reading of the
recording: "test" was typed as a demo placeholder specifically *because*
the recorded order had 2 real candidate task definitions (an ambiguous
case, per the user's own "2+ → flag for a human, don't guess" framing) —
not because free-text entry is part of the real 1-candidate recovery
mechanism. That mechanism is structurally separate: leave/re-check
`#idRadioTaskDefn`, select the one candidate's own real radio
(`input[name="aTaskDefinition"]`), click OK — no typing at all.

**2. The real Task panel, read live via `.innerText()` and direct DOM
inspection** (same techniques as `readPartOwnDetails`/`readNoteToReceiver`
— body-wide, no fabricated container selector). Reached by clicking
**"Create New Task"** on the exact same default "Assigned Tasks" tab
`writeUp.ts` already lands on and checks — before any further navigation.
It's a "Task Selection" panel: a "Details" section with the two mode
radios, and a **"Blocks and Requirements"** table — the real candidate-task
panel the user described — one row per real candidate, each with its own
`input[name="aTaskDefinition"]` radio (confirmed: the same radio's `value`
can appear duplicated multiple times in the DOM per row, a real rendering
quirk, not a scoping bug — deduped by that value). For the recorded order
(90001200-1/AUG14-2477): confirmed 2 real rows, matching "the screenshot's
two entries." Side finding, not part of the ask but worth flagging: this
same order's live state now shows `isNoTasksAssignedException: false` — its
own real task now exists, almost certainly because the recording's "test"
ad-hoc submission genuinely landed in production during recording. Not
caused by anything in this session, but a real state change worth knowing.

**3. Candidate counts for the 6 originally-known no-task lines**: **none of
the 6 still exist under their originally-recorded serial numbers** —
`findFirstRepairLineForPart` correctly refused to substitute a different
line for any of them (the "refuse to guess" safety net working exactly as
designed on a shared production system where state moves on between
sessions), rather than silently checking some other line instead. Ran a
fresh discovery scan to find the *current* real no-task lines instead: 3
found (`5013641`/`JUN10-2295/JAN10-0014`, `90001200-1`/`FEB16-3013`,
`90001201-1`/`SEP19-3097`). **All 3 show exactly 2 real candidates — same
as the recorded order.** Across every real no-task line checked this
session (4 total), **none showed 0 or 1 candidates.** Worth flagging
directly: this contradicts the "2+ should be rare" expectation — every
real instance found was 2, suggesting the systematic norm for these part
types may be "one REPL task, one Parts-Card (PC) task," not a rare
ambiguity.

### Part B — implementation

`selectors.ts` gained four functions: `openCreateNewTask`,
`readTaskDefinitionCandidates` (evaluate-based, dedupes by radio `value`,
reads each candidate's real name from its row's `<a class="navigable">`
link), `cancelCreateNewTask`, `selectSingleTaskDefinitionCandidate`.
`writeUp.ts`'s no-task check now: reads the panel first; 0 real candidates
→ unchanged original exception; 2+ → new `multiple_candidate_tasks`
outcome carrying every real candidate name (never a bare count); exactly 1
→ selects it and continues the flow normally. New outcome threaded through
`AeroRepairWriteUpOutcome`, `write_up_actions.outcome` (schema + `db.ts`,
no `CHECK` constraint to violate), both CLIs
(`aeroRepairBatchExecuteCli.ts`, `aeroRepairWriteUpCli.ts`), and
`ExceptionRow.issueType` (`discoveryLog.ts`) as `'Multiple Candidate
Tasks'`.

**Tested for real (2+ path)**: the originally recorded order no longer
qualifies (per the side finding above, it's no longer a no-task line), so
ran the real `batch-execute` CLI against `90001200-1`/`FEB16-3013` instead
— the same real scenario (2 real candidates), just a different order.
Result: `SKIPPED: 2 candidate tasks found, flagging for human review (not
guessing among them).` Read the actual xlsx afterward
(`discovery-verifyLogFile.ts`): row logged with `issueType: 'Multiple
Candidate Tasks'` and both real candidate names verbatim (`32-41-01-01-010-
REPL (MAIN WHEEL ASSY 900-REPLACEMENT)`; `PC MAIN WHEEL ASSY 900 (Parts
card for MAIN WHEEL ASSY 900)`), not just a count. Re-checked the live line
afterward: still `isNoTasksAssignedException: true`, still 2 real
candidates — confirms Cancel genuinely submitted nothing.

**Not tested (1-candidate path)**: per Part A.3, no real line with exactly
one candidate existed anywhere this session — reporting that plainly, as
the task anticipated. The 1-candidate code path is implemented from solid,
directly-inspected real DOM evidence (the radio, its scoping, the panel
structure are all confirmed real, not fabricated), but has not been
exercised end-to-end — neither the OK/Close submission sequence nor,
importantly, whether the page it lands on afterward is compatible with the
very next call in `writeUp.ts` (`navigateToUnassignedTasksView`, which
previously only ever ran straight after the repair-link click, never after
a Create-New-Task detour). Flagged explicitly in code comments on
`selectSingleTaskDefinitionCandidate` and at the call site in `writeUp.ts`.
**Verify this for real the next time a genuine one-candidate line naturally
occurs** — do not trust it for unattended use before then.

### Non-goals honored

No change to `batchDiscovery.ts`'s own classification logic or the
eligible-lines handoff file — a no-task line still gets classified
`no-task-exception` at discovery time and never reaches this recovery path
through the normal two-command flow. This recovery only fires when
`runAeroRepairWriteUp` is invoked directly against such a line (e.g. an
explicit `batch-execute` target, as used for the 2+ test above). No
processing of the remaining eligible lines from the earlier batch scan was
done this session.

---

## Addendum: "multiple candidate tasks" corrected — it was a filtering gap, not real ambiguity, and not the scoping bug originally suspected

The very next session, the user flagged real evidence that "multiple
candidate tasks" firing on 4/4 real no-task lines looked wrong: two
different real serials of `90001200-1` sharing one aircraft's work package
each had exactly one correctly-assigned task, proving a single right answer
exists per part. Investigated directly rather than assuming either the
user's suspected mechanism or the original implementation was right.

### What the previous check actually reads vs. the genuinely correctly-scoped source

**The suspected mechanism (pooling in a sibling serial's real task) is NOT
what's happening.** Direct evidence: the "Blocks and Requirements" panel
(reached via "Create New Task") shows the exact same 2-template shape
regardless of which of 4 different real serials (3 different part numbers)
it's reached from — it isn't reading anything serial-specific at all, so
there's no sibling to pool from. Confirmed by re-reading the recorded
order's OWN default Assigned Tasks tab after its real "test" ad-hoc task
landed: `Inventory` column showed exactly `MAIN WHEEL ASSY 900 (PN:
90001200-1, SN: AUG14-2477)` — the exact target, never a sibling — with a
real `Task | Name: "test" | ID: TRFKE00GXZFV` row. **That tab — already
being read on the very first line of this whole check
(`readAssignedTasksAreaText`) — is itself the genuinely correctly-scoped
source** the user asked to locate: it always shows 0 or exactly the real
task(s) actually tied to this one serial, never anything from a sibling.
It already correctly gates entry into the recovery block; nothing there
needed to change.

**The real cause, found by inspecting the "Blocks and Requirements" panel's
own "Class" column**: one of its two templates is *always* `taskClass:
'PC'` (Parts Card — administrative documentation, never itself the repair
task). It isn't a second real candidate at all — it's a permanent fixture
of this template-selection screen, offered for essentially any task
creation on this kind of assembly, regardless of serial. The previous
implementation counted it as a competing candidate, which is what made
"multiple candidates" fire on every single real case instead of being the
rare exception the user's design intended.

### Fix and re-verification

`TaskDefinitionCandidate` gained a real `taskClass` field (read from the
row's plain-text "Class" cell — the first `td.shortString` *without* a
nested link, since the Config Slot cell is also `shortString` but always
has one). `writeUp.ts` now filters out `taskClass === 'PC'` before applying
the 0/1/2+ decision. Re-ran the read (open panel, read candidates, filter,
Cancel — nothing created) against all 3 still-live previously-flagged
lines:

| Line | Raw candidates | After excluding PC |
|---|---|---|
| `90001200-1`/`FEB16-3013` | REPL, PC | **REPL** (1) |
| `5013641`/`JUN10-2295/JAN10-0014` | REPL, PC | **REPL** (1) |
| `90001201-1`/`SEP19-3097` | MOD, PC | **MOD** (1) |

**All 3 now resolve to exactly one real repair-relevant candidate**,
matching the user's domain expectation. (The 4th line, the recorded order,
was no longer re-testable this way — its own no-task state had already
moved on, per the prior addendum.) `MOD` (Part Transformation, a real
Service-Bulletin-driven task) confirms the fix isn't a "just hardcode
REPL" shortcut — it generalizes to whatever the one genuine non-PC
repair-class candidate is.

**A related, now-real correctness gap was also fixed while implementing
this**: `selectSingleTaskDefinitionCandidate` previously used
`input[name="aTaskDefinition"]).first()`, safe only when a single distinct
candidate existed on the whole page. With the excluded `PC` radio now
genuinely still present in the DOM alongside the chosen one, `.first()`
could have silently selected the wrong (excluded) radio depending on DOM
order. Rewritten to re-scan by the candidate's own real name text and
throw if no exact match is found, rather than trust position.

### Evidence base and what's still open

4/4 real no-task lines resolved correctly, spanning 3 of the 6 known part
numbers (`90001200-1` ×2, `5013641`, `90001201-1`) — not yet observed for
`5013640`, `5013642-1`, or `90001201-2`'s own no-task scenario
specifically. The 1-candidate auto-recovery path (now correctly filtered)
remains **unverified end-to-end** — this session deliberately did not
select/submit a real candidate or run the downstream flow through Issue
Order/Dock, consistent with the explicit non-goal (no batch execution
against the remaining eligible lines yet, since this changes what
"no task assigned" means for the recovery logic). Verify the full
submission and downstream continuation for real the next time this path
naturally fires.

---

## Addendum: first real execution attempt — one bug found and fixed, then blocked by a genuinely unexpected auth prompt; PAUSED pending a human-recorded flow

Per explicit instruction to treat this exactly like Issue Order's and
Move-to-Dock's own first real runs — individual scrutiny, stop and report
rather than patch blind on anything unexpected. Picked
`90001200-1`/`FEB16-3013` (REPL), re-verified fresh it was still a
1-candidate line, then ran the real `batch-execute` CLI against it.

### Attempt 1 — failed exactly where flagged as unverified; real bug found and fixed

Failed at `getByRole('cell', { name: 'Close' })` — the Ad-Hoc path's
post-creation dismissal sequence, which `selectSingleTaskDefinitionCandidate`
had borrowed without live confirmation (explicitly flagged as an assumption
in its own docstring). Checked the real state immediately after: still
"no tasks assigned" — clean failure, nothing partially created.

Investigated with an instrumented, screenshot-backed replay (own script,
not the production function) rather than guessing a second time. Real
finding: clicking "OK" after selecting the task-definition radio does NOT
lead to "Close" dialogs — it navigates to a genuinely different real page,
`CreateTaskFromDefinition.jsp` ("Create Task — Confirm Selection"), showing
the chosen Inventory/Task Class/Task Definition/Config Slot back for
review, with its own "OK"/"Cancel" pair. The Ad-Hoc and Task-Definition
paths simply have different real confirmation mechanisms — not a case of
one page needing extra patience or a retry, a structurally different page.
Fixed `selectSingleTaskDefinitionCandidate` to click this second real "OK"
instead of the two "Close" actions.

### Attempt 2 — the fix worked mechanically, but surfaced something new and genuinely unexpected

Got past the confirm-selection page cleanly this time — no timeout there —
but then failed further downstream, at `getByRole('link', { name:
'Unassigned' })` inside `navigateToUnassignedTasksView`, exactly the
second uncertainty already flagged in this same code ("whether the page
this lands on afterward is compatible with the very next call"). Checked
the real state again: still "no tasks assigned" — still clean, nothing
partially created by this attempt either.

Re-ran the same instrumented replay, this time screenshotting immediately
after the second "OK" (the Confirm Selection page's own submit) rather
than assuming it landed cleanly. **Real, directly observed finding**: a
genuine "Authentication Required" prompt appears in the page — a
username/password modal, pre-filled with `Username: 717375` (the real
human account this session runs under), asking for a password this
automation does not have and must not guess at. Screenshot preserved at
`data/discovery-step4-after-ok2.png`. This has never appeared anywhere
else in this entire project's write-up flow, across every other page and
action tested. A fresh, independent re-navigation to the line afterward
confirmed the real state is still completely unaffected — "no tasks
assigned," nothing created, nothing partially committed either time.

### Stopped here, per explicit instruction

Per the task's own stated condition — "if anything fails or behaves
unexpectedly... stop... that would be the point to consider a recording of
the correct manual process, not before" — this is exactly that point. The
first failure was fixable from investigation alone (a real, confirmable
DOM structure once looked at directly). This second one is not: an
authentication challenge this automation has no legitimate way to satisfy
isn't something to patch around by guessing at a password or attempting to
dismiss the dialog blindly on live production data. **This specific
1-candidate submission step needs a human to complete it once manually
(supplying whatever credential this second "OK" is actually asking for)
and record it, the same way every other real mechanism in this whole
module was originally captured** — not reverse-engineered further from
outside.

### State left behind: clean

Both attempts are recorded in `write_up_actions` as `outcome: 'error'`
with their real error messages (ids 126, 127), `order_number: null` for
both — no real order was ever created by either attempt. Independently
re-verified via fresh navigation after each attempt: the line's real state
is unchanged, still "no tasks assigned." Nothing needs cleanup or reversal.

### What's proven and what isn't, as of this pause

Proven for real: the 0/1/2+ candidate detection and PC-filtering logic
(prior addendum), and now also the task-definition-radio-selection +
first-OK submission mechanics (attempt 2 got cleanly past the exact point
attempt 1 failed at). **Not proven**: anything past the second "OK" on the
Confirm Selection page — whether it ever succeeds without human
intervention, what a genuinely successful post-creation page looks like,
and by extension the entire remaining continuation through
`navigateToUnassignedTasksView`, Schedule Work Package, Auth Flow, Issue
Order, and Move to Dock for this specific recovery path. None of that has
been reached yet. Per the explicit non-goal, this was not folded into the
broader batch run — it remains isolated, and now explicitly paused rather
than declared working.

---

## Addendum: root-caused the auth prompt — a real, deliberate MXI step-up re-auth for this specific action, not a session issue; design pivoting away from it

Before recording anything or treating credential entry as normal, ran a
dedicated root-cause investigation (real evidence only, no code changes,
no credentials entered).

**1. Compared against the original recording.** The Ad-Hoc path
(`discovery-notaskwriteup-recording.ts`) uses a structurally different
commit mechanism entirely — a single "OK" then two "Close" dismissals,
never touching `CreateTaskFromDefinition.jsp` at all. The real historical
outcome (the "test" task, ID `TRFKE00GXZFV`, later confirmed genuinely
created with `Task Status: CANCEL`) shows it completed for real, and the
recorded script itself contains no credential-entry step anywhere. Honest
caveat: this doesn't 100% rule out the human silently handling a similar
prompt off-script during that original live recording session, but
combined with evidence below, the more direct explanation is that the
Ad-Hoc commit path simply never reaches whatever triggers this dialog.

**2. Session-timing correlation — directly tested, not assumed.** Built a
timed test: fresh login, an unrelated comparison navigation immediately
after (no prompt), then the real task-definition sequence, logging
elapsed milliseconds at each step. Result: **the prompt appeared reliably
13 seconds after a brand-new login** — nowhere near session-timeout
territory — and specifically only right after the real commit action (the
second "OK" on the Confirm Selection page). Never after the comparison
navigation, never after the first "OK" (which only navigates to the review
page), never after the earlier radio-check steps. This rules out "sessions
occasionally need re-auth" and confirms it's tied to this specific action.

**3. Checked whether the code does anything non-minimal.** It doesn't,
materially. The sequence (search → click into line → Create New Task →
select "Create Task Based on Task Definition" mode → select the one real
candidate row → OK → OK) matches what a human doing this minimally would
also need to do. The one arguably avoidable step — explicitly re-checking
`#idRadioTaskDefn` even though it's already the page's own default — is
trivial and demonstrably not the cause, since the prompt is tied to the
final commit action itself, several steps later.

**4. What the dialog actually is — checked directly via DOM, not
inferred from appearance.** Real, decisive finding: this is **not** a
native browser HTTP Basic/NTLM challenge. Its full HTML is a genuine
in-page jQuery UI dialog (`class="ui-dialog ui-corner-all ui-widget..."`),
confirmed via `document.body.innerHTML` and a direct DOM tree-walk:
```html
<div role="dialog" aria-labelledby="ui-id-1" ...>
  <span class="ui-dialog-title">Authentication Required</span>
  ...
  <div class="errorMessage mx-ui-dialog-message" style="display:none">Incorrect password.<br>Please try again...</div>
  <input id="idButtonOk_ROUsername" value="717375" readonly type="text">
  <input id="idButtonOk_Password" type="password">
  ...
```
The username field is `readonly`, pre-filled with the *already-logged-in*
user's own username (`717375`) — MXI already knows who's asking; it's not
requesting a different identity, it's demanding the current user
re-confirm their own password. The hidden, ready-to-use "Incorrect
password" error div confirms this is a real, functioning re-authentication
check built into the application, not a decorative or broken element.

**Conclusion, stated plainly**: this is a genuine, deliberate MXI
step-up-authentication feature tied to this specific action — creating a
task from a formal, cataloged Task Definition (REPL/MOD) — not a bug, not
a session artifact, and not something a more minimal automated sequence
would avoid while still performing this same action. It IS avoidable, but
only by not performing this action at all in favor of a different one.

**This also directly corrects the domain expectation the investigation
was framed around**: the trigger isn't "modifying an already-issued
order" — both failed attempts had `order_number: null`, no order existed
yet either time. The real trigger is broader: creating an official,
catalog-linked task record at all, regardless of order/issue status.

### Design pivot, per explicit direction mid-investigation

The user redirected: **"We should be creating an ad hoc task. We
shouldn't be working with tasks that are already showing."** — i.e.,
abandon the whole task-definition-selection mechanism (reading "Blocks and
Requirements," filtering PC, auto-selecting the one remaining REPL/MOD
candidate) in favor of always creating a fresh Ad-Hoc task instead, the
same real mechanism the original recording used and which — per finding 1
above — does not appear to trigger this re-auth dialog. This is a bigger
change than a bug fix: it replaces the 0/1/2+ candidate-counting design
from the two prior addenda with a simpler "always create an Ad-Hoc task"
approach.

---

## Addendum: pivot implemented — Ad-Hoc task creation, two real gaps found and fixed via live testing, confirmed clean of the auth prompt both times

### 1. Retired the Task-Definition path entirely

`selectSingleTaskDefinitionCandidate` is gone. Grepped the whole backend
afterward: zero remaining references to it or to
`CreateTaskFromDefinition.jsp` anywhere in actual code (only in this
file's own historical comments). `#idRadioTaskDefn` and
`input[name="aTaskDefinition"]` are no longer touched by any live code
path.

### 2. New `createAdHocTaskForCandidate` — the real recording's proven mechanism, real candidate name

Replays the original recording's real commit sequence exactly:
`#idRadioAdHoc` check -> fill `#idInput12` (`aTaskName`) -> "OK" -> "Close"
cell -> "Close" link. The 0-candidate and 2+-candidate branches
(`writeUp.ts`) are byte-for-byte unchanged from the prior addendum —
confirmed by direct inspection, not just assumption — only the
"exactly 1" branch was touched.

**Mid-implementation instruction, also done**: the real Work Package/Check
ID must be appended directly after the candidate name in the Ad-Hoc task's
own name field. Added `extractWorkPackageCheckId()` — reads the bracketed
ID from the Assigned Tasks tab's own title line (e.g. `"...  [TRFKE00GXV7S]"`),
the only page in this flow that shows it (the Task Selection panel itself
does not) — extracted once, before `openCreateNewTask`, and threaded
through. Required, non-null: `writeUp.ts` throws rather than silently
create a task without the ID if the expected format isn't found.

### 3. Confirmed live, twice, real evidence: never reaches the Task-Definition page or the auth prompt

Ran `createAdHocTaskForCandidate` for real against `5013641`/`JUN10-2295/JAN10-0014`
(REPL) via a standalone instrumented script first. Checked directly after:
`page.url().includes('CreateTaskFromDefinition')` → `false`;
`bodyText.includes('Authentication Required')` → `false`. Independently
re-verified via fresh navigation: real task created, `Task | Name:
"32-41-01-01-010-REPL (MAIN WHEEL ASSY 700-REPLACEMENT)" | ID:
TRFKE00GXZNE`, correctly scoped `Inventory`, `Status: ACTV`.

### 4. Real end-to-end attempt via the actual CLI found and fixed a second real gap

Ran `batch-execute` for real against `90001201-1`/`SEP19-3097` (MOD).
**The Ad-Hoc creation itself worked perfectly** — independently verified:
`Task | Name: "32-46-00-001-MOD (MEGGITT SB 90001201-32-02 - BRAKE
ASSEMBLY UPGRADE) TRFKE00GXMPF"` (candidate name + check ID, exactly as
instructed) `| ID: TRFKE00GXZNJ`, correctly scoped, `Status: ACTV`. But the
flow then failed at `navigateToUnassignedTasksView` (`waiting for
getByRole('link', { name: 'Unassigned' })`) — a **new, real, previously-
unseen gap**: after the Ad-Hoc "Close" sequence, the page lands back on
the filtered To Do List grid, not Work Package Details (the original flow
never had this problem, since it only ever reached Work Package Details
once, straight from the repair link click, with no Create-New-Task
detour).

**Fixed**: `reopenRepairLineAfterTaskCreation` — confirmed live (the same
`linkText` used to originally select the line is still present and
clickable on that same filtered grid) that re-clicking it correctly
re-enters Work Package Details. Called immediately after
`createAdHocTaskForCandidate`, before `navigateToUnassignedTasksView`.

**Verified the fix directly, since no fresh no-task line remained to
re-run the full flow against** (both real candidate lines now have real
tasks from the tests above — see below): an isolated mechanism test
against `SEP19-3097`'s now-existing line confirmed re-clicking `linkText`
from the filtered grid lands back on `CheckDetails.jsp`
(`body.innerText().startsWith('Work Package Details')` → `true`) with the
`Unassigned` link now present (`true`) — exactly what
`navigateToUnassignedTasksView` needs.

### What's proven and what remains open

**Proven for real**: Ad-Hoc task creation with the correct name + check ID,
twice, on two different real lines (REPL and MOD) — neither reached the
Task-Definition page or the auth prompt. The `reopenRepairLineAfterTaskCreation`
fix is confirmed via a direct, isolated mechanism test (not a guess).

**Not yet proven**: the full, unbroken continuation from Ad-Hoc creation
through Auth Flow, Issue Order, and Move to Dock in one single live run —
the `SEP19-3097` attempt that would have proven this failed at the
Unassigned-tab step (now fixed, but not re-run end-to-end), and no fresh
no-task line exists anywhere across all 6 known part numbers as of this
session's last scan to attempt it again. Per the task's own anticipated
contingency ("otherwise use the fresh line the user provides"), this needs
either a newly-appeared no-task line or explicit direction to wait/re-scan.

### 5. 0-candidate and 2+-candidate paths — confirmed unchanged

Direct code inspection, not assumption: both branches are identical to the
prior PC-filtering addendum, still correctly returning `no_tasks_assigned`
and `multiple_candidate_tasks` respectively, still logging to the
Exceptions sheet the same way. Neither was touched by this pivot.

Per the explicit non-goal, none of this was folded into the broader batch
run — still isolated, still proving the mechanism once before any wider
use.

---

## Addendum: one-time pause gate built for the unproven Ad-Hoc continuation, so tomorrow's batch run can proceed safely

Since the full continuation (Ad-Hoc creation through Auth Flow, Issue
Order, Move to Dock in one unbroken run) remained unproven at the end of
the last session, built a one-time gate rather than either trusting it
blind or requiring full manual supervision on every future case.

### New: `writeUps/aeroRepair/adHocContinuationProof.ts`

A small, durable (file-based, not in-memory) proof marker —
`data/aero-repair-adhoc-continuation-proof.json` — same pattern as
`eligibleLinesFile.ts`. `isAdHocContinuationProven(env)` /
`markAdHocContinuationProven(env, orderNumber, partNumber, serialNumber)`.
**Scoped per-env**: proving this in stage cannot silently unlock
unattended production use, or vice versa — stage is already documented
elsewhere in this project to not reliably mirror production data, so this
mirrors `eligibleLinesFile.ts`'s existing env-match safety check rather
than introducing a new pattern. Verified the gate's negative case for
real: `isAdHocContinuationProven('production')` returns `false` when no
file exists yet (the real current state).

### Wired into `writeUp.ts`

Right after `createAdHocTaskForCandidate` + `reopenRepairLineAfterTaskCreation`
(both already proven real), a single check: if the proof isn't set for
this env, return a new `ad_hoc_pending_manual_continuation` outcome
immediately — before `navigateToUnassignedTasksView` or anything else
downstream runs. This is a deliberately early stop: literally everything
past task creation is what remains unproven, not just Auth
Flow/Issue/Dock specifically, so the pause sits at the earliest safe
point, not the latest convenient one.

### Manual continuation: `npm run aero-repair:continue-ad-hoc -- <partNumber> <serialNumber> [--env production]`

New CLI (`aeroRepairContinueAdHocCli.ts`). Explicitly naming one real
order and running this command **is** the manual confirmation — no
separate interactive prompt, matching this project's existing pattern
(`aeroRepairWriteUpCli.ts`'s own "STOPPED BEFORE ISSUE" gate,
`approve-and-write`'s `--confirm` flag). Before doing anything else, it
re-verifies live that the line now genuinely shows a real task (not
`no tasks assigned`) — refuses to proceed otherwise rather than trust
that the earlier paused run is still what it looked like.

**Only sets the flag when `processLine` reports `status: 'completed'`** —
the same genuinely-independently-verified signal already used everywhere
else in this module (order confirmed `ISSUED` via `readOrderRealState`,
shipment confirmed docked). Any other outcome — error, unrecognized
station, anything — leaves the gate in place and does **not** set the
flag, satisfying the explicit requirement that a failed proof attempt can
never be mistaken for a successful one.

### Reuse, not duplication

Extracted `processLine`/`logProcessLineResult`
(`writeUps/aeroRepair/processLine.ts`) out of `aeroRepairBatchExecuteCli.ts`
so the continuation command drives the **exact same** real write-up ->
Issue Order -> Move to Dock flow the normal batch path uses, not a
reimplementation that could quietly drift from it. `aeroRepairBatchExecuteCli.ts`
itself is otherwise behaviorally unchanged — same target resolution, same
per-line loop, same xlsx logging — just now calling into the shared
module.

### Confirmed unaffected (requirement 5), by direct inspection

- **0-candidate and 2+-candidate paths**: both still `return` before the
  gate check is ever reached — structurally impossible for the gate to
  affect them.
- **Normal eligible-line flow** (lines with an existing task): the entire
  no-task block, gate included, sits inside
  `if (isNoTasksAssignedException(assignedTasksText))` — lines that never
  hit that condition never reach any of this code at all.

### What's proven tonight vs. deferred to tomorrow, per the explicit non-goal

Proven: the gate's negative case (`isAdHocContinuationProven` returns
`false` with no file), full `tsc --noEmit` clean, and the gate's
placement/structure confirmed correct by direct code reading (built
directly after two already-proven real steps, using a plain boolean
short-circuit). **Deliberately not attempted tonight**: creating a real
Ad-Hoc task just to exercise the pause firing live, or writing a fake
proof file to test `markAdHocContinuationProven`'s round-trip — the
former is a real production write better spent on tomorrow's genuine
first case, and the latter risks leaving a stray false-positive proof
marker in place, which would defeat the entire mechanism. Tomorrow's
batch run will be the real first test: the first genuine single-candidate
no-task case will pause automatically, print the real Ad-Hoc task
details, and wait for `aero-repair:continue-ad-hoc` to prove it for real —
exactly once, then never again.

---

## Addendum: reliability fix for the exact skip mechanism behind a real user-reported bug, a DB-logging gap closed, and the Ad-Hoc continuation proven for real

Triggered by a direct user report: order lines being skipped and marked
resolved when they genuinely weren't. A prior diagnostic session (this same
day) found 10 real "No Longer Eligible (claimed by another process)" skips
across three days via the xlsx log, one line (`5013640/APR03-0565`) flagged
twice on separate days, and — critically — that `no_longer_eligible`,
`no_tasks_assigned`, and `multiple_candidate_tasks` were never written to
`write_up_actions` at all, only to the xlsx.

### 1. `verifyLineStillEligible` given the same retry protection as its sibling

This function — the exact one behind every "No Longer Eligible" skip — used
the identical grid-navigation-and-search mechanism as
`findCandidateLinesForPart`, but never got the 3-attempt retry wrapper that
function needed for a proven, real, intermittent false-empty-read bug
(documented above as "Bug 1"). Fixed with the same asymmetric-trust
pattern: the first attempt reporting `true` (still eligible) wins
immediately; a `false` (not eligible) result is only trusted once 3
consecutive attempts agree. Ran 25 live calls (5 real lines × 5 back-to-back
attempts) against unchanged real production state as part of the earlier
diagnostic — no flip observed, so this is a structural fix for a proven
class of bug, not a directly-reproduced-today failure.

### 2. DB-logging gap closed

`processLine.ts` now calls `insertWriteUpAction` for `no_longer_eligible`,
`no_tasks_assigned`, and `multiple_candidate_tasks` too — previously all
three returned before ever reaching that call. `write_up_actions.outcome`'s
type widened to include `no_longer_eligible` (schema.sql's comment updated
to match; no CHECK constraint exists, so this is purely additive). The DB
alone is now a complete record of every outcome this module produces.

### 3. `5013640/APR03-0565`'s Historical tab — investigated, real access limitation found and reported honestly

Confirmed the "Historical" tab genuinely exists — it's one of `Details |
Open | Historical | Sub Inventory | Timeline` on the Inventory Details page
(reached today via a normal, already-tasked line, `APR10-2507`, to avoid
touching Part C's reserved target). But **no live path was found to reach
APR03-0565's own inventory record**, since it has fallen out of the
open/order-less grid entirely — tried: the barcode search box with the bare
serial (rejected, "could not be found in the system" — that box wants a
real barcode value, not a serial), the Options dialog broadened to include
DOCK locations as well as USSTG (still not found), Requirement Search
(wrong feature entirely — task-definition search, not inventory), and My
Open Orders plus its own Options dialog (no part/serial filter or column
available there). This is a genuine access gap, not a shortcut — if there's
a known direct navigation path to a specific serial's Inventory Details
once it's no longer in the open grid, that's needed to close this out.

### 4. New exception type: Zero Usage - Records Error

`partDetails.ts` gained `isZeroUsage(usageRows)` — true only if both the
CYCLES and HOURS rows are present and all 6 TSN/TSO/TSI values are exactly
zero (numeric comparison, so "0", "0.0" etc. all count), false (never
guesses) if either row is missing. Wired into `writeUp.ts` immediately after
`readPartOwnDetails`, before Schedule Work Package — closes the part
details view cleanly before returning, same discipline as every other
early-return path in that function. New `zero_usage` outcome threaded
through `AeroRepairWriteUpOutcome`, `ProcessLineResult`,
`write_up_actions.outcome`, `ExceptionRow.issueType` (`'Zero Usage -
Records Error'`), and both CLIs (`aeroRepairBatchExecuteCli.ts` via
`processLine.ts`, and the standalone `aeroRepairWriteUpCli.ts`, whose
outcome switch needed the new case added to stay exhaustive).

**Tested for real, production:** `90001201-2/S-DEC19-0703` — confirmed via
the real `batch-execute` CLI: `SKIPPED: Current Usage shows all-zero
CYCLES/HOURS...`. Verified directly afterward, not just trusted from the
console line: `write_up_actions` row (id 191, outcome=`zero_usage`,
`filledFieldsJson: {"serialNumber":"S-DEC19-0703"}`) and the xlsx
`Exceptions` sheet (row 107, real part/serial, correct details/suggested
action text) both exist and match.

**Negative case tested read-only** (no full write-up run, since proving
"no false positive" doesn't require creating a real order):
`5013640/AUG03-0629` — real Current Usage read as CYCLES 15728/1116/98,
HOURS 16723.81/1353.96/116.72, `isZeroUsage()` correctly returned `false`.

### 5. The Ad-Hoc continuation — proven for real, first time ever

Per the prior addendum's own plan ("tomorrow's batch run will be the real
first test"). Re-verified `5013640/JUN19-4064` fresh, read-only, before
touching anything: still eligible (`verifyLineStillEligible` → `true`),
still genuinely "no tasks assigned," exactly 1 real non-PC candidate
(`32-42-01-01-017-REPL (WHEEL ASSY, NLG-REPLACEMENT)`, check ID
`TRFKE00GY8Q6`) — cancelled out afterward, nothing created by the check
itself.

**Step 1** — `npm run aero-repair:batch-execute -- 5013640:JUN19-4064
--env production`: created the real Ad-Hoc task and paused exactly as
designed (`PAUSED: Ad-Hoc task created (...) — pending one-time manual
proof.`). Independently re-verified before proceeding: a fresh,
separate read of the Assigned Tasks tab confirmed `isNoTasksAssignedException`
now `false` — the real task genuinely exists.

**Step 2** — `npm run aero-repair:continue-ad-hoc -- 5013640 JUN19-4064
--env production`: ran the full remaining flow for real — Schedule Work
Package, vendor selection, Auth Flow, Issue Order, Move to Dock — with zero
manual intervention beyond running the command itself. Result: `COMPLETED:
order P000BC0F, routed to AERO REPAIR GEORGIA, docked (shipment
SRRR7001N3Y2).`

**Independently re-verified, separate from the tool's own report** (same
discipline as every other first-time proof in this project):
`readOrderRealState` (fresh navigation) confirmed `orderStatus: 'ISSUED'`,
`authorizationStatus: 'APPROVED'`, `issuedCount: 1`;
`readOutboundShipmentDockState` confirmed the shipment already
docked/further; the order's own Vendor line read `VC01183 (AERO REPAIR
GEORGIA)`, matching the reported routing. DB rows all correct and present:
`write_up_actions` (`pending_issue`, GSP, AERO REPAIR GEORGIA, order
P000BC0F), `write_up_issue_decisions` (`approved_issue`/`success`,
`reviewed_by: batch-execute-automated`), `write_up_dock_moves`
(`SRRR7001N3Y2`/`success`). xlsx `Completed` sheet has the matching real
row. The proof file (`data/aero-repair-adhoc-continuation-proof.json`) now
reads `{ proven: true, env: 'production', orderNumber: 'P000BC0F',
partNumber: '5013640', serialNumber: 'JUN19-4064', provenAt:
'2026-07-25T15:41:07.372Z' }`.

**The one-time pause is now retired for production** — future
single-candidate no-task cases on this env will run straight through
automatically. `tsc --noEmit` clean throughout every change in this
addendum.

---

## Addendum: new "Unassigned Task Present" exception — the Unassigned Tasks sub-tab is now actually read, not just passed through

Built independent of, and not blocked by, the deferred auto-assign
recording — this closes the real safety requirement (don't write up an
order when this is present) without needing that recording.

**Confirmed what the flow did with this page before today: nothing.**
`navigateToUnassignedTasksView`/`closeUnassignedTasksView` were a pure
navigational pass-through — two clicks, no `.innerText()` read anywhere,
no check of any kind. Direct code read of both functions and their one
call site in `writeUp.ts` confirmed this plainly.

**Added `NO_UNASSIGNED_TASKS_TEXT`** (constants.ts) — the exact,
already-confirmed-real empty-state string for this sub-tab (`"There are no
open tasks for this inventory item or any of its sub-inventory items."`,
originally confirmed across 7 real lines in an earlier addendum). New
`readUnassignedTasksAreaText` (selectors.ts, same trivial `.innerText()`
shape as `readAssignedTasksAreaText`) and `isUnassignedTaskPresent`
(noTaskException.ts) — true iff the page does NOT contain that exact
string, i.e. a real task row has replaced it. Wired into `writeUp.ts`
between `navigateToUnassignedTasksView` and `closeUnassignedTasksView`
(read before Close, since the content is gone afterward) — a new
`unassigned_task_present` outcome threaded through
`AeroRepairWriteUpOutcome`, `ProcessLineResult`, `write_up_actions.outcome`,
`ExceptionRow.issueType` (`'Unassigned Task Present'`), and both CLIs
(`processLine.ts` and the standalone `aeroRepairWriteUpCli.ts`, whose
outcome switch needed the new case to stay exhaustive).

**Tested read-only against the named real example, `JUN10-1572`** (found
under `5013642-1`, not one of the part numbers guessed first). Result:
`isUnassignedTaskPresent` read `false` — this line currently shows the
confirmed empty state, not a real task. Investigated rather than assumed
wrong: found and inspected a "Show open events within the next N days"
day-count field (`idDayCount`) on this page not previously documented —
already defaulted to `9999`, ruling out a hidden filter as the explanation;
widening it further made no difference. Scanned ~10 further real current
lines across `5013641`/`90001200-1` looking for any genuine positive case
live today — none found. Most likely explanation, consistent with this
being a shared, actively-changing production system (same pattern
documented repeatedly elsewhere in this file): the named line's real state
has moved on since it was originally observed. The check itself reads and
evaluates correctly (confirmed negative across every line checked,
including the named one); a genuine live positive case to confirm the
detection-fires branch specifically remains unobserved this session — flag
a currently-real example if one exists to close this out.

**Confirmed independent of the existing no-task/multiple-candidate logic**
(item 4): the two checks read two different tabs, gated by two separately-
confirmed empty-state strings, with no shared state. Direct evidence from
the `JUN10-1572` test itself: `isNoTasksAssignedException` (Assigned Tasks
tab) read `true` while `isUnassignedTaskPresent` (Unassigned Tasks tab)
read `false` on the very same line in the very same run — two independent
reads, two independent (and here, different) results.

Non-goal honored: no auto-assignment built. `tsc --noEmit` clean.

---

## Addendum: diagnostic session — the "consistent empty grid read" reported for 5013640 could not be reproduced live, despite extensive real testing; DOM structure and timing both directly ruled out

Explicit diagnostic-only task, no fixes: investigate why 5013640's grid
read allegedly came back empty consistently (not intermittently) despite
the browser being confirmed on the correct, visibly-populated page — new
evidence said to rule out both timing/session causes and the known
intermittent Bug 1 (see `findCandidateLinesWithRetry`'s docstring earlier
in this file).

### 1 & 2. Real DOM structure vs. what the selector expects — dumped directly, no mismatch found

Navigated to the real, live 5013640 grid in production using the exact
same sequence `findCandidateLinesForPart`/`verifyLineStillEligibleOnce`/
`findFirstRepairLineForPart` all share (`Options...` → `Reset Filters` →
USSTG-only → OEM Part No → OK), then dumped the real DOM directly via
`page.evaluate()` rather than trusting Playwright's own locator alone:

```json
{
  "iframeCount": 4,
  "tableCount": 26,
  "totalLinkCount": 743,
  "repairPrefixedLinkCount": 40,
  "anyPnMatchCount": 40
}
```

Real sample element: `<a href="/maintenix/web/task/CheckDetails.jsp?..." class="navigable">Repair WHEEL ASSY, NLG (PN: 5013640, SN: ...)</a>`
— an ordinary anchor tag with a real `href` (so its implicit ARIA role is
genuinely `link`, matching what `getByRole('link', ...)` looks for), no
`role` attribute override, not nested inside any of the page's 4 iframes
(confirmed: `page.evaluate()`'s `document.querySelectorAll` — which, like
`page.locator()`, only sees the main frame — found the exact same count,
40, as Playwright's own locator; if the real rows were inside an iframe
boundary, these two independent query mechanisms would have disagreed).
**No structural mismatch of any kind found**: the live markup matches
exactly what `repairLinkPattern` (`^Repair .*\(PN: ..., SN: [^)]+\)$`)
already expects — same prefix, same `(PN: X, SN: Y)` suffix shape,
confirmed against the real current text, not assumed from memory of an
earlier session's DOM notes.

### 3. Timing hypothesis — tested directly, not observed even once

Read the same selector immediately after the Options-OK click, then again
after an explicit extra 3-second wait: **identical count both times (40),
in both checks**. Went further: repeated the entire real navigation
sequence (fresh `Options...` → `Reset Filters` → fill → OK, matching the
production code exactly) **8 times in a row within one session** —
every single attempt returned exactly 40, with zero transitional
empty-then-populated states observed at any point. If the grid's data
were arriving asynchronously after the page's initial response, at least
one of these 9 total attempts (1 immediate + 8 repeats) would be expected
to catch it mid-load — none did.

### 4. Stage vs. production — both consistent, both currently correct

Same exact test repeated against stage: **28 real lines, identical across
all 8 repeated attempts**, same as production's stability. No
environment-specific discrepancy of any kind — neither environment shows
any sign of the reported symptom right now.

### 5. Plain conclusion, stated honestly

**The reported "consistent empty read" could not be reproduced live**,
despite 17 total real read attempts across both environments (1 initial +
8 repeats in production, plus 8 in stage), using the exact real selector
and exact real navigation sequence the production code uses — not a
simplified approximation. Both of the two hypotheses this task asked to
test directly are **ruled out by direct evidence, not inference**:

- **Not a DOM structure change** — the live markup matches the selector's
  expectations exactly, confirmed via two independent query mechanisms
  (Playwright's own locator and a raw `document.querySelectorAll` inside
  `page.evaluate()`) agreeing on the same count every time.
- **Not read-before-populated timing** — an explicit 3-second delay
  produced the identical count to an immediate read, and 8 rapid repeated
  navigations within one session never once showed a transitional empty
  state.

Given the failure cannot currently be reproduced under any tested
condition, the most defensible conclusion is that **whatever caused the
originally-observed consistent empty read was a transient condition** —
most plausibly a temporary MXI-server-side issue, degraded performance, or
some other environmental factor at that specific time — **not a
persistent defect in the current selector, DOM structure, or code
timing**. This is a genuinely different category of finding from the
earlier, already-fixed Bug 1 (which WAS reproducible on demand, repeatedly,
across multiple full scans) — this incident, whatever its real cause,
is not currently reproducible by any means tried here.

**Per the explicit non-goal, no code changes were made.** If this
recurs, the most useful next step is capturing a screenshot and the exact
console/error output from the automation itself at the moment it happens
(not a fresh reproduction attempt afterward, which this session's evidence
suggests is unlikely to succeed) — direct evidence from the actual failing
run, rather than a later, necessarily-different live session, is what
would move this from "unreproducible" to "understood."

### Most authoritative confirmation: the real, unmodified `discoverEligibleLines()` itself, run end-to-end

Beyond the isolated reimplementation tests above, ran the actual real
production function — zero modifications, the exact same code any real
batch-discovery invocation calls — across all 6 part numbers. Took
891 seconds (~14.85 minutes) end-to-end (genuinely slow due to per-
candidate no-task/routing checks, not a hang). Result for 5013640
specifically: **40 total lines found, all 40 correctly classified
`eligible-for-write-up`, zero lost to a false-empty read.** This is the
single strongest piece of evidence in this investigation — not a
faithful-but-separate reimplementation, the real function itself,
confirming the 18th consecutive correct read (17 isolated attempts above
plus this one) with zero reproductions of the reported symptom anywhere.

---

## Addendum: capture-on-empty instrumentation added; a real, confirmed gap closed in the path-equivalence check — the diagnostic tested a different function than the one real write-up execution actually uses

Follow-up to the diagnostic above: rather than accept "transient" and move
on, added hard-evidence capture at every grid-read path that treats an
empty/zero result as meaningful, and closed the one gap the diagnostic
itself flagged — whether `discoverEligibleLines()` (what was tested) is
really the same code the normal `batch-execute` command runs.

### 1. New: `writeUps/aeroRepair/emptyReadCapture.ts`

`captureEmptyReadEvidence(page, label, context)` — full-page screenshot +
a text file (URL, context, and `page.locator('body').innerText()`) to
`data/empty-read-<label>-<timestamp>.{png,txt}`. Best-effort: wrapped in
try/catch, logs a warning and never throws — a capture failure must never
be allowed to affect the real flow it's instrumenting. Purely
observational; no retry/read behavior changed anywhere. Confirmed
git-ignored via `git check-ignore -v` (matched by the broad `data/` rule),
and smoke-tested for real against a live page — confirmed a genuine
142KB screenshot and a real, correctly-formatted text file were written,
then deleted (a mechanism test, not a real incident).

Wired into all four named paths:
- `findCandidateLinesForPart` (`batchDiscovery.ts`) — captures on the
  `"no inventory"` text branch AND separately on `count === 0` (the
  suspicious shape: a page that does NOT claim to be empty, yet the
  selector finds nothing) — these are distinguishable in the saved
  evidence by label (`-no-inventory-text` vs. `-zero-count`).
- `verifyLineStillEligibleOnce` (`batchDiscovery.ts`) — same
  `"no inventory"` branch, plus the final fallthrough (`count === 0` OR
  the specific serial not found among `count > 0` matches — both
  distinguishable via the saved `candidateCountOnPage` context value).
- `findFirstRepairLineForPart`'s preferred-serial-not-found throw
  (`partDetails.ts`) — captured immediately before the existing throw,
  same context (`candidateCount`) available to distinguish 0-candidates
  from serial-not-matched.
- The unassigned-task empty-state read (`writeUp.ts`) — captured when
  `isUnassignedTaskPresent` returns `false`, the state currently trusted
  to mean "safe to continue," right before `closeUnassignedTasksView`.

### 2. Path-equivalence check — a real, confirmed divergence, not a false alarm

The diagnostic's most authoritative test ran `discoverEligibleLines()`
(→ `findCandidateLinesForPart`, `batchDiscovery.ts`) — but that function is
**only ever called by `aeroRepairBatchDiscoveryCli.ts`** (confirmed by
direct read: `main()` calls `discoverEligibleLines(client)` with no
wrapper). The normal `batch-execute` command — the one that actually
performs write-ups — **does not call this function at all**. Its real
call chain, confirmed by direct read of `aeroRepairBatchExecuteCli.ts` →
`processLine.ts` → `writeUp.ts`, is:

```
processLine()
  -> verifyLineStillEligible()       (batchDiscovery.ts — a SEPARATE function)
  -> runAeroRepairWriteUp()
       -> findFirstRepairLineForPart() (partDetails.ts — a THIRD, separate function)
```

All three functions share the same general technique (a `repairLinkPattern`
regex + `page.getByRole('link', ...)`, reached via a similar `Options...`
→ `Reset Filters` → OEM Part No → OK sequence) but are **independently
implemented, not shared code** — confirmed by direct comparison, not
assumed from similar naming:

| | `findCandidateLinesForPart` (tested) | `verifyLineStillEligibleOnce` (real batch-execute path) | `findFirstRepairLineForPart` (real batch-execute path) |
|---|---|---|---|
| Used by | `batch-discovery` only | `batch-execute`/`continue-ad-hoc` (via `processLine`) | `batch-execute`/`continue-ad-hoc` (via `runAeroRepairWriteUp`) |
| Retry-on-empty | Yes (`findCandidateLinesWithRetry`, 3 attempts) | Yes (`verifyLineStillEligible`, 3 attempts) | **None** |
| Checks `"no inventory"` text | Yes | Yes | **No — not checked at all** |
| Navigation helper | `navigateToFilteredGrid` (shared with #2) | `navigateToFilteredGrid` (shared with #1) | **Its own separate inline copy** — same steps, different file, not shared |
| Regex-building `escapeRegExp` | Escapes hyphens too | (same function, shared) | **Does not escape hyphens** — harmless for the 6 known part numbers (a bare `-` outside a character class isn't a regex metacharacter), but a real, confirmed textual divergence, not identical code |
| Behavior on a genuinely/transiently empty grid | Returns `[]` gracefully | Returns `false` gracefully | **Throws** (`candidates.first()` — or the preferred-serial search — has nothing to act on), surfacing as an `'error'`/`'Automation Error'` outcome, a categorically different observable symptom than a silent empty read |

**This is the gap the task asked to close, and it's real, not a false
alarm.** The diagnostic's 18 confirmed-correct reads all exercised
`findCandidateLinesForPart` — the *discovery* step's read. If the
originally-reported "consistent empty read" happened during actual
write-up *execution* (`batch-execute`, processing an already-discovered
line) rather than during the discovery scan, it would have gone through
`verifyLineStillEligibleOnce` or `findFirstRepairLineForPart` instead —
functions with genuinely different resilience (one has no retry at all)
and a different failure signature (a thrown error, not a silent empty
result) than what was tested. **This was not closed by re-running
`discoverEligibleLines()` again** — it required reading the actual call
graph, which is what this step did. The new capture instrumentation above
now covers all three functions, so whichever one is actually involved next
time, real evidence will be captured at the moment it happens.

### 3. No behavioral changes, per the explicit non-goal

Zero changes to retry counts, retry logic, or what any function returns —
confirmed by direct diff review: every edit in this addendum is either a
new file (`emptyReadCapture.ts`) or a single `await captureEmptyReadEvidence(...)`
call inserted immediately before an existing return/throw, with no
existing line altered. `tsc --noEmit` clean throughout.

### Command-line prompts for running this automation (requested directly, and relevant given the path divergence above)

The normal daily sequence is genuinely two commands — this is the one
morning "batch-execute" people mean when they say "run the automation":

```bash
# 1. Scan for eligible lines (writes findCandidateLinesForPart's own read —
#    the function this diagnostic session tested):
npm run aero-repair:batch-discovery -- --env production

# 2. Process every eligible line found above (uses verifyLineStillEligibleOnce +
#    findFirstRepairLineForPart instead — the two functions NOT covered by
#    the diagnostic's own testing, per the gap closed above):
npm run aero-repair:batch-execute -- --env production
```

Supporting commands, for reference (not part of the normal morning
sequence unless something needs manual attention):

```bash
# One-time manual proof for a paused single-candidate Ad-Hoc case
# (only needed once per env until aero-repair:continue-ad-hoc reports success):
npm run aero-repair:continue-ad-hoc -- <partNumber> <serialNumber> --env production

# List orders currently sitting at PENDING ISSUE REVIEW:
npm run aero-repair:review-pending -- --env production

# Manually approve/reject a pending-review order:
npm run aero-repair:approve-issue -- <orderNumber> --env production
npm run aero-repair:reject-issue -- <orderNumber> "<reason>" --env production

# Re-attempt Move to Dock alone for an already-issued order:
npm run aero-repair:move-to-dock -- <orderNumber> --env production

# Single-line smoke test (write-up only, stops before Issue Order):
npm run aero-repair:write-up -- <partNumber> [serialNumber] --env production
```

All default to `stage` if `--env production` is omitted — matches every
other CLI in this project's standing safety convention (production is
always an explicit, per-invocation opt-in).

---

## Addendum: real cause found from the actual captured evidence — sustained-load-correlated rendering delay, not throttling/session-expiry/DOM change; pacing fix applied

The capture instrumentation worked exactly as intended: the very next real
batch run reproduced the failure for real, and every failing read's own
on-disk evidence (`data/empty-read-*.png`/`.txt`) was read directly —
not theorized about.

### What the real captures actually show

Read multiple `.txt` dumps spanning the start, middle, and end of the
failure window, for both the discovery-side (`5013640`) and execute-side
(`90001200-1`) failures:

- **Every single one shows a perfectly-rendered, fully-populated grid** —
  real part data, real work orders, real vendor rows. Several captures
  show the **exact target line the code had just failed to find**,
  clearly present and correctly formatted (e.g. `verify-line-eligible-not-found`
  for `5013641`/`DEC03-1047`: the capture's own body text shows
  `Repair MAIN WHEEL ASSY 700 (PN: 5013641, SN: DEC03-1047)` right there
  in the grid; same again deep in the `90001200-1` cluster for
  `MAR17-3325`).
- **No error banner, no throttle/"too many requests" message, no
  truncated/partial response, and no login/session-timeout redirect** in
  any capture checked, including ones taken well inside the worst part of
  the failure stretch — `New Alerts | Help | Log Out | BRAYDEN BURY (PSA
  ADMIN)` (still logged in) appears in every one.
- This directly rules out a genuinely empty grid, an explicit throttle
  response, a session expiry, and (again) a DOM structure mismatch — the
  page the selector queries is, by the time of capture, exactly what it's
  supposed to be.

### Timing, checked against the real DB, not estimated

Cross-referenced capture timestamps against `write_up_actions`/
`write_up_issue_decisions`:

- **12:33:07–12:41:31**: `5013641` processes **8 consecutive lines, fully
  successfully** — real Schedule Work Package fills, Auth Flow, Issue
  Order, Move to Dock, each cycle genuinely `ISSUED` (`P000BC34` through
  `P000BC3D`), roughly 60 real seconds of substantial browser work per
  line.
- **12:42:14 onward**, immediately after that stretch, the batch moves to
  `90001200-1` and enters a **dense, near-continuous failure run — 60+
  captures, ~7 seconds apart, for about 7.5 minutes** — almost every line
  in this part number comes back `no_longer_eligible` or `error`; only one
  line (`id 242`) succeeds, right at the tail end.
- **Onset correlates with sustained prior volume, not with failing from
  the first request**: the failure cluster begins right after — not
  during or before — 8+ minutes of continuous, successful, substantial
  automated activity. The existing retries in both affected functions
  fired with **zero delay between attempts** — three immediate
  back-to-back re-navigations into the same degraded window, giving it no
  chance to clear.

### Plain conclusion, named from the evidence

**Rendering/responsiveness degradation correlated with sustained,
continuous automated volume within one long-lived browser session** —
`MxiClient` runs the entire multi-hour batch on a single persistent page
(confirmed in `mxiClient.ts`), consistent with response times growing past
the code's fixed, un-adaptive delays specifically after a long stretch of
continuous heavy use, not from the start and not at random. This is
**not** the structural DOM change or read-before-populated-timing
hypotheses tested in the earlier diagnostic (both directly re-ruled-out
here too), **not** an explicit server-side throttle/rate-limit (no such
signal ever observed), and **not** a session expiry (never logged out).
Whether the actual slowdown originates server-side (MXI itself responding
slower under repeated automated hits) or client-side (the same Playwright
page/Chromium process degrading over a long continuous run) isn't
distinguishable from this evidence alone, but either way the fix is the
same: give it time, don't hit it harder.

### Fix applied, matched to this cause — pacing, not more aggressive retrying

New shared `writeUps/aeroRepair/retryBackoff.ts` — `waitBeforeRetry(page,
attemptJustFailed)`, an increasing real pause (3s, then 6s) **between**
retry attempts, not before the first one. Wired into all three affected
read paths (closing the gap the earlier diagnostic also flagged):

- `findCandidateLinesWithRetry` (`batchDiscovery.ts`, discovery's own
  read) — backoff added between its existing 3 attempts.
- `verifyLineStillEligible` (`batchDiscovery.ts`, the real `batch-execute`
  path) — same.
- `findFirstRepairLineForPart`'s preferred-serial search
  (`partDetails.ts`, the other real `batch-execute` path) — this one had
  **zero retry protection at all** before this fix, despite firing the
  same failure repeatedly during the same dense cluster
  (`find-first-repair-line-preferred-serial-not-found` captures appear
  throughout it). Refactored to retry the whole navigate+search up to 3
  times with the same backoff, rather than throwing on the first attempt —
  extracted the navigation into a small internal
  `navigateToPartGridAndGetCandidates` helper to avoid duplicating it
  across the retry loop and the no-preference branch.

No change to the base per-click `pace()`/`CLICK_DELAY_MS` (750ms) — the
fix targets the gap *between* retry attempts specifically, where the
evidence showed the problem, not the routine click cadence. `tsc --noEmit`
clean throughout.

### What's confirmed vs. what remains a reasonable-but-unproven refinement

**Confirmed directly from real evidence**: the cause (sustained-volume-
correlated rendering delay) and that immediate back-to-back retries were
structurally unable to help. **Not yet proven**: whether 3s/6s backoff is
the right magnitude, or whether a longer-running batch could still
accumulate enough degradation to exhaust even backed-off retries — the
next real batch run is the actual test of this fix, same as everything
else in this module that's only ever been trusted after a real run, not a
plausible-sounding change. If the same dense-cluster pattern recurs
despite this fix, the capture instrumentation will still catch it, and a
longer backoff or an explicit mid-run session/page refresh (raised as a
possibility, not attempted here) would be the next thing to try.

---

## Addendum: the scroll/virtualization hypothesis was tested rigorously and directly REFUTED — timing conclusion reaffirmed and strengthened, no scroll-handling code added

A specific, well-argued alternative hypothesis was raised: the grid
lazy-loads/virtualizes rows on scroll, and the read never scrolls, so
rows below the initial viewport are never queried — even though the page
is fully rendered and the target line is visible after scrolling. Tested
this directly against the real 5013640 grid in production, exactly as
asked, before touching any code.

### The exact test run, and what it found

1. **Baseline** (real production pace, no manipulation): before vs. after
   `window.scrollTo` and scrolling every real scrollable container
   (`#idTableUnserviceableStagingDiv`, a genuine, confirmed scrollable
   `<div>` with `scrollHeight: 10221` vs `clientHeight: 650` — a real
   overflow container does exist) to the bottom: **40 before, 40 after,
   every time**. No change from scrolling at all in the normal case.

2. **The decisive test — isolating scroll's effect from waiting's
   effect, at the exact moment the count would be low**: filled the
   Options form and clicked OK, then checked the count almost
   immediately (50ms later, deliberately too fast for normal rendering to
   have finished) three separate ways in strict sequence: (a) immediately,
   no scroll, no extra wait; (b) immediately AFTER scrolling every
   scrollable container to the bottom, with **zero additional wait**
   between scrolling and re-counting; (c) after an additional 1500ms real
   wait, with no further scrolling. Ran this **15 times in a row**:

   ```
   Attempt 1:  immediate=0, afterScrollNoWait=0, afterWait1500ms=40
   Attempt 2:  immediate=0, afterScrollNoWait=0, afterWait1500ms=40
   ...
   Attempt 15: immediate=0, afterScrollNoWait=0, afterWait1500ms=40
   ```

   **15 out of 15, zero exceptions**: scrolling — even executed
   immediately, with no wait at all — never changed the count. Only
   elapsed real time, with **no scrolling whatsoever**, brought it from 0
   to the full 40. If rows were virtualized/added-to-DOM-on-scroll, step
   (b) would have shown a jump above 0 at least some of the time — it
   never did, not once.

3. **Cross-check against the real production `pace()` value**: repeated
   the same real navigation sequence 15 more times using the actual
   production 750ms delay (no scrolling, no shortcuts) — **40 out of 40,
   every single time**. The normal production delay is already sufficient
   under this test's own conditions; the earlier real production failure
   (documented in the prior addendum) needed *sustained, extended, heavy*
   real load (8+ minutes of continuous full write-up cycles) to push the
   render time past what a simple repeated-navigation test like this one
   ever demanded.

### Plain conclusion: refuted, not confirmed

**The scroll/virtualization hypothesis does not hold.** The grid has a
real scrollable container, but all matching rows are unconditionally
either in the DOM (and found by `getByRole`) or not yet rendered at all —
scroll position has no bearing on it, checked directly and repeatably.
This also fully explains the "decisive evidence" that motivated the
hypothesis (failing captures showing the target line present moments
later): that capture always ran *after* the original failed count — a
screenshot plus a fresh `innerText()` read, taking real additional time —
so of course the row had often finished rendering by then. That was never
evidence of virtualization; it's the exact same time-dependent behavior
just measured directly and deliberately here, with scroll explicitly
isolated out.

**This strengthens, rather than replaces, the prior addendum's
conclusion**: the cause is a genuine render-completion delay, worse under
sustained real load, not a structural "rows never queried" problem. Per
the explicit instruction, **no scroll/paging code was added to any of the
three read paths** — the evidence shows it would add complexity for zero
real effect, since scrolling was directly shown, 15/15, to change nothing
on its own. The retry backoff already shipped is validated, not
contradicted, by this session's evidence — it targets exactly the
dimension (elapsed real time) shown here to be the one that actually
matters. Per the non-goal, its magnitude was not re-tuned this session;
that remains for the next real batch run to judge, same as before.
