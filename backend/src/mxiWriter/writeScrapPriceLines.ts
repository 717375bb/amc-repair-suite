import { addDays, formatISO } from 'date-fns';
import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { toMxiDateFormat } from './esdFormatting.js';
import { readIssuedCount } from './selectors.js';
import { clickIssueOrderTolerant, isReauthorizationNeeded } from './priceLineSelectors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('mxi');

const CLICK_DELAY_MS = 750;

/**
 * Promised-by offset for both lines of a scrap-priced order.
 *
 * Per explicit user direction (2026-08-23): "The promised by date on BOTH
 * lines should be set to 2 days from current date." Confirmed against the
 * recording's own finished order P000BDTA — its new scrap line reads
 * 25-AUG-2026 against a 23-AUG-2026 recording date. The ORIGINAL line there
 * still reads a stale 09-SEP-2026, which is precisely the gap the user
 * flagged ("I only did the new line, but make sure it's both"); this code
 * sets both explicitly rather than relying on any MXI default.
 */
export const SCRAP_PROMISED_BY_OFFSET_DAYS = 2;

/** Price type for BOTH lines. Confirmed a plain value on Edit Lines and a clean label on the add form. */
export const SCRAP_PRICE_TYPE = 'SCRAP';

/** Description typed into the new miscellaneous line, per the recording. */
export const SCRAP_LINE_DESCRIPTION = 'scrap';

/**
 * Scrap fee used for a BER row.
 *
 * BER is a PSA-side commercial judgement made on an ORDINARY repair quote,
 * so that quote's extracted amount is its repair cost — writing it as a
 * scrap charge would put a large wrong number on a real order (on real
 * data, $29,529.96 on one row). NREP is different: those quotes literally
 * state a scrap fee, so their extracted price is already correct.
 *
 * Set to 196.00 by explicit user direction (2026-08-23), described as a
 * default to adjust later — so it lives here as one named constant rather
 * than being scattered, and changing it is a one-line edit.
 */
export const BER_DEFAULT_SCRAP_FEE = '196.00';

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

export interface ScrapPriceResult {
  status: 'success' | 'failed' | 'skipped';
  skipReason: string | null;
  /** The charge-to-account copied from the original line. */
  accountUsed: string | null;
  promisedBy: string | null;
  issueDetail: string | null;
  errorMessage: string | null;
}

function scrapPromisedByDate(today: Date = new Date()): string {
  return toMxiDateFormat(formatISO(addDays(today, SCRAP_PROMISED_BY_OFFSET_DAYS), { representation: 'date' }));
}

async function searchOrder(page: Page, todoListUrl: string, orderNumber: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.locator('#idBarcodeSearchInput').click();
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await pace(page);
}

/**
 * Adds the scrap price line to a quoted-for-scrap order, per
 * `discovery-scrap-price-recording.ts`.
 *
 * The end state, verified against that recording's own finished order
 * (P000BDTA, read live 2026-08-23):
 *   line 1 (original) — price 0.00, type SCRAP, account CR9REPAIR
 *   line 2 (new)      — price = the scrap fee, type SCRAP, same account
 *   both lines' Promised By = today + 2 days
 *
 * The original line is zeroed because, per explicit user direction, "the
 * scrap gets all the cost" — the whole charge moves onto the new line.
 *
 * The account is READ from the original line rather than hardcoded: the
 * recording typed CR7REPAIR and then corrected it to CR9REPAIR to match,
 * and the user confirmed it "will always match the original line's
 * account". Reading it first means there is never a moment where a wrong
 * account is committed.
 */
