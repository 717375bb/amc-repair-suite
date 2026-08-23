import { addDays, formatISO } from 'date-fns';
import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { toMxiDateFormat } from './esdFormatting.js';
import { createLogger } from '../logging/logger.js';
import {
  attemptCancelEdit,
  confirmEsdLineEdit,
  findOrderByNumber,
  readEsdField,
  readIssuedCount,
  updateEsdField,
} from './selectors.js';
import {
  clickIssueOrderTolerant,
  countOrderLines,
  isReauthorizationNeeded,
  performReauthorization,
  readLineSerialNumber,
  readUnitPrice,
  updatePriceType,
  updateUnitPrice,
  type IssueControlResult,
} from './priceLineSelectors.js';

const log = createLogger('mxi');

export type PriceLineOutcome =
  | 'written'
  /**
   * HISTORICAL ONLY — no longer produced. The serial cross-check was
   * removed 2026-08-23 (see writePriceLineUpdate below). Kept in the union
   * because real invoice_price_writes rows already carry this value and
   * still need to read back meaningfully.
   */
  | 'skipped_serial_mismatch'
  | 'skipped_order_not_found'
  | 'skipped_multi_line'
  | 'failed';

export interface PriceLineUpdateResult {
  status: 'success' | 'failed' | 'skipped';
  outcome: PriceLineOutcome;
  originalPrice: string | null;
  serialNumberMxi: string | null;
  /**
   * Plain-English record of the authorize/issue step — whether the order was
   * already authorized, which Issue control was clicked, and whether the
   * issued count actually moved. Present on success too: "already authorized,
   * issue clicked" is a normal outcome worth seeing, not just an error case.
   */
  issueDetail: string | null;
  errorMessage: string | null;
}

function tomorrowInMxiFormat(): string {
  const tomorrowIso = formatISO(addDays(new Date(), 1), { representation: 'date' });
  return toMxiDateFormat(tomorrowIso);
}

/**
 * Real bug found live, user-reported: MXI pads Unit Price to two decimal
 * places on display/re-read (e.g. "941.70"), but the sheet's own "Extended
 * Amt" cell frequently has fewer ("941.7") — a plain string comparison
 * flagged every one of these as a verification failure even though the
 * write genuinely succeeded. Compares numerically instead, in integer
 * cents (not raw float equality, which is exactly the kind of thing that
 * silently breaks on currency values) so "941.70" and "941.7" — or any
 * other equivalent decimal formatting — correctly match.
 */
