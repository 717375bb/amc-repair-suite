import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { resetOptionsFilters } from './partDetails.js';
import { findGeneratedOrderNumber, readAssignedTasksAreaText, readCurrentLocationCode } from './selectors.js';
import { routeStationToAeroRepairLocation } from './routing.js';
import { isNoTasksAssignedException } from './noTaskException.js';
import { captureEmptyReadEvidence } from './emptyReadCapture.js';
import { waitBeforeRetry } from './retryBackoff.js';
import { waitForGridResolved, waitForWorkPackageDetailsResolved } from './gridWait.js';
import { AERO_REPAIR_PART_NUMBERS } from './constants.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/** Same escaping used by discovery-search*Production.ts — includes the
 * literal hyphen, needed for part numbers like "5013642-1". */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

export type LineClassification =
  | 'eligible-for-write-up'
  | 'no-task-exception'
  | 'unrecognized-station-exception'
  | 'no-work-package';

export interface DiscoveredLine {
  partNumber: string;
  serialNumber: string;
  linkText: string;
  stationCode: string;
  classification: LineClassification;
  routingLocation: string | null;
  /** Only populated for 'no-work-package' — the real row's raw text, used
   * to compose the Work Package name (Addition 1) and for a human CRA to
   * see the actual Reason For Repair. */
  note: string | null;
}

async function navigateToFilteredGrid(page: Page, todoListUrl: string, partNumber: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.getByRole('link', { name: 'Options...' }).click();
  await pace(page);
  await resetOptionsFilters(page);
  await page.locator('#idOEMPartNo').click();
  await pace(page);
  await page.locator('#idOEMPartNo').fill(partNumber);
  await pace(page);
  await page.locator('#idButtonOptionsOK').click();
  // Content-aware wait, not a fixed pace(): waits for either a matching
  // repair line or the "no inventory" empty-state text — see gridWait.ts
  // for why (business-hours load scaled by result-set size, confirmed by
  // timestamp correlation, not sustained-automation volume).
  await waitForGridResolved(page, partNumber);
}

interface CandidateLine {
  partNumber: string;
  serialNumber: string;
  linkText: string;
  stationCode: string;
}

/**
 * Read-only, one part number: finds EVERY currently-open repair line with
 * no existing order yet — generalizes findFirstRepairLineForPart's
 * single-match logic to every match, not just the first. "No existing
 * order yet" is determined the same real, already-tested way the write-up
 * flow itself does (findGeneratedOrderNumber, row-scoped) — the grid's own
 * default filters (REPREQ/RFB/USSTG) do NOT exclude lines that already
 * have an order (confirmed in an earlier session: an abandoned order on
 * 5013640/JUL14-3229 did not remove that line from the eligible-line
 * grid), so this check is required, not redundant. Station code is read
 * directly from the grid row via readCurrentLocationCode — no clicking,
 * no edit mode, same technique used throughout this module and by every
 * discovery-search*Production.ts script this project has already run.
 */
async function findCandidateLinesForPart(
  page: Page,
  todoListUrl: string,
  partNumber: string,
): Promise<CandidateLine[]> {
  await navigateToFilteredGrid(page, todoListUrl, partNumber);

  const gridText = await page.locator('body').innerText();
  if (gridText.includes('no inventory')) {
    await captureEmptyReadEvidence(page, 'discovery-find-candidates-no-inventory-text', { partNumber });
    return [];
  }

  const repairLinkPattern = new RegExp(`^Repair .*\\(PN: ${escapeRegExp(partNumber)}, SN: [^)]+\\)$`);
  const repairLinks = page.getByRole('link', { name: repairLinkPattern });
  const count = await repairLinks.count();

  if (count === 0) {
    // The page does NOT say "no inventory" — this is the specific
    // suspicious shape the diagnostic investigation was about: a page
    // that doesn't claim to be empty, yet the selector finds nothing.
    await captureEmptyReadEvidence(page, 'discovery-find-candidates-zero-count', { partNumber });
  }

  const candidates: CandidateLine[] = [];
  for (let i = 0; i < count; i++) {
    const linkText = (await repairLinks.nth(i).innerText()).trim();
    const serialMatch = linkText.match(/\(PN: [^,]+, SN: ([^)]+)\)/);
    if (!serialMatch) continue; // shape guaranteed by the pattern above; defensive only

    const existingOrder = await findGeneratedOrderNumber(page, linkText);
    if (existingOrder) continue; // out of scope for this pass — already has an order

    const locationToken = await readCurrentLocationCode(page, linkText);
    const stationCode = locationToken.split('/')[0];

    candidates.push({ partNumber, serialNumber: serialMatch[1], linkText, stationCode });
  }

  return candidates;
}