export async function writeScrapPriceLines(
  client: MxiClient,
  orderNumber: string,
  scrapFee: string,
  password: string,
  today: Date = new Date(),
): Promise<ScrapPriceResult> {
  let page: Page | undefined;
  let issueDetail: string | null = null;
  let accountUsed: string | null = null;
  const promisedBy = scrapPromisedByDate(today);

  try {
    page = await client.getAuthenticatedPage();

    // --- 1. Read the original line's account BEFORE adding anything, so
    //        the new line is never created with a wrong value. ---
    await searchOrder(page, client.todoListUrl, orderNumber);

    const editLines = page.getByRole('link', { name: 'Edit Lines' });
    if ((await editLines.count()) === 0) {
      return {
        status: 'skipped',
        skipReason: `"Edit Lines" is not available on ${orderNumber} — cannot read the original line's account.`,
        accountUsed: null,
        promisedBy: null,
        issueDetail: null,
        errorMessage: null,
      };
    }
    await editLines.first().click();
    await pace(page);

    const existingLineCount = await page.locator('input[id^="idUnitPrice_"]').count();
    if (existingLineCount === 0) {
      return {
        status: 'skipped',
        skipReason: `${orderNumber} has no existing order line to zero out.`,
        accountUsed: null,
        promisedBy: null,
        issueDetail: null,
        errorMessage: null,
      };
    }
    if (existingLineCount > 1) {
      // Same discipline as every other writer here: never guess which line
      // of a real order to act on.
      return {
        status: 'skipped',
        skipReason: `${orderNumber} already has ${existingLineCount} lines — refusing to guess which one to zero. Scrap pricing assumes a single original line.`,
        accountUsed: null,
        promisedBy: null,
        issueDetail: null,
        errorMessage: null,
      };
    }

    accountUsed = (await page.locator('#idAccount_1').inputValue()).trim();
    if (!accountUsed) {
      return {
        status: 'failed',
        skipReason: null,
        accountUsed: null,
        promisedBy: null,
        issueDetail: null,
        errorMessage: `Original line on ${orderNumber} has a blank charge-to-account — refusing to create a scrap line with no account.`,
      };
    }
    log.info({ orderNumber, accountUsed }, 'read original line account for scrap pricing');

    // --- 2. Add the miscellaneous scrap line. ---
    await searchOrder(page, client.todoListUrl, orderNumber);
    const addMisc = page.getByRole('link', { name: 'Add Miscellaneous Line' });
    if ((await addMisc.count()) === 0) {
      return {
        status: 'skipped',
        skipReason: `"Add Miscellaneous Line" is not available on ${orderNumber}.`,
        accountUsed,
        promisedBy: null,
        issueDetail: null,
        errorMessage: null,
      };
    }
    await addMisc.first().click();
    await pace(page);

    await page.locator('#idFieldDescription').fill(SCRAP_LINE_DESCRIPTION);
    await page.locator('input[name="aUnitPrice"]').fill(scrapFee);
    // By LABEL: this dropdown's option values are opaque {AES} tokens, but
    // its labels are clean ("SCRAP"). Confirmed by live read of the real
    // <option> elements rather than trusting the recorded token.
    await page.locator('#idSelect2').selectOption({ label: SCRAP_PRICE_TYPE });
    await page.locator('#idSelectAccount').fill(accountUsed);
    await pace(page);

    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);

    // The recording's confirmation is a table CELL here, not a link —
    // deliberately matched as recorded. Conditional for the same reason
    // confirmEsdLineEdit's YES is: a confirmation that doesn't always
    // appear must never be waited on for the full default timeout.
    const yesCell = page.getByRole('cell', { name: 'YES', exact: true });
    try {
      await yesCell.first().waitFor({ state: 'visible', timeout: 8000 });
      await yesCell.first().click();
      await pace(page);
    } catch {
      const yesLink = page.getByRole('link', { name: 'YES' });
      if ((await yesLink.count()) > 0) {
        await yesLink.first().click();
        await pace(page);
      }
    }

    // --- 3. Fix up BOTH lines on Edit Lines. ---
    // We should already be here after the add; re-enter explicitly if not,
    // rather than assuming a page state.
    if ((await page.locator('#idUnitPrice_1').count()) === 0) {
      await searchOrder(page, client.todoListUrl, orderNumber);
      const relink = page.getByRole('link', { name: 'Edit Lines' });
      if ((await relink.count()) === 0) {
        return {
          status: 'failed',
          skipReason: null,
          accountUsed,
          promisedBy,
          issueDetail: null,
          errorMessage: `Scrap line was added to ${orderNumber} but "Edit Lines" could not be re-opened to zero the original line. The order is now in a PARTIAL state — check it by hand.`,
        };
      }
      await relink.first().click();
      await pace(page);
    }

    const lineCount = await page.locator('input[id^="idUnitPrice_"]').count();
    if (lineCount < 2) {
      return {
        status: 'failed',
        skipReason: null,
        accountUsed,
        promisedBy,
        issueDetail: null,
        errorMessage: `Expected 2 lines on ${orderNumber} after adding the scrap line, found ${lineCount}. Not zeroing anything — check by hand.`,
      };
    }

    // Original line: all cost moves to the scrap line.
    await page.locator('#idPriceType_1').selectOption(SCRAP_PRICE_TYPE);
    await page.locator('#idUnitPrice_1').fill('0');
    // Account on the new line must match the original's (already set at
    // creation; re-asserted here because the recording did, and because a
    // silent MXI default would otherwise go unnoticed).
    await page.locator('#idAccount_2').fill(accountUsed);
    // BOTH promised-by dates — the recording only ever set the new line's,
    // leaving the original stale. Confirmed on P000BDTA.
    for (const idx of [1, 2]) {
      const dateField = page.locator(`input[name="aPromiseBy_${idx}_$DATE$"]`);
      if ((await dateField.count()) > 0) await dateField.first().fill(promisedBy);
    }
    await pace(page);

    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);

    // --- 4. Authorize (only if MXI actually asks) and issue. ---
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
        // No password challenge on this order.
      }
    }
    // Per explicit user direction: "If authorization isn't required, even
    // though it usually should be, just go straight to issuing."
    const issuedBefore = await readIssuedCount(page);
    const issueResult = await clickIssueOrderTolerant(page);
    const issuedAfter = await readIssuedCount(page);
    issueDetail =
      `${authNeeded ? 'Authorization requested' : 'Already authorized'}; ` +
      `${issueResult.clicked ? `clicked "${issueResult.label}"` : 'no Issue action present'}; ` +
      `issued count ${issuedBefore ?? '?'} -> ${issuedAfter ?? '?'}.`;

    // --- 5. Independent re-verification. ---
    await searchOrder(page, client.todoListUrl, orderNumber);
    const verifyLink = page.getByRole('link', { name: 'Edit Lines' });
    if ((await verifyLink.count()) === 0) {
      return {
        status: 'failed',
        skipReason: null,
        accountUsed,
        promisedBy,
        issueDetail,
        errorMessage: `Could not re-open Edit Lines on ${orderNumber} to verify the scrap pricing.`,
      };
    }
    await verifyLink.first().click();
    await pace(page);

    const problems: string[] = [];
    const price1 = await page.locator('#idUnitPrice_1').inputValue();
    const price2 = await page.locator('#idUnitPrice_2').inputValue();
    const type1 = await page.locator('#idPriceType_1').inputValue();
    const type2 = await page.locator('#idPriceType_2').inputValue();

    if (Number(price1) !== 0) problems.push(`original line price re-read as "${price1}", expected 0`);
    if (Number(price2) !== Number(scrapFee)) problems.push(`scrap line price re-read as "${price2}", expected "${scrapFee}"`);
    if (type1 !== SCRAP_PRICE_TYPE) problems.push(`original line type re-read as "${type1}", expected ${SCRAP_PRICE_TYPE}`);
    if (type2 !== SCRAP_PRICE_TYPE) problems.push(`scrap line type re-read as "${type2}", expected ${SCRAP_PRICE_TYPE}`);

    if (problems.length > 0) {
      return {
        status: 'failed',
        skipReason: null,
        accountUsed,
        promisedBy,
        issueDetail,
        errorMessage: `Scrap pricing did not verify on ${orderNumber}: ${problems.join('; ')}`,
      };
    }

    log.info({ orderNumber, scrapFee, accountUsed, promisedBy, issueDetail }, 'scrap pricing written and verified');
    return { status: 'success', skipReason: null, accountUsed, promisedBy, issueDetail, errorMessage: null };
  } catch (err) {
    return {
      status: 'failed',
      skipReason: null,
      accountUsed,
      promisedBy,
      issueDetail,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
