/// <reference lib="dom" />
import type { Page } from 'playwright';
import { waitForBodyTextIncludes } from './taskRecovery.js';
import { captureUsageTableDiagnostics } from './usageTableDiagnostics.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/partDetails.ts — confirmed vendor-agnostic by
 * a second real vendor (0T1Y4's own recordings open a part's own details
 * view the identical way: check the target line's inventory checkbox,
 * click the identifier link, read, then Close). Pure relocation, no
 * behavior change — re-exported from aeroRepair/partDetails.ts so every
 * existing call site keeps working unchanged.
 */

export interface UsageParmRow {
  /** e.g. "CYCLES" | "HOURS" — as literal a label as the real page shows, not assumed to be only these two. */
  label: string;
  tsn: string;
  tso: string;
  tsi: string;
}

export interface PartOwnDetails {
  partDescription: string;
  partNumber: string;
  serialNumber: string;
  usageRows: UsageParmRow[];
  /**
   * CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md — true iff the real
   * `#idTableCurrentUsage` element was found on the page at all. Distinct
   * from `usageRows.length === 0`: a genuinely BN-override line has NO
   * such table (usageTableFound: false, existing/unchanged behavior); a
   * real line whose table element exists but returned zero data rows
   * (usageTableFound: true, usageRows: []) is a confirmed READ FAILURE —
   * callers must never treat these two as the same state.
   */
  usageTableFound: boolean;
  /** Full raw text of the page at the moment of reading — the reliable field for cross-checking. */
  rawText: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cross-checked live: the raw candidate line reads e.g. "Inventory Details
 * WHEEL ASSY, NLG (PN: 5013640, SN: JUL14-3229)" — a page-title fragment
 * glued to the front, and the same "(PN: X, SN: Y)" segment notes
 * composition already appends on its own. Left unstripped, that segment
 * gets duplicated verbatim in composed Notes text (a real, previously
 * fixed bug) — strips both the leading page-title fragment and the
 * trailing "(PN: ..., SN: ...)" suffix, leaving just the clean part name.
 */
export function extractCleanPartDescription(
  candidateLine: string | undefined,
  partNumber: string,
  serialNumber: string,
): string {
  if (!candidateLine) return '';
  const suffixPattern = new RegExp(
    `\\s*\\(PN:\\s*${escapeRegExp(partNumber)},\\s*(?:SN|BN):\\s*${escapeRegExp(serialNumber)}\\)\\s*$`,
  );
  return candidateLine
    .replace(/^Inventory Details\s+/i, '')
    .replace(suffixPattern, '')
    .trim();
}

const USAGE_TABLE_SELECTOR = '#idTableCurrentUsage';
const USAGE_TABLE_WAIT_TIMEOUT_MS = 30_000;
const USAGE_TABLE_WAIT_POLL_MS = 250;
/**
 * The part-details page's own URL. Confirmed against every captured
 * usage-table read in data/diagnostics — 479 successful reads and all 44
 * genuine BN "table absent" reads are on
 * `/maintenix/web/inventory/InventoryDetails.jsp?aInventory=...`. Matched
 * as a substring so the `aInventory`/`aReturnToPage` query tokens, which
 * differ per line, are irrelevant.
 */
const PART_DETAILS_URL_MARKER = 'InventoryDetails.jsp';
const NUMBER_PATTERN_SOURCE = '^-?\\d+(\\.\\d+)?$';

interface UsageTableProbeResult {
  tableFound: boolean;
  tableHtml: string | null;
  tableInnerText: string | null;
  rows: UsageParmRow[];
}

/**
 * CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md, required change 3 — structure-
 * agnostic row extraction, confirmed against a real captured table
 * (`#idTableCurrentUsage`, real production line 90001201-2/MAY01-0035):
 * a real `<table id="idTableCurrentUsage"><tbody>` with one header `<tr>`
 * (label cell "Usage Parm", value cells "TSN"/"TSO"/"TSI" — all
 * non-numeric) followed by one `<tr>` per usage parameter (a label cell,
 * e.g. "CYCLES"/"HOURS", plus 3 numeric value cells). That real capture
 * used plain `<td>` for every cell (not `<th>`) — but per the explicit
 * instruction this still matches `td, th` so a differently-rendered table
 * (or a different environment) with `<th scope="row">` labels is captured
 * the same way. Rows are identified purely by STRUCTURE — a non-numeric
 * label cell followed by >=3 numeric value cells — never by position index
 * or by hardcoding expected label text, so the header row (all-text value
 * cells) is excluded for free and any real parameter row this environment
 * shows (CYCLES, HOURS, or something else entirely, e.g. ADGDeployments,
 * ADGHours, IDGDisconectTime) is captured identically.
 */
async function probeUsageTable(page: Page): Promise<UsageTableProbeResult> {
  return page.evaluate(
    ({ selector, numberPatternSource }: { selector: string; numberPatternSource: string }) => {
      const table = document.querySelector(selector);
      if (!table) return { tableFound: false, tableHtml: null, tableInnerText: null, rows: [] };

      const numberPattern = new RegExp(numberPatternSource);
      const tbody = table.querySelector('tbody') ?? table;
      const trs = Array.from(tbody.querySelectorAll('tr'));
      const rows: { label: string; tsn: string; tso: string; tsi: string }[] = [];

      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('td, th')).map((c) => (c.textContent ?? '').trim());
        if (cells.length < 4) continue;
        const label = cells[0];
        const numericValues = cells.slice(1).filter((v) => numberPattern.test(v));
        if (label && !numberPattern.test(label) && numericValues.length >= 3) {
          rows.push({ label, tsn: numericValues[0], tso: numericValues[1], tsi: numericValues[2] });
        }
      }

      return {
        tableFound: true,
        tableHtml: (table as HTMLElement).outerHTML,
        tableInnerText: (table as HTMLElement).innerText,
        rows,
      };
    },
    { selector: USAGE_TABLE_SELECTOR, numberPatternSource: NUMBER_PATTERN_SOURCE },
  );
}

