import { addDays, formatISO } from 'date-fns';
import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { toMxiDateFormat } from './esdFormatting.js';
import {
  attemptCancelEdit,
  confirmEsdLineEdit,
  findOrderByNumber,
  readEsdField,
  reissueOrder,
  updateEsdField,
} from './selectors.js';
import {
  countOrderLines,
  isReauthorizationNeeded,
  performReauthorization,
  readLineSerialNumber,
  readUnitPrice,
  updatePriceType,
  updateUnitPrice,
} from './priceLineSelectors.js';

export type PriceLineOutcome =
  | 'written'
  | 'skipped_serial_mismatch'
  | 'skipped_order_not_found'
  | 'skipped_multi_line'
  | 'failed';

export interface PriceLineUpdateResult {
  status: 'success' | 'failed' | 'skipped';
  outcome: PriceLineOutcome;
  originalPrice: string | null;
  serialNumberMxi: string | null;
  errorMessage: string | null;
}

function tomorrowInMxiFormat(): string {
  const tomorrowIso = formatISO(addDays(new Date(), 1), { representation: 'date' });
  return toMxiDateFormat(tomorrowIso);
}

/**
 * Invoice Price Writer's combined orchestrator, mirroring
 * writeEsdAndNotes()'s shape: navigate, read-before-write for the
 * serial-number cross-check (skip immediately, no mutation at all, on a
 * mismatch), then price/type/date/confirm/reauth-if-needed/reissue, then
 * independently re-verify the real outcome afterward — same "always
 * re-verify, never trust the attempt alone" discipline as every other MXI
 * write in this project.
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
): Promise<PriceLineUpdateResult> {
  let page: Page | undefined;

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
        errorMessage: `No order line found for ${orderNumber} after opening Edit Lines.`,
      };
    }
    if (lineCount > 1) {
      return {
        status: 'skipped',
        outcome: 'skipped_multi_line',
        originalPrice: null,
        serialNumberMxi: null,
        errorMessage: `Order ${orderNumber} has ${lineCount} lines on Edit Lines — skipping rather than guessing which one to update (this project's existing limitation: only single-line orders are handled).`,
      };
    }

    // Read-before-write, evidence captured regardless of what happens next.
    const serialNumberMxi = await readLineSerialNumber(page);
    const originalPrice = await readUnitPrice(page);

    const normalize = (value: string | null) => (value ?? '').trim().toUpperCase();
    if (normalize(serialNumberMxi) !== normalize(sheetSerialNumber)) {
      await attemptCancelEdit(page);
      return {
        status: 'skipped',
        outcome: 'skipped_serial_mismatch',
        originalPrice,
        serialNumberMxi,
        errorMessage: `Serial number mismatch: sheet says "${sheetSerialNumber}", MXI shows "${serialNumberMxi ?? '(none found)'}" — refusing to write.`,
      };
    }

    const promiseByTomorrow = tomorrowInMxiFormat();

    await updateUnitPrice(page, newPrice);
    await updatePriceType(page, 'QUOTE');
    await updateEsdField(page, promiseByTomorrow);
    await confirmEsdLineEdit(page);

    // Real, detectable page state — not a guessed business rule for when
    // authorization is/isn't required.
    if (await isReauthorizationNeeded(page)) {
      await performReauthorization(page, password);
    }

    await reissueOrder(page);

    // Independent re-verification, regardless of whether anything above
    // threw — same discipline as writeEsdAndNotes().
    await findOrderByNumber(page, orderNumber, client.todoListUrl);
    const confirmedPrice = await readUnitPrice(page);
    const confirmedEsd = await readEsdField(page);

    const priceOk = confirmedPrice !== null && confirmedPrice.replace(/,/g, '') === newPrice.replace(/,/g, '');
    const esdOk = confirmedEsd === promiseByTomorrow;

    if (!priceOk || !esdOk) {
      const problems: string[] = [];
      if (!priceOk) problems.push(`price re-read as "${confirmedPrice ?? '(blank)'}", expected "${newPrice}"`);
      if (!esdOk) problems.push(`Promise By re-read as "${confirmedEsd ?? '(blank)'}", expected "${promiseByTomorrow}"`);
      return {
        status: 'failed',
        outcome: 'failed',
        originalPrice,
        serialNumberMxi,
        errorMessage: `Write did not verify: ${problems.join('; ')}`,
      };
    }

    return { status: 'success', outcome: 'written', originalPrice, serialNumberMxi, errorMessage: null };
  } catch (err) {
    if (page) {
      await attemptCancelEdit(page);
    }
    return {
      status: 'failed',
      outcome: 'failed',
      originalPrice: null,
      serialNumberMxi: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
