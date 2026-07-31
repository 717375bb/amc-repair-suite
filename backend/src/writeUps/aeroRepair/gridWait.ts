import type { Page } from 'playwright';
import { NO_UNASSIGNED_TASKS_TEXT } from './constants.js';

const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;

/**
 * Real cause confirmed by timestamp correlation across multiple runs (see
 * PHASE2_MXI_WRITER_SPEC.md's "content-aware waits" addendum): failures
 * cluster during business hours on LARGE result sets and vanish off-hours
 * regardless of size, including as the very FIRST action of a fresh
 * session — ruling out sustained-automation-volume as the cause. Real
 * cause: MXI server latency under real concurrent user load, scaled by
 * result-set size. A fixed pace()-then-read can observe the grid before
 * MXI has actually finished responding, at exactly the moment a real
 * result set is large and the server is busy, and silently read 0 rows
 * that would have been non-zero moments later.
 *
 * Waits for a DEFINITIVE end state instead of a fixed delay: either at
 * least one real row for this part number has rendered, or the page's own
 * "no inventory" empty-state text is present. 30s timeout — off-hours this
 * resolves in well under a second, so the high ceiling costs nothing
 * normally and covers the worst loaded case seen so far.
 *
 * REAL BUG FOUND AND FIXED via live testing against production, the first
 * time this ran against 5013641: the initial version of this check looked
 * for a link matching the "Repair ... (PN: X, SN: Y)" work-package pattern
 * specifically — but 5013641's own real inventory (SEP10-2346, the Part C
 * "No Work Package (Bad From Stock)" line) has NO such link at all, and the
 * page never says "no inventory" either (it's genuinely not empty — a real
 * row is there). Neither signal this function checked for could ever fire,
 * so it waited the full 30s and threw, on a part number whose grid had, in
 * fact, already fully rendered. Fixed to check for a real row more
 * generally instead: confirmed via direct DOM inspection that EVERY real
 * per-line row — whether or not it has a work package — has the exact part
 * number as its own plain `<a>` link (the leading "Part No" column, always
 * a link, always exactly equal to the filtered part number). Checking for
 * that instead of the work-package-specific pattern correctly recognizes
 * "real content has rendered" regardless of which kind of line it turns
 * out to be, while still resolving to "no inventory" when genuinely empty.
 *
 * Critical: if NEITHER signal appears within the timeout, this throws
 * rather than letting the caller read an inconclusive 0. Zero must only
 * ever come from MXI genuinely saying "no inventory" — never from a read
 * that simply never got a chance to finish.
 */
export async function waitForGridResolved(page: Page, partNumber: string): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ pn }: { pn: string }) => {
        const hasRealRow = Array.from(document.querySelectorAll('a')).some(
          (a) => (a.textContent ?? '').trim() === pn,
        );
        const bodyText = document.body?.innerText ?? '';
        return hasRealRow || bodyText.includes('no inventory');
      },
      { pn: partNumber },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    // REAL GAP FOUND AND FIXED: a bare rethrow here once masked a genuine
    // `ReferenceError: __name is not defined` (an esbuild/tsx serialization
    // artifact in the sibling function below) as a misleading generic
    // timeout message for 30+ seconds across multiple real attempts before
    // the actual cause was found — see
    // waitForUnassignedTasksSectionResolved's docstring for the full
    // account. Including the real underlying message here means that
    // class of masking can't happen again silently.
    throw new Error(
      `Grid read for part ${partNumber} did not resolve to a definitive state (no real row for this part number ` +
        `AND no "no inventory" empty-state text) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a ` +
        `genuine empty result. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] part ${partNumber} resolved in ${Date.now() - start}ms`);
}