/**
 * CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md, required change 2 — REAL BUG
 * FOUND AND FIXED: the previous wait (waitForBodyTextIncludes on the
 * serial number alone) was satisfied by the page's static title/shell,
 * which renders independently of and much faster than the usage table's
 * own data rows — confirmed live via the 2026-08-05 run log (16-34ms
 * resolution vs. 500ms+ for every other wait in the same run). The
 * extractor then read a table whose data rows had not yet populated, on a
 * genuinely non-empty real inventory record, and the caller wrote a
 * header-only Usage Parm block into the note.
 *
 * Waits for a DEFINITIVE end state: either at least one structurally-valid
 * data row has rendered, or the table element is confirmed ABSENT — and
 * "confirmed" now means two things that used to be assumed. We must be
 * positively on the part-details page (see PART_DETAILS_URL_MARKER), and
 * the table must be missing on two consecutive polls. Before 2026-08-25 a
 * missing table element returned instantly as a confirmed-absent table
 * from wherever the browser happened to be, which is the bug documented
 * inside the loop below. 30s timeout, matching this project's standard for
 * genuine render-latency waits.
 *
 * Does NOT throw on timeout itself — returns `timedOut: true` with
 * whatever the last probe saw instead, so the caller (readPartOwnDetails)
 * can capture full evidence (required change 1: "every usage-table read,
 * success AND failure alike") BEFORE deciding whether to throw. Never
 * returns an empty row set silently treated as valid — a caller can never
 * mistake an unfinished render for a confirmed-empty table (standing
 * discipline #1).
 */
