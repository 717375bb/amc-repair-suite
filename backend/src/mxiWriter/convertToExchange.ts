import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { findOrderByNumber, readIssuedCount } from './selectors.js';
import { clickIssueOrderTolerant, isReauthorizationNeeded } from './priceLineSelectors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('mxi');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * The Convert-Repair-To-Exchange reason, by VISIBLE LABEL.
 *
 * `discovery-Exchange-recording.ts` recorded this as an opaque
 * `{AES}AUQAF...Vh/C/8RXzYXm4jUzoyWpV/` token. Resolved to its real label
 * by a live read-only query of the actual `<option>` elements on order
 * P000BET4 (2026-08-23) — the same technique this project used for the
 * Terms & Conditions / Transport Type / Auth Flow dropdowns.
 *
 * The four real options are:
 *   CONTRACT (Change of Contract Terms)
 *   OFFER (Vendor Exchange Offer)      <- the recorded one
 *   TIME (Repair Expedited)
 *   WARRANTY (New Aircraft Warranty)
 *
 * "OFFER" is correct here by meaning as well as by token: this path only
 * ever runs because a VENDOR offered an exchange in their quote.
 *
 * Selected by label rather than by the recorded token deliberately. The
 * token turned out to be identical on a different order, so it is probably
 * stable — but "probably stable opaque blob" is not something to bet a real
 * order type on, and the label is self-documenting to the next reader.
 */
export const EXCHANGE_REASON_LABEL = 'OFFER (Vendor Exchange Offer)';

export interface ConvertToExchangeResult {
  status: 'success' | 'failed' | 'skipped';
  /** Why it was skipped — e.g. the order is already an exchange. */
  skipReason: string | null;
  issueDetail: string | null;
  errorMessage: string | null;
}

/**
 * Converts a repair order to an exchange, per
 * `discovery-Exchange-recording.ts`, then authorizes and issues it.
 *
 * Runs INSTEAD OF the normal price-line write, not alongside it: the
 * conversion form carries its own exchange price, so pushing a Unit Price
 * as well would be writing the same money twice through two different
 * mechanisms.
 *
 * The recording ends at the post-Request-Authorization "OK". Per explicit
 * user direction the real flow continues from there with the MXI password,
 * then Issue Order — the same tail every other writer in this project
 * already performs.
 *
 * Independently re-verifies afterward rather than trusting the clicks,
 * same discipline as writePriceLineUpdate and writeEsdAndNotes.
 */