/**
 * Read-only: clicks into ONE line's repair link to read its default
 * "Assigned Tasks" tab text — the exact same real technique writeUp.ts's
 * own single-line check uses (readAssignedTasksAreaText, called
 * immediately after clicking the repair link, before any further
 * navigation) — and checks the no-tasks-assigned exception. Never enters
 * Edit Lines, Schedule Work Package, Unassigned Tasks, or any other view
 * beyond this one: the Assigned Tasks tab is a read-only landing page,
 * not an edit view, and nothing further is needed for discovery.
 */
async function checkNoTasksException(
  page: Page,
  todoListUrl: string,
  partNumber: string,
  linkText: string,
): Promise<boolean> {
  await navigateToFilteredGrid(page, todoListUrl, partNumber);
  await page.getByRole('link', { name: linkText, exact: true }).click();
  // SYSTEMATIC AUDIT FIX: same vulnerability as writeUp.ts's own repair-
  // link click — readAssignedTasksAreaText() reads the whole page
  // immediately after, with no wait beyond the fixed 750ms pace(). See
  // gridWait.ts's waitForWorkPackageDetailsResolved.
  await waitForWorkPackageDetailsResolved(page);
  const tasksText = await readAssignedTasksAreaText(page);
  return isNoTasksAssignedException(tasksText);
}

/**
 * Read-only, one specific line: re-verifies FRESH whether it's still
 * genuinely eligible (no existing order yet) — never trusts an earlier
 * discovery scan's snapshot. Real, confirmed reason this matters: this is
 * a shared production system (`P000BAL4`'s outbound shipment was moved to
 * dock by another human entirely, between sessions, with zero involvement
 * from this automation) — a line's state at discovery time is not
 * guaranteed to still hold by the time it's actually processed, whether
 * because another CRA created an order for it, or because it's no longer
 * present in the open-inventory grid at all. Returns false for both
 * cases — the caller can't act on a line it can't currently confirm.
 */
async function verifyLineStillEligibleOnce(
  client: MxiClient,
  partNumber: string,
  serialNumber: string,
): Promise<boolean> {
  const page = await client.getAuthenticatedPage();
  await navigateToFilteredGrid(page, client.todoListUrl, partNumber);

  const gridText = await page.locator('body').innerText();
  if (gridText.includes('no inventory')) {
    await captureEmptyReadEvidence(page, 'verify-line-eligible-no-inventory-text', { partNumber, serialNumber });
    return false;
  }

  const repairLinkPattern = new RegExp(`^Repair .*\\(PN: ${escapeRegExp(partNumber)}, SN: [^)]+\\)$`);
  const repairLinks = page.getByRole('link', { name: repairLinkPattern });
  const count = await repairLinks.count();

  for (let i = 0; i < count; i++) {
    const linkText = (await repairLinks.nth(i).innerText()).trim();
    if (!linkText.includes(`SN: ${serialNumber})`)) continue;
    const existingOrder = await findGeneratedOrderNumber(page, linkText);
    return !existingOrder; // found — eligible iff no order exists yet
  }

  // Line not found — either the pattern matched 0 lines at all (count===0,
  // the same suspicious "visibly-not-empty but selector finds nothing"
  // shape this whole investigation is about), or count>0 but none matched
  // this specific serial. Captured either way — this IS the meaningful
  // empty result the caller trusts as "genuinely no longer eligible."
  await captureEmptyReadEvidence(page, 'verify-line-eligible-not-found', { partNumber, serialNumber, candidateCountOnPage: count });
  return false; // line no longer present in the grid at all
}