function parsePriceToCents(value: string): number | null {
  const numeric = Number(value.replace(/,/g, '').trim());
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

/**
 * Turns the issue step's raw evidence into one plain-English line for the
 * audit trail and the UI.
 *
 * Deliberately descriptive rather than pass/fail: the ONLY thing that makes
 * this write a failure is price or ESD not verifying (below). An order that
 * was already authorized and already issued is a normal, successful
 * outcome, not an error — which is the exact case that used to be reported
 * as a failure.
 */
function describeIssueOutcome(
  authWasNeeded: boolean,
  issue: IssueControlResult,
  issuedBefore: number | null,
  issuedAfter: number | null,
  confirmationShown: boolean,
): string {
  const authPart =
    (authWasNeeded ? 'Authorization was requested' : 'Already authorized (no Request Authorization action present)') +
    (confirmationShown ? '; re-issue warning confirmed' : '; no re-issue warning shown');

  if (issue.clicked) {
    const committed =
      issuedBefore !== null && issuedAfter !== null && issuedAfter > issuedBefore
        ? `issued count ${issuedBefore} -> ${issuedAfter}`
        : `issued count ${issuedAfter ?? '(unreadable)'} (no confirmed increment)`;
    return `${authPart}; clicked "${issue.label}"; ${committed}.`;
  }

  if (issue.candidates.length > 1) {
    return (
      `${authPart}; did NOT issue — several ambiguous issue-like actions were present ` +
      `(${issue.candidates.join(', ')}) and guessing which one issues a real order is not safe.`
    );
  }

  return (
    `${authPart}; no Issue action was present on the page. ` +
    `Issued count reads ${issuedAfter ?? '(unreadable)'} — if that is 1 or more the order was already issued.`
  );
}

function pricesMatch(confirmed: string | null, expected: string): boolean {
  if (confirmed === null) return false;
  const confirmedCents = parsePriceToCents(confirmed);
  const expectedCents = parsePriceToCents(expected);
  return confirmedCents !== null && expectedCents !== null && confirmedCents === expectedCents;
}

/**
 * Shared price-line orchestrator for the Invoice Price Writer AND the
 * Vendor Quote Writer, mirroring writeEsdAndNotes()'s shape: navigate,
 * read-before-write for evidence, then price/type/date/confirm/
 * reauth-if-needed/issue, then independently re-verify the real outcome
 * afterward — same "always re-verify, never trust the attempt alone"
 * discipline as every other MXI write in this project.
 *
 * NOTE: the serial-number cross-check that used to veto a write here was
 * removed by explicit user direction (see inline comment below) — PSA's BN
 * system means our serial routinely differs from the vendor's. The serial
 * is still read and recorded; it just no longer blocks.
 *
 * Only called from an explicit, human-triggered batch action (the Invoice
 * Price Writer job runner, itself only started by a logged-in analyst
 * uploading a specific file and clicking Run) — never automatic/unattended.
 */
export async function writePriceLineUpdate(
  client: MxiClient,
  orderNumber: string,
  sheetSerialNumber: string,
  newPrice: string,
  password: string,
  /**
   * Promise By date to write, already in MXI's DD-MMM-YYYY format.
   *
   * OMITTED (the Invoice Price Writer's own behavior, unchanged): defaults
   * to tomorrow. Those orders are typically already received, so the date
   * no longer means anything — it just must not be stale.
   *
   * SUPPLIED by the Vendor Quote Writer: the ESD derived from the vendor's
   * own quote, which is a real forward-looking promise the receiving side
   * will actually rely on. Optional-with-a-default specifically so adding
   * this second caller changes nothing about the already-live first one.
   */
  promiseByDate?: string,
): Promise<PriceLineUpdateResult> {
  let page: Page | undefined;
  /**
   * What actually happened at the authorize/issue step. Declared out here
   * so it survives into the result and the catch block — an order that was
   * already authorized and simply needed Issue clicked should be able to
   * SAY that, whatever else happens afterward.
   */
  let issueDetail: string | null = null;

  try {
    page = await client.getAuthenticatedPage();
    await findOrderByNumber(page, orderNumber, client.todoListUrl);

    const lineCount = await countOrderLines(page);
    if (lineCount === 0) {
      return {
        status: 'skipped',
        outcome: 'skipped_order_not_found',
        originalPrice: null,
        serialNumberMxi: null,
        issueDetail: null,
        errorMessage: `No order line found for ${orderNumber} after opening Edit Lines.`,
      };
    }
    if (lineCount > 1) {
      return {
        status: 'skipped',
        outcome: 'skipped_multi_line',
        originalPrice: null,
        serialNumberMxi: null,
        issueDetail: null,
        errorMessage: `Order ${orderNumber} has ${lineCount} lines on Edit Lines — skipping rather than guessing which one to update (this project's existing limitation: only single-line orders are handled).`,
      };
    }

    // Read-before-write, evidence captured regardless of what happens next.
    //
    // REMOVED (per explicit user direction, 2026-08-23): this used to hard-
    // skip the write when the MXI line's serial number didn't match the
    // caller's. It read as a strong failsafe, but PSA's internal BN system
    // means our serial legitimately and routinely differs from the
    // vendor's, so the check rejected correct writes far more often than it
    // caught real problems.
    //
    // The serial is still READ and still recorded on every row — the
    // evidence is kept, only the veto is gone, so a genuine mismatch stays
    // auditable after the fact. The order number remains the identifying
    // key, and it comes from the quote/sheet itself; countOrderLines()
    // above still refuses to guess on a multi-line order.
    const serialNumberMxi = await readLineSerialNumber(page);
    const originalPrice = await readUnitPrice(page);

    if (serialNumberMxi && sheetSerialNumber) {
      const normalize = (value: string) => value.trim().toUpperCase();
      if (normalize(serialNumberMxi) !== normalize(sheetSerialNumber)) {
        log.info(
          { orderNumber, serialNumberMxi, callerSerialNumber: sheetSerialNumber },
          'serial numbers differ (expected under the BN system) — proceeding, check disabled by design',
        );
      }
    }

    const promiseBy = promiseByDate ?? tomorrowInMxiFormat();

    await updateUnitPrice(page, newPrice);
    await updatePriceType(page, 'QUOTE');
    await updateEsdField(page, promiseBy);
    // confirmationShown tells us whether MXI raised the "this line will
    // need to be re-issued" warning. It doesn't on an order that doesn't
    // require re-issue — which used to hang this call for 30s and then
    // throw. Recorded because it's the clearest signal of which path an
    // order took.
    const { confirmationShown } = await confirmEsdLineEdit(page);

    // Real, detectable page state — not a guessed business rule for when
    // authorization is/isn't required.
    const authWasNeeded = await isReauthorizationNeeded(page);
    if (authWasNeeded) {
      await performReauthorization(page, password);
    }

    // Issue is required in BOTH cases — whether we just authorized, or the
    // order was ALREADY authorized and showed no Request Authorization
    // action at all (per explicit user direction, 2026-08-21: that second
    // case still needs Issue clicked, and still counts as a success).
    //
    // Before/after "Issued: N times" is what actually proves the click
    // took. This project has already documented an Issue Order click that
    // reports no error yet doesn't commit (see writeEsdAndNotes.ts's
    // reissueOrder reliability gap), so the click's own apparent success is
    // not trusted here either.
    const issuedBefore = await readIssuedCount(page);
    const issueResult = await clickIssueOrderTolerant(page);
    const issuedAfter = await readIssuedCount(page);

    issueDetail = describeIssueOutcome(authWasNeeded, issueResult, issuedBefore, issuedAfter, confirmationShown);

    // Independent re-verification, regardless of whether anything above
    // threw — same discipline as writeEsdAndNotes().
    await findOrderByNumber(page, orderNumber, client.todoListUrl);
    const confirmedPrice = await readUnitPrice(page);
    const confirmedEsd = await readEsdField(page);

    const priceOk = pricesMatch(confirmedPrice, newPrice);
    const esdOk = confirmedEsd === promiseBy;

    if (!priceOk || !esdOk) {
      const problems: string[] = [];
      if (!priceOk) problems.push(`price re-read as "${confirmedPrice ?? '(blank)'}", expected "${newPrice}"`);
      if (!esdOk) problems.push(`Promise By re-read as "${confirmedEsd ?? '(blank)'}", expected "${promiseBy}"`);
      return {
        status: 'failed',
        outcome: 'failed',
        originalPrice,
        serialNumberMxi,
        issueDetail,
        errorMessage: `Write did not verify: ${problems.join('; ')}${issueDetail ? ` | ${issueDetail}` : ''}`,
      };
    }

    return { status: 'success', outcome: 'written', originalPrice, serialNumberMxi, issueDetail, errorMessage: null };
  } catch (err) {
    if (page) {
      await attemptCancelEdit(page);
    }
    return {
      status: 'failed',
      outcome: 'failed',
      issueDetail,
      originalPrice: null,
      serialNumberMxi: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
