import type { Page } from 'playwright';
import { captureVendorBidDiagnostics, type VendorBidRowEvidence } from './emptyReadCapture.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

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
 *
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 1 — REAL ROOT CAUSE FOUND:
 * "at least one real row rendered" was too weak a completion signal for a
 * LARGE result set under business-hours load. A real production run
 * against `90001200-1` (21 real open lines — the largest known part
 * number) hit `Preferred serial ... not found among 0 candidate lines`
 * SEVEN times in one 53-order batch, always on this specific part number.
 * Root cause, confirmed by re-reading this function: the moment row 1
 * renders, this resolves "done" — while rows 2-21 (including whichever
 * specific serial the caller actually wants) are still streaming in. Every
 * downstream caller then reads a genuinely incomplete grid as final,
 * exactly the "partial grid read as complete" failure class this whole
 * fix addresses (2 other real symptoms — `unassigned_task_state_indeterminate`
 * and a raw `locator.click` timeout waiting for "Unassigned" — trace to
 * the same class of bug in sibling wait functions, not this one).
 *
 * Fixed to require a STRONGER completion signal per the explicit fix
 * spec: the real per-line row count (same signal this function already
 * used to detect "any row at all" — every real row, with or without a
 * work package, has its own part number as a plain `<a>` link, confirmed
 * in this file's own docstring above) must be STABLE across two
 * consecutive polls, not just present once. A grid still streaming rows in
 * will show an increasing count between polls and keep waiting; a grid
 * that has genuinely finished shows the same count twice in a row. Zero
 * rows never resolves via stability — only the explicit "no inventory"
 * text can conclude an empty result, unchanged from before.
 */
const GRID_STABILITY_POLL_MS = 600;

async function readGridState(
  page: Page,
  partNumber: string,
): Promise<{ rowCount: number; noInventory: boolean }> {
  return page.evaluate(({ pn }: { pn: string }) => {
    const rowCount = Array.from(document.querySelectorAll('a')).filter(
      (a) => (a.textContent ?? '').trim() === pn,
    ).length;
    const noInventory = (document.body?.innerText ?? '').includes('no inventory');
    return { rowCount, noInventory };
  }, { pn: partNumber });
}

export async function waitForGridResolved(page: Page, partNumber: string): Promise<void> {
  const start = Date.now();
  const deadline = start + GRID_WAIT_TIMEOUT_MS;

  let previous = await readGridState(page, partNumber);
  if (previous.noInventory) {
    log.debug({ partNumber, durationMs: Date.now() - start, reason: 'no_inventory' }, '[grid-wait] resolved');
    return;
  }

  while (Date.now() < deadline) {
    await page.waitForTimeout(GRID_STABILITY_POLL_MS);
    const current = await readGridState(page, partNumber);
    if (current.noInventory) {
      log.debug({ partNumber, durationMs: Date.now() - start, reason: 'no_inventory' }, '[grid-wait] resolved');
      return;
    }
    if (current.rowCount > 0 && current.rowCount === previous.rowCount) {
      log.debug(
        { partNumber, durationMs: Date.now() - start, reason: 'stable_row_count', rowCount: current.rowCount },
        '[grid-wait] resolved',
      );
      return;
    }
    previous = current;
  }

  // REAL GAP FOUND AND FIXED: a bare rethrow here once masked a genuine
  // `ReferenceError: __name is not defined` (an esbuild/tsx serialization
  // artifact in the sibling function below) as a misleading generic
  // timeout message for 30+ seconds across multiple real attempts before
  // the actual cause was found — see
  // waitForUnassignedTasksSectionResolved's docstring for the full
  // account. Kept as a plain descriptive throw here (no wrapped `err` to
  // preserve now that this is a manual poll loop, not `waitForFunction`).
  throw new Error(
    `Grid read for part ${partNumber} did not resolve to a stable state (row count never repeated across two ` +
      `consecutive polls, and no "no inventory" empty-state text appeared) within ${GRID_WAIT_TIMEOUT_MS}ms — ` +
      `refusing to treat this as a genuine result. Last observed row count: ${previous.rowCount}.`,
  );
}

export interface VendorBidRow {
  /** 0 = the line's own main row; 1+ = sibling bid rows, in DOM order. */
  index: number;
  /** Whitespace-normalized innerText of this row. */
  text: string;
  hasRadio: boolean;
  /** Resolves to this row's own radio input — click this to select the bid. */
  radio: import('playwright').Locator;
  /** Resolves to the row's own <tr> — used for HTML-dump diagnostics regardless of hasRadio. */
  tr: import('playwright').Locator;
}

function normalizeRowText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Walks the line's own main `<tr>` (found via Playwright's accessible-name
 * locator — see the real root-cause finding below) then its sibling `<tr>`s,
 * stopping at (not including) the first sibling whose text contains
 * "INTERCHG" — that boundary marks the start of the NEXT line's own main
 * row. Returns `{ targetLinkFound: false, rows: [] }` if the repair link
 * itself can't currently be resolved on the page at all.
 *
 * REAL BUG FOUND AND FIXED via a live production capture (see
 * emptyReadCapture.ts's captureVendorBidDiagnostics docstring for the full
 * account): this used to walk via a raw `document.querySelectorAll('a')` +
 * `a.textContent?.trim() === linkText` comparison inside a `page.evaluate()`
 * — for every wheel line tested (5/5) this matched fine, but for EVERY
 * brake line (6/6) it matched ZERO elements, confirmed directly
 * ("Target repair link found in DOM at all: false" for a page that had, in
 * fact, fully rendered). Same whitespace-normalization class of bug already
 * fixed for the OEM-grid/unassigned-tasks reads elsewhere in this project —
 * raw `textContent` and Playwright's own accessible-name resolution
 * (`.innerText()`, `getByRole(...,{exact:true})`) don't always agree on
 * exactly which whitespace is collapsed. Now uses the SAME
 * locator-resolution mechanism as every other reliable row-finder in this
 * module (readCurrentLocationCode, findGeneratedOrderNumber,
 * recheckRepairLineForSchedule) instead of a second, independently-fallible
 * raw-DOM re-implementation.
 */