/**
 * REAL GAP FOUND AND FIXED: this is the exact same grid-navigation-and-
 * search mechanism (navigateToFilteredGrid + repair-link scan +
 * findGeneratedOrderNumber) that findCandidateLinesForPart uses — the
 * mechanism already proven, via three repeated full scans, to intermittently
 * false-report empty/absent results on any given single read (see
 * findCandidateLinesWithRetry's docstring for the full incident). This
 * function did the same grid read as a single, un-retried attempt, with no
 * equivalent protection — a genuinely-eligible line could be, and per a real
 * recurring incident (the same real serial flagged "No Longer Eligible" on
 * two separate days, 07-22 and 07-23) plausibly was, misread as ineligible
 * by a transient failure of this exact same class.
 *
 * Fixed with the identical retry discipline as findCandidateLinesWithRetry:
 * only trusts a `false` (not eligible / not found) result once 3 consecutive
 * attempts all agree. The first attempt that reports `true` (still eligible)
 * wins immediately — a false positive here is not the failure mode this
 * project has ever observed or that this fix targets; only false negatives
 * (a real, still-open line being wrongly skipped) are the concern, matching
 * the sibling function's exact asymmetric trust rule.
 *
 * REAL CAUSE CONFIRMED via captured evidence from a real production run
 * (see retryBackoff.ts's docstring): this function's own captures
 * (`verify-line-eligible-not-found`) were the majority of a dense, ~7.5
 * minute failure cluster that began immediately after 8 consecutive
 * fully-successful write-up cycles — sustained volume, not per-request
 * noise. Same fix as `findCandidateLinesWithRetry`: a real pause
 * (`waitBeforeRetry`) between attempts, not immediate back-to-back
 * re-navigation.
 */
export async function verifyLineStillEligible(
  client: MxiClient,
  partNumber: string,
  serialNumber: string,
  /**
   * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — defaults to 3
   * (unchanged behavior). processLine.ts passes 1 for a main-pass attempt
   * — a retryable "not eligible" result quarantines the line immediately
   * instead of burning inline backoff; the full multi-attempt treatment
   * (with Layer 2's fixed 5s/15s/30s backoff) only runs on the second pass.
   */
  maxAttempts = 1,
): Promise<boolean> {
  const MAX_ATTEMPTS = maxAttempts;
  // With waitForGridResolved in place, verifyLineStillEligibleOnce can now
  // THROW (an inconclusive grid read that never resolved), not just return
  // false. That throw must survive to the caller on the final attempt —
  // "ineligible" may only ever come from a confirmed read (no inventory, or
  // the serial genuinely absent from a real, non-empty grid), never from a
  // read that simply never finished. The backoff below is now a secondary
  // net: it should rarely fire, since waitForGridResolved already gives MXI
  // up to 30s per attempt to resolve on its own.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await verifyLineStillEligibleOnce(client, partNumber, serialNumber);
      lastError = null;
      if (result) return true;
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      const page = await client.getAuthenticatedPage();
      await waitBeforeRetry(page, attempt);
    }
  }
  if (lastError) throw lastError;
  return false; // ineligible on every attempt, each one a confirmed read — trusted as genuinely ineligible
}