export async function convertRepairToExchange(
  client: MxiClient,
  orderNumber: string,
  exchangePrice: string,
  password: string,
  note?: string,
): Promise<ConvertToExchangeResult> {
  let page: Page | undefined;
  let issueDetail: string | null = null;

  try {
    page = await client.getAuthenticatedPage();

    // Deliberately NOT findOrderByNumber(): that helper opens Edit Lines,
    // and the Convert action lives on the order page itself. Same barcode
    // search the recording used.
    await page.goto(client.todoListUrl);
    await page.locator('#idBarcodeSearchInput').click();
    await page.locator('#idBarcodeSearchInput').fill(orderNumber);
    await page.locator('#idBarcodeSearchInput').press('Enter');
    await pace(page);

    const convertLink = page.getByRole('link', { name: 'Convert Repair To Exchange' });
    if ((await convertLink.count()) === 0) {
      // Confirmed real state, not an assumption: an order already converted
      // no longer offers the action (verified live on P000BF18, which the
      // recording itself had already converted).
      const bodyText = await page.locator('body').innerText();
      const type = bodyText.match(/Type:\s*([^\t\n]+)/)?.[1]?.trim() ?? '(unknown)';
      return {
        status: 'skipped',
        skipReason: `"Convert Repair To Exchange" is not offered on ${orderNumber} (order Type reads "${type}") — it is most likely already an exchange. Nothing was changed.`,
        issueDetail: null,
        errorMessage: null,
      };
    }

    const lineBox = page.locator('input[name="aPurchaseOrderLine"]');
    const lineCount = await lineBox.count();
    if (lineCount === 0) {
      return {
        status: 'failed',
        skipReason: null,
        issueDetail: null,
        errorMessage: `No purchase order line to select on ${orderNumber} — cannot convert.`,
      };
    }
    if (lineCount > 1) {
      // Same discipline as the price writer's multi-line guard: never guess
      // which line of a real order to act on.
      return {
        status: 'skipped',
        skipReason: `${orderNumber} has ${lineCount} purchase order lines — refusing to guess which one to convert.`,
        issueDetail: null,
        errorMessage: null,
      };
    }

    await lineBox.first().check();
    await pace(page);
    await convertLink.click();
    await pace(page);

    await page.locator('input[name="aExchangePrice_0"]').fill(exchangePrice);
    await pace(page);
    await page.locator('#idReasonDropdown').selectOption({ label: EXCHANGE_REASON_LABEL });
    await pace(page);

    if (note) {
      await page.locator('#idNote').fill(note);
      await pace(page);
    }

    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);

    // Conditional for the same reason confirmEsdLineEdit's YES is (see
    // selectors.ts): a confirmation that doesn't always appear must never
    // be waited on for the full default timeout and then thrown.
    const yesLink = page.getByRole('link', { name: 'YES' });
    try {
      await yesLink.first().waitFor({ state: 'visible', timeout: 8000 });
      await yesLink.first().click();
      await pace(page);
    } catch {
      // No confirmation shown — the conversion committed directly.
    }

    // Authorization. The recording stops after this OK; the password step
    // and Issue Order follow, per explicit user direction.
    const authNeeded = await isReauthorizationNeeded(page);
    if (authNeeded) {
      await page.getByRole('link', { name: 'Request Authorization' }).click();
      await pace(page);
      await page.getByRole('link', { name: 'OK' }).click();
      await pace(page);

      const passwordBox = page.getByRole('textbox', { name: 'Password:' });
      try {
        await passwordBox.first().waitFor({ state: 'visible', timeout: 10_000 });
        await passwordBox.first().fill(password);
        await passwordBox.first().press('Enter');
        await pace(page);
      } catch {
        // Some orders authorize without a password challenge.
      }
    }

    const issuedBefore = await readIssuedCount(page);
    const issueResult = await clickIssueOrderTolerant(page);
    const issuedAfter = await readIssuedCount(page);
    issueDetail =
      `${authNeeded ? 'Authorization requested' : 'Already authorized'}; ` +
      `${issueResult.clicked ? `clicked "${issueResult.label}"` : 'no Issue action present'}; ` +
      `issued count ${issuedBefore ?? '?'} -> ${issuedAfter ?? '?'}.`;

    // Independent re-verification: the order must genuinely read EXCHANGE
    // now. A click that threw no error is not evidence.
    await page.goto(client.todoListUrl);
    await page.locator('#idBarcodeSearchInput').click();
    await page.locator('#idBarcodeSearchInput').fill(orderNumber);
    await page.locator('#idBarcodeSearchInput').press('Enter');
    await pace(page);
    const verifyText = await page.locator('body').innerText();
    const verifiedType = verifyText.match(/Type:\s*([^\t\n]+)/)?.[1]?.trim() ?? '';

    if (!/EXCHANGE/i.test(verifiedType)) {
      return {
        status: 'failed',
        skipReason: null,
        issueDetail,
        errorMessage:
          `Conversion did not verify for ${orderNumber}: order Type re-reads as "${verifiedType || '(unreadable)'}", ` +
          `expected EXCHANGE. Treat this as NOT converted.`,
      };
    }

    log.info({ orderNumber, exchangePrice, issueDetail }, 'converted repair order to exchange');
    return { status: 'success', skipReason: null, issueDetail, errorMessage: null };
  } catch (err) {
    return {
      status: 'failed',
      skipReason: null,
      issueDetail,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