async function waitForUsageTableResolved(
  page: Page,
): Promise<{ result: UsageTableProbeResult; timedOut: boolean; reachedDetailsPage: boolean; lastUrl: string }> {
  const start = Date.now();
  const deadline = start + USAGE_TABLE_WAIT_TIMEOUT_MS;
  let last: UsageTableProbeResult = { tableFound: false, tableHtml: null, tableInnerText: null, rows: [] };
  let reachedDetailsPage = false;
  // "Absent" must be observed twice in a row before it is believed, so a
  // page caught mid-render can never be recorded as a confirmed-empty one.
  let consecutiveConfirmedAbsent = 0;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    lastUrl = page.url();
    const onDetailsPage = lastUrl.includes(PART_DETAILS_URL_MARKER);
    if (onDetailsPage) reachedDetailsPage = true;

    last = await probeUsageTable(page);

    // Real data rows are self-evidently definitive wherever we are.
    if (last.rows.length > 0) {
      log.debug(
        { durationMs: Date.now() - start, rowCount: last.rows.length },
        '[grid-wait] usage-table resolved',
      );
      return { result: last, timedOut: false, reachedDetailsPage: true, lastUrl };
    }

    // REAL BUG FOUND AND FIXED (2026-08-25) — this branch used to be
    // `if (!last.tableFound || last.rows.length > 0) return ...`, so a
    // MISSING table element returned IMMEDIATELY as a confirmed-absent
    // table, having waited zero milliseconds. That is only correct for a
    // BN-override line (which genuinely has no Usage Parm table); for
    // every other line it silently converted "the details page has not
    // finished loading" into "this part has no times and cycles".
    //
    // The preceding guard could not catch it either: readPartOwnDetails'
    // waitForBodyTextIncludes(serialNumber) is satisfied by the GRID page,
    // which shows the serial too — so a click that had not yet navigated
    // sailed straight through to a probe of the wrong page.
    //
    // Reported live: on 2026-08-25 every non-BN vendor-code line came back
    // "Expected to find times and cycles but no table was there" while the
    // table was definitely present. Each of those 8 lines took ~14s end to
    // end, not the 30s+ a real timeout costs, which is what pinned it to
    // this instant-return path rather than to the row-parsing timeout.
    //
    // Absent is now only believed once we are positively confirmed to be
    // ON the part-details page. That URL marker is evidence-backed, not
    // assumed: all 523 captured usage-table reads in data/diagnostics —
    // the 479 successful ones AND all 44 genuine BN "table absent" ones —
    // are on InventoryDetails.jsp.
    if (onDetailsPage && !last.tableFound) {
      consecutiveConfirmedAbsent++;
      if (consecutiveConfirmedAbsent >= 2) {
        log.debug(
          { durationMs: Date.now() - start, url: lastUrl },
          '[grid-wait] usage-table confirmed absent on the part-details page (BN-override case)',
        );
        return { result: last, timedOut: false, reachedDetailsPage, lastUrl };
      }
    } else {
      consecutiveConfirmedAbsent = 0;
    }

    await page.waitForTimeout(USAGE_TABLE_WAIT_POLL_MS);
  }

  log.debug(
    { timeoutMs: USAGE_TABLE_WAIT_TIMEOUT_MS, reachedDetailsPage, url: lastUrl, tableFound: last.tableFound },
    '[grid-wait] usage-table did NOT resolve — refusing to treat this as a genuine empty/absent table',
  );
  return { result: last, timedOut: true, reachedDetailsPage, lastUrl };
}

/**
 * Opens the part's own details view: checks the target line's inventory
 * checkbox and a vendor radio (scoped to the row matching the known-unique
 * repair-link text, if any radio is present), then clicks the identifier
 * link (serial number, or a BN value) to open the details page.
 */
export async function openPartOwnDetails(page: Page, linkText: string, identifierLinkText: string): Promise<void> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');

  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);

  const vendorRadios = targetTr.getByRole('radio');
  if ((await vendorRadios.count()) > 0) {
    await vendorRadios.first().check();
    await pace(page);
  }

  await page.getByRole('link', { name: identifierLinkText, exact: true }).click();
  await pace(page);
}