/**
 * Real bug found and fixed via direct evidence, not assumed: a wave of
 * batch-execute runs reported "a real unassigned task is present" on
 * essentially every line, when almost none actually had one.
 * `isUnassignedTaskPresent` is absence-based (true whenever the exact
 * empty-state text is NOT found), so an incomplete read reads as a false
 * "task present" rather than a safe default.
 *
 * Read the real evidence before touching any code: every one of 49 real
 * false-positive reads (spanning both before and after the Part A/B/C
 * session — this is a pre-existing bug, not something those changes
 * introduced) captured in `data/aero-repair-writeup-log.xlsx`'s Exceptions
 * sheet shows the SAME truncation point, verbatim: the page stops right
 * after "Enforce Workscope Order:" — before ever reaching the tab bar
 * ("Assigned Tasks Details Parts Labor Tools Warranty Unassigned"), the
 * "Assign Task to this Work Package" action link, or the Unassigned Tasks
 * table itself. `NO_UNASSIGNED_TASKS_TEXT` was independently confirmed to
 * match a real genuinely-rendered page byte-for-byte (a real passing
 * capture from the same session shows it verbatim) — the constant is not
 * the problem. `navigateToUnassignedTasksView` was never touched by the
 * Part A/B/C session (confirmed by direct code review) and still uses its
 * original fixed 750ms pace() between the two tab clicks; that pace() was
 * always too short for this specific view under real load, this just went
 * unnoticed before because Part B's reachability fix is what now routes
 * far more real lines through this exact check than ever reached it before.
 *
 * Fixed the same way Part A fixed the OEM-grid reads: wait for a
 * DEFINITIVE end state instead of a fixed delay. "Assign Task to this Work
 * Package" is a real, confirmed-present marker of this specific sub-tab
 * having actually rendered (present in the one real passing capture this
 * project has) — once it (or, redundantly, the empty-state text itself)
 * appears, the section is done loading and isUnassignedTaskPresent's own
 * read is trustworthy either way, whether it lands on the empty-state text
 * or on a genuine task row. Whitespace-normalized, same principle as
 * noTaskException.ts's isUnassignedTaskPresent.
 *
 * Critical: if NEITHER signal appears within the timeout, this throws
 * rather than defaulting to "task present" — an inconclusive read must
 * never silently become a blocking positive, same rule as "zero must only
 * come from MXI genuinely saying no inventory."
 */
export async function waitForUnassignedTasksSectionResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    // REAL BUG FOUND AND FIXED via live testing: the first version declared
    // an inner named helper (`const normalize = (s) => ...`) inside this
    // callback. tsx/esbuild wraps named function/const-arrow declarations in
    // a `__name(...)` helper to preserve `.name` — but Playwright serializes
    // ONLY this callback's own source via `.toString()` for browser
    // evaluation, not the surrounding module, so `__name` itself never makes
    // it across. Every real invocation failed with `ReferenceError: __name
    // is not defined` inside the browser, which the outer try/catch then
    // masked as a generic 30s-timeout message — confirmed via a real,
    // isolated page.waitForFunction call with the error surfaced directly,
    // not assumed. Fixed by inlining the normalization with no named
    // intermediate function, the same style waitForGridResolved above
    // already used successfully.
    await page.waitForFunction(
      ({ emptyText }: { emptyText: string }) => {
        const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const normalizedEmptyText = emptyText.replace(/\s+/g, ' ').trim();
        return bodyText.includes('Assign Task to this Work Package') || bodyText.includes(normalizedEmptyText);
      },
      { emptyText: NO_UNASSIGNED_TASKS_TEXT },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Unassigned Tasks section did not resolve to a definitive state (no "Assign Task to this Work Package" ` +
        `marker AND no empty-state text) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a genuine ` +
        `"task present" or "task absent" result. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] unassigned-tasks section resolved in ${Date.now() - start}ms`);
}

/**
 * PART A — real gap found via audit-trail investigation, not reproduction:
 * the single-candidate Ad-Hoc recovery path's "proven" status
 * (isAdHocContinuationProven, now true for production since the real
 * JUN19-4064 continuation on 2026-07-25) only ever proved the SEPARATE
 * `continue-ad-hoc` CLI — a fresh login, fresh navigation, run manually,
 * days later, against a line whose Ad-Hoc task already exists (so its own
 * no-tasks-assigned check trivially passes and the whole ad-hoc-creation
 * block, including reopenRepairLineAfterTaskCreation, is never reached).
 * Confirmed by direct code trace: `reopenRepairLineAfterTaskCreation` has
 * exactly one call site (writeUp.ts, right after createAdHocTaskForCandidate),
 * and `aeroRepairContinueAdHocCli.ts` never imports or calls it. The
 * in-session sequence this function now guards — Ad-Hoc task creation's own
 * Close/Close, re-click the same repair line, and fall straight into
 * navigateToUnassignedTasksView/Schedule Work Package — has never actually
 * been exercised end-to-end by anything, despite the proof flag reading
 * `true`. Two real historical failures (2026-07-23, ids 127/128) show
 * exactly the predicted symptom: "waiting for getByRole('link', { name:
 * 'Unassigned' })" timing out — consistent with reopenRepairLineAfterTaskCreation's
 * fixed 750ms pace() not reliably landing back on Work Package Details
 * before the next click fires, the same class of bug fixed elsewhere in
 * this module.
 *
 * Same content-aware discipline as the rest of this file: wait for a
 * confirmed marker that Work Package Details' default view has actually
 * reloaded — "Schedule Work Package" (the action link every real capture
 * of this page shows) — before proceeding. Throws rather than letting a
 * caller click blindly into whatever page actually loaded.
 *
 * SYSTEMATIC AUDIT (this same session): also used right after the very
 * FIRST time a repair link is clicked (findFirstRepairLineForPart) and
 * right after batchDiscovery.ts's own separate repair-link click
 * (checkNoTasksException) — both land on this exact same page, and both
 * previously read readAssignedTasksAreaText() immediately afterward with
 * no wait beyond the fixed 750ms pace(), the identical vulnerability class
 * this function was built to close. One shared function, not three
 * separate copies, so this can't drift the way escapeRegExp once did.
 */
export async function waitForWorkPackageDetailsResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => (document.body?.innerText ?? '').includes('Schedule Work Package'),
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Work Package Details did not resolve to a definitive state (no "Schedule Work Package" marker) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to proceed on an inconclusive read. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] work-package-details resolved in ${Date.now() - start}ms`);
}