/**
 * Full read-only batch discovery across all 6 known Aero Repair part
 * numbers: every currently-open line with no existing order yet,
 * classified into exactly one bucket. Priority order mirrors
 * runAeroRepairWriteUp()'s own real early-return order — the no-tasks
 * check happens (and would short-circuit) BEFORE routing is ever
 * computed — so a line matching both conditions is classified purely as
 * a no-task exception, never double-counted as both.
 *
 * No writes of any kind anywhere: no checkbox checked, no radio selected,
 * no order created, no edit mode entered.
 *
 * REAL BUG FOUND AND FIXED: this originally called
 * `client.getAuthenticatedPage()` exactly once, at the very top, for the
 * ENTIRE multi-part-number, potentially 100+-navigation scan. Found live:
 * a real run reported 0 eligible lines for the two LARGEST part numbers
 * (5013640: 48 real order-less lines; 90001200-1: 21) — both confirmed
 * genuinely present via a direct, independent spot-check moments later.
 * Since `getAuthenticatedPage()`'s session-liveness check (and its
 * one-time re-auth) never runs again after that single initial call, a
 * session that went stale anywhere mid-scan had no chance to be detected
 * or recovered — the rest of the run would silently read whatever
 * degraded/unexpected page state resulted, with no error surfaced
 * anywhere (an empty grid read looks identical to a genuinely-empty
 * result). Fixed (partially): now re-fetches the page via
 * `client.getAuthenticatedPage()` at the start of EVERY part number's own
 * processing — cheap (each part number already starts with a full fresh
 * grid navigation regardless) and gives a stale session a chance to
 * self-heal via the client's own one-time re-auth before an entire part
 * number's real data is silently lost to the count.
 *
 * **That fix alone was not sufficient — confirmed by repeating the full
 * scan three times in a row.** Each run produced a DIFFERENT part number
 * (or two) falsely reporting 0 candidates: run 1 hit `5013640` and
 * `90001200-1`; run 2 (after the per-part-number session-refresh fix)
 * still hit `5013640` alone; run 3 hit `5013641` and `90001200-1` instead
 * (both of which had been genuinely correct in run 2) while `5013640`
 * came back correct that time. No single part number is uniquely
 * afflicted — this is a genuinely intermittent, non-deterministic
 * timing/race condition that can hit any part number's grid read on any
 * given run, not a bug tied to one part number's data or position in the
 * list. Since a real empty result (`90001201-1` consistently showed 0
 * across all three runs) is indistinguishable from a flaky false-zero
 * from a single read alone, **each part number's candidate search is now
 * retried up to 2 additional times (3 attempts total) whenever it comes
 * back empty**, with a fresh page fetch and fresh navigation each retry —
 * the first attempt that finds any candidates at all wins; only a part
 * number that comes back empty on EVERY attempt is trusted as genuinely
 * empty. This doesn't require knowing the exact root cause to be a valid
 * mitigation — a transient failure that recovers on retry, by
 * definition, isn't happening consistently enough to survive 3 tries in
 * a row for the same real, unchanging data.
 *
 * REAL CAUSE CONFIRMED via captured evidence from a real production run
 * (see retryBackoff.ts's docstring for the full account): sustained,
 * continuous automated volume, not a per-request coin flip — so retrying
 * immediately, with no pause between attempts, gave the underlying
 * slowdown no chance to clear before the next attempt hit the exact same
 * degraded window. Now waits (`waitBeforeRetry`, increasing 3s/6s) BETWEEN
 * attempts, not just re-fetching the page immediately.
 */
async function findCandidateLinesWithRetry(
  client: MxiClient,
  partNumber: string,
): Promise<CandidateLine[]> {
  const MAX_ATTEMPTS = 3;
  let lastResult: CandidateLine[] = [];
  // Same reasoning as verifyLineStillEligible above: findCandidateLinesForPart
  // can now throw (waitForGridResolved's inconclusive-read guard), and that
  // throw must survive to the caller on the final attempt rather than being
  // silently swallowed into "empty" — empty may only ever mean a confirmed
  // "no inventory" read.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const page = await client.getAuthenticatedPage();
    try {
      lastResult = await findCandidateLinesForPart(page, client.todoListUrl, partNumber);
      lastError = null;
      if (lastResult.length > 0) return lastResult;
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await waitBeforeRetry(page, attempt);
  }
  if (lastError) throw lastError;
  return lastResult; // empty on every attempt, each one a confirmed read — trusted as genuinely empty
}

/**
 * PART C — real invisible-line gap found and fixed: a real USSTG inventory
 * row can have a completely BLANK Work Package column (no "Repair ...
 * (PN: X, SN: Y)" link at all) while still being a genuine, real open
 * inventory row — confirmed live for 5013641/SEP10-2346 and
 * 90001200-1/NOV14-2591/NOV14-2573, both showing "BAD FROM STOCK" as their
 * real Reason For Repair. repairLinkPattern only ever matches rows that DO
 * have a work package link, so these rows appeared in NO report, exception
 * sheet, or count anywhere — not skipped-and-flagged, entirely absent.
 *
 * Detected structurally, not by hardcoding "BAD FROM STOCK" text — a
 * different blank-work-package reason could exist and should be caught the
 * same way. Confirmed via direct DOM inspection: every real per-line row
 * (with or without a work package) has its own Part No and Serial No as
 * two consecutive plain `<a>` links; a real "no work package" row has that
 * same pair, includes "USSTG", but has no link anywhere matching the
 * repair-link pattern for this part number. Excludes the grid's own
 * admin/wrapper rows — confirmed via direct inspection to be duplicate
 * copies of the entire page (including every real row nested inside one
 * outer `<tr>`) that always contain the literal "Options..." filter-dialog
 * text, which no real per-line row ever does.
 */