export async function collectVendorBidRows(
  page: Page,
  linkText: string,
): Promise<{ targetLinkFound: boolean; rows: VendorBidRow[] }> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  if ((await repairLink.count()) === 0) {
    return { targetLinkFound: false, rows: [] };
  }
  const mainTr = repairLink.locator('xpath=ancestor::tr[1]');
  const mainRadio = mainTr.locator('input[type="radio"]');
  const rows: VendorBidRow[] = [
    {
      index: 0,
      text: normalizeRowText(await mainTr.innerText()),
      hasRadio: (await mainRadio.count()) > 0,
      radio: mainRadio.first(),
      tr: mainTr,
    },
  ];

  const siblingTrs = mainTr.locator('xpath=following-sibling::tr');
  const siblingCount = await siblingTrs.count();
  for (let i = 0; i < siblingCount; i++) {
    const sib = siblingTrs.nth(i);
    const text = normalizeRowText(await sib.innerText());
    if (text.includes('INTERCHG')) break; // next line's own main row
    const radio = sib.locator('input[type="radio"]');
    rows.push({ index: i + 1, text, hasRadio: (await radio.count()) > 0, radio: radio.first(), tr: sib });
  }
  return { targetLinkFound: true, rows };
}

async function captureRowEvidence(rows: VendorBidRow[]): Promise<VendorBidRowEvidence[]> {
  const evidence: VendorBidRowEvidence[] = [];
  for (const row of rows) {
    const html = await row.tr.evaluate((el) => el.outerHTML).catch(() => '(could not read outerHTML)');
    evidence.push({ index: row.index, text: row.text, html, hasRadio: row.hasRadio });
  }
  return evidence;
}

/**
 * PART B — same render-latency root cause as the OEM-grid reads (Part A),
 * in a read that fix never covered: selectVendorRadioForRouting used to
 * read the vendor-bid rows via a single immediate `page.evaluate()` right
 * after the caller's fixed 750ms pace(), with no wait of its own.
 *
 * Defect 1 rewrite: the hardcoded ">= 4 known vendor locations" threshold
 * is gone — it encoded an assumption (every line has exactly the 4 wheel
 * locations) that real brake lines can violate in ways never enumerated.
 * The only thing this function waits for now is "the bid region has
 * rendered at all" — at least one radio-bearing row found in the line's own
 * row span. Whether the SPECIFIC target routingLocation is among them is a
 * separate classification step, done by the caller
 * (selectVendorRadioForRouting) once this resolves — a definitively
 * rendered bid list that genuinely lacks the target location is a real,
 * actionable "Vendor Bid Not Found" exception, not an indeterminate-state
 * timeout.
 *
 * Only throws (and captures full structural diagnostics) when NO
 * radio-bearing row is found at all within 30s — a genuinely indeterminate
 * read, never treated as "no bids."
 */
export async function waitForVendorBidsResolved(page: Page, linkText: string): Promise<VendorBidRow[]> {
  const start = Date.now();
  const deadline = start + GRID_WAIT_TIMEOUT_MS;
  let targetLinkFound = false;
  let rows: VendorBidRow[] = [];

  while (Date.now() < deadline) {
    const result = await collectVendorBidRows(page, linkText);
    targetLinkFound = result.targetLinkFound;
    rows = result.rows;
    if (rows.some((r) => r.hasRadio)) {
      log.debug(
        { linkText, durationMs: Date.now() - start, bidRowCount: rows.filter((r) => r.hasRadio).length },
        '[grid-wait] vendor bids resolved',
      );
      return rows;
    }
    await page.waitForTimeout(GRID_WAIT_POLL_MS);
  }

  const evidence = await captureRowEvidence(rows);
  await captureVendorBidDiagnostics(page, linkText, evidence, targetLinkFound);
  throw new Error(
    `Vendor bid rows for line "${linkText}" did not resolve to a definitive state (0 radio-bearing bid rows found, ` +
      `target link resolved: ${targetLinkFound}) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a ` +
      `genuine "no bids" result.`,
  );
}