/** Closes the part-details view opened by openPartOwnDetails(). Lands back on the filtered grid. */
export async function closePartOwnDetails(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * Reads the part's own details view via direct DOM text extraction. No
 * specific container ID is assumed — reads the whole page body, matching
 * this project's rule against fabricating selectors for content not
 * directly inspected. partNumber/serialNumber are passed in from the
 * caller rather than re-parsed from this page.
 */
export async function readPartOwnDetails(
  page: Page,
  partNumber: string,
  serialNumber: string,
): Promise<PartOwnDetails> {
  // ORDER MATTERS, and it changed on 2026-08-25. The usage-table wait runs
  // FIRST because it is the only step that positively establishes we are
  // on the part-details page at all (it polls the URL — see its loop).
  // Everything read below depends on that: `rawText` feeds
  // partDescription, and the previous ordering read it after a
  // waitForBodyTextIncludes(serialNumber) that the GRID also satisfies, so
  // on a slow navigation the description could be parsed off the grid.
  //
  // Doing it in this order also keeps ONE 30s budget for the whole read
  // rather than two stacked ones.
  const { result: usageTableResult, timedOut, reachedDetailsPage, lastUrl } =
    await waitForUsageTableResolved(page);

  // CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md, required change 1 — evidence
  // capture on EVERY usage-table read, success AND failure alike — so this
  // runs regardless of timedOut, BEFORE the throw below.
  await captureUsageTableDiagnostics(page, {
    partNumber,
    serialNumber,
    resolvedBy: timedOut
      ? `waitForUsageTableResolved — TIMED OUT after ${USAGE_TABLE_WAIT_TIMEOUT_MS}ms (reachedDetailsPage=${reachedDetailsPage}, tableFound=${usageTableResult.tableFound}, url=${lastUrl})`
      : usageTableResult.rows.length > 0
        ? 'waitForUsageTableResolved — >=1 structurally-valid data row found'
        : `waitForUsageTableResolved — table element confirmed absent on ${PART_DETAILS_URL_MARKER} (BN-override case)`,
    rowSelectorDescription:
      `document.querySelector('${USAGE_TABLE_SELECTOR}') -> tbody -> querySelectorAll('tr') -> ` +
      'rows with a non-numeric label cell + >=3 numeric value cells (td or th)',
    matchedRowCount: usageTableResult.rows.length,
    tableHtml: usageTableResult.tableHtml,
    tableInnerText: usageTableResult.tableInnerText,
    parsedRows: usageTableResult.rows,
    // A failed read always leaves evidence, gate or no gate.
    force: timedOut,
  });

  if (timedOut) {
    // Two genuinely different failures, kept distinct so a recurrence
    // names its own cause instead of needing another investigation. The
    // 2026-08-25 report ("the table is there, definitely") was hard to
    // diagnose precisely because both collapsed into one vague outcome.
    if (!reachedDetailsPage) {
      throw new Error(
        `part_details_page_not_reached: never landed on ${PART_DETAILS_URL_MARKER} for ` +
          `${partNumber}/${serialNumber} within ${USAGE_TABLE_WAIT_TIMEOUT_MS}ms — last URL was "${lastUrl}". ` +
          `The usage table was never actually looked for on the right page, so its absence proves nothing ` +
          `about whether this part has times and cycles.`,
      );
    }
    throw new Error(
      `usage_table_rows_empty: Usage table (#idTableCurrentUsage) for ${partNumber}/${serialNumber} did not ` +
        `resolve to a definitive state (table element found but 0 structurally-valid data rows) within ` +
        `${USAGE_TABLE_WAIT_TIMEOUT_MS}ms on "${lastUrl}" — refusing to treat this as a genuine empty/absent table.`,
    );
  }

  // Only now is the page confirmed to be the part-details page, so the
  // description is guaranteed to be parsed off it rather than off the grid.
  await waitForBodyTextIncludes(page, serialNumber, `Part own details for ${partNumber}/${serialNumber}`);
  const rawText = await page.locator('body').innerText();

  const descriptionLine = rawText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(partNumber) && line.includes(serialNumber));

  return {
    partDescription: extractCleanPartDescription(descriptionLine, partNumber, serialNumber),
    partNumber,
    serialNumber,
    usageRows: usageTableResult.rows,
    usageTableFound: usageTableResult.tableFound,
    rawText,
  };
}