/**
 * SYSTEMATIC AUDIT — generic version of the same content-aware principle,
 * for the remaining whole-body-text reads found by auditing every DOM read
 * in this module (readPartOwnDetails, readOrderRealState,
 * readOutboundShipmentDockState's two reads): wait for a specific marker
 * substring to appear in `document.body.innerText`, 30s timeout, throw
 * explicitly rather than letting the caller read a page that hasn't
 * finished loading. `contextLabel` is just for the error message / log
 * line, so failures are traceable to the actual call site.
 */
export async function waitForBodyTextIncludes(page: Page, markerText: string, contextLabel: string): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ marker }: { marker: string }) => (document.body?.innerText ?? '').includes(marker),
      { marker: markerText },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `${contextLabel} did not resolve to a definitive state (marker text "${markerText}" never appeared) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this read as complete. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] ${contextLabel} resolved in ${Date.now() - start}ms`);
}

/**
 * SYSTEMATIC AUDIT — readTaskDefinitionCandidates (selectors.ts) reads
 * `input[name="aTaskDefinition"]` radios via page.evaluate() immediately
 * after openCreateNewTask's click+750ms pace, with no wait of its own —
 * same vulnerability class as the vendor-bid read: if the Task Selection
 * panel hasn't finished rendering, this would silently see 0 or a partial
 * set of candidates, corrupting the 0/1/2+ classification the whole Ad-Hoc
 * recovery path depends on. Waits until at least one `aTaskDefinition`
 * radio is present (every real no-task line sampled shows at least the
 * always-present PC template plus one repair-relevant candidate) before
 * the real read runs.
 */
export async function waitForTaskDefinitionCandidatesResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('input[name="aTaskDefinition"]').length > 0,
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Task Selection panel did not resolve to a definitive state (no aTaskDefinition radios rendered) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a genuine 0-candidate result. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] task-definition candidates resolved in ${Date.now() - start}ms`);
}

/**
 * SYSTEMATIC AUDIT — findGeneratedOrderNumber (selectors.ts) scopes to the
 * target row then calls `.count()` on an order-number-shaped link
 * immediately after confirmScheduleWorkPackage's click+750ms pace.
 * `.count()` never waits for content, only reports whatever currently
 * matches — the exact same class of bug as the OEM-grid reads, and the
 * most likely real cause of a recurring pattern already seen in production
 * (4 real 'filled'-with-no-order-number rows on 2026-07-29 alone,
 * generatedOrderNumber: null): the order-number link genuinely hadn't
 * rendered yet when `.count()` fired.
 *
 * Deliberately does NOT throw on timeout, unlike the other wait functions
 * in this file: `findGeneratedOrderNumber` returning `null` is already a
 * real, legitimate, well-handled outcome upstream (writeUp.ts records the
 * full filled fields with `generatedOrderNumber: null` and processLine.ts
 * surfaces it as a distinguishable automation error — never silently
 * treated as success). This wait's only job is to stop the read from
 * firing too early; it should not change what a genuine, still-absent
 * order number means after 30 real seconds, and throwing here would
 * discard that already-correct downstream handling for no benefit.
 */
export async function waitForGeneratedOrderNumberSettled(
  page: Page,
  linkText: string,
  orderNumberPatternSource: string,
): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ targetLinkText, patternSource }: { targetLinkText: string; patternSource: string }) => {
        const re = new RegExp(patternSource);
        const links = Array.from(document.querySelectorAll('a'));
        const targetLink = links.find((a) => a.textContent?.trim() === targetLinkText);
        if (!targetLink) return false;
        const tr = targetLink.closest('tr');
        if (!tr) return false;
        return Array.from(tr.querySelectorAll('a')).some((a) => re.test((a.textContent ?? '').trim()));
      },
      { targetLinkText: linkText, patternSource: orderNumberPatternSource },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
    console.log(`[grid-wait] generated-order-number for "${linkText}" appeared in ${Date.now() - start}ms`);
  } catch {
    // Swallowed deliberately — see docstring above. A real 30s absence is
    // treated the same as before this wait existed: findGeneratedOrderNumber
    // still does its own real .count() check right after this and returns
    // null if genuinely still absent, which callers already handle correctly.
    console.log(
      `[grid-wait] generated-order-number for "${linkText}" did not appear within ${GRID_WAIT_TIMEOUT_MS}ms — ` +
        `proceeding to the real check, which may still correctly report null.`,
    );
  }
}

/**
 * PART B — same render-latency root cause as the OEM-grid reads (Part A),
 * in a read that fix never covered: selectVendorRadioForRouting reads the
 * vendor-bid rows via a single immediate `page.evaluate()` right after the
 * caller's fixed 750ms pace(), with no wait of its own. If the bid rows
 * haven't finished rendering yet, the walk sees an incomplete set, never
 * finds the target routingLocation, and throws "Could not find a vendor
 * bid matching routing location" — indistinguishable from a genuine
 * routing/data problem, but actually just a read that fired too early.
 * Recurring, worse under real business-hours load — exactly the pattern
 * already confirmed for the three grid-read paths Part A fixed.
 *
 * Waits for a DEFINITIVE end state before the real evaluation happens:
 * either the target routingLocation is already found (fast path, no need
 * to wait further), or at least as many distinct radio-bearing rows as
 * `expectedBidCount` (the real number of known Aero Repair vendor
 * locations — every real line sampled across this project shows all of
 * them together) have rendered for this line. 30s timeout; throws rather
 * than letting the caller evaluate an incomplete set as "no match."
 */
export async function waitForVendorBidsResolved(
  page: Page,
  linkText: string,
  routingLocation: string,
  expectedBidCount: number,
): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ targetLinkText, location, minBidRows }: { targetLinkText: string; location: string; minBidRows: number }) => {
        const links = Array.from(document.querySelectorAll('a'));
        const targetLink = links.find((a) => a.textContent?.trim() === targetLinkText);
        if (!targetLink) return false;
        const mainTr = targetLink.closest('tr');
        if (!mainTr) return false;

        let current: Element | null = mainTr;
        let isMainRow = true;
        let radioRowCount = 0;
        let foundLocation = false;
        while (current && current.tagName === 'TR') {
          const text = current.textContent ?? '';
          if (!isMainRow && text.includes('INTERCHG')) break;
          if (current.querySelector('input[type="radio"]')) radioRowCount++;
          if (text.includes(location)) foundLocation = true;
          current = current.nextElementSibling;
          isMainRow = false;
        }
        return foundLocation || radioRowCount >= minBidRows;
      },
      { targetLinkText: linkText, location: routingLocation, minBidRows: expectedBidCount },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Vendor bid rows for line "${linkText}" did not resolve to a definitive state (target location "${routingLocation}" ` +
        `not found AND fewer than ${expectedBidCount} bid row(s) rendered) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing ` +
        `to treat this as a genuine "no matching vendor" result. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] vendor bids for "${linkText}" resolved in ${Date.now() - start}ms`);
}
