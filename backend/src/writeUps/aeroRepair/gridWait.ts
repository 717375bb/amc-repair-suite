import type { Page } from 'playwright';

/**
 * waitForBodyTextIncludes, waitForWorkPackageDetailsResolved,
 * waitForTaskDefinitionCandidatesResolved, waitForGeneratedOrderNumberSettled,
 * and (as of this pass) waitForUnassignedTasksSectionResolved all moved to
 * backend/src/writeUps/shared/ (confirmed vendor-agnostic — reused as-is by
 * 0T1Y4). Re-exported here so existing call sites in this module keep
 * working unchanged. waitForGridResolved and waitForVendorBidsResolved stay
 * here — genuinely Aero-Repair-specific (station-routing grid reads, vendor
 * bid rows tied to the 12-station routing table).
 */
export { waitForBodyTextIncludes, waitForWorkPackageDetailsResolved, waitForTaskDefinitionCandidatesResolved } from '../shared/taskRecovery.js';
export { waitForGeneratedOrderNumberSettled } from '../shared/scheduleWorkPackageForm.js';
export { waitForUnassignedTasksSectionResolved } from '../shared/unassignedTasks.js';

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