export async function findNoWorkPackageLinesForPart(
  page: Page,
  todoListUrl: string,
  partNumber: string,
): Promise<Omit<DiscoveredLine, 'classification' | 'routingLocation'>[]> {
  await navigateToFilteredGrid(page, todoListUrl, partNumber);

  const rows = await page.evaluate(
    ({ pn }: { pn: string }) => {
      const repairLinkRe = new RegExp(`^Repair .*\\(PN: ${pn.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}, SN: [^)]+\\)$`);
      const trs = Array.from(document.querySelectorAll('tr'));
      const found: { serialNumber: string; stationCode: string; note: string }[] = [];

      for (const tr of trs) {
        const text = (tr.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text.includes('USSTG')) continue;
        if (text.includes('Options...')) continue; // admin/wrapper row, not a real line

        const linkTexts = Array.from(tr.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim());
        const pnIdx = linkTexts.indexOf(pn);
        if (pnIdx === -1) continue; // not this part number's own row

        const hasRepairLink = linkTexts.some((t) => repairLinkRe.test(t));
        if (hasRepairLink) continue; // has a work package — not the gap this is about

        const serialNumber = linkTexts[pnIdx + 1];
        if (!serialNumber) continue; // shape guaranteed by every real row seen; defensive only

        // Case-insensitive — MXI's location casing varies by site (confirmed
        // live 2026-08-23: PNS/Repair1/Shop1 alongside DFW/REPAIR1/SHOP1).
        const stationMatch = text.match(/\b([A-Za-z]{3})\/USSTG\b/i);
        found.push({ serialNumber, stationCode: stationMatch?.[1] ?? '', note: text });
      }
      return found;
    },
    { pn: partNumber },
  );

  return rows.map((r) => ({
    partNumber,
    serialNumber: r.serialNumber,
    linkText: '',
    stationCode: r.stationCode,
    note: r.note,
  }));
}

/**
 * CLAUDE_CODE_PROMPT (cancel button) — optional cooperative-cancellation
 * signal, checked once per part number (this loop's natural unit of work,
 * same granularity discoveryRunner.ts already uses between vendors). Never
 * checked mid-Playwright-action — see cancellationWatcher.ts's docstring.
 * Omitted entirely by every other caller (unaffected, undefined is never
 * "aborted").
 */
export async function discoverEligibleLines(client: MxiClient, signal?: AbortSignal): Promise<DiscoveredLine[]> {
  const results: DiscoveredLine[] = [];

  for (const partNumber of AERO_REPAIR_PART_NUMBERS) {
    if (signal?.aborted) break;
    const candidates = await findCandidateLinesWithRetry(client, partNumber);
    const page = await client.getAuthenticatedPage();

    for (const candidate of candidates) {
      const noTasks = await checkNoTasksException(page, client.todoListUrl, partNumber, candidate.linkText);
      if (noTasks) {
        results.push({ ...candidate, classification: 'no-task-exception', routingLocation: null, note: null });
        continue;
      }

      const routing = routeStationToAeroRepairLocation(candidate.stationCode);
      if (routing.status === 'exception') {
        results.push({
          ...candidate,
          classification: 'unrecognized-station-exception',
          routingLocation: null,
          note: null,
        });
      } else {
        results.push({
          ...candidate,
          classification: 'eligible-for-write-up',
          routingLocation: routing.location,
          note: null,
        });
      }
    }

    const noWorkPackageLines = await findNoWorkPackageLinesForPart(page, client.todoListUrl, partNumber);
    for (const line of noWorkPackageLines) {
      results.push({ ...line, classification: 'no-work-package', routingLocation: null });
    }
  }

  return results;
}
