import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { attachFile, clickIfPresent, enterPasswordIfPrompted, pace } from './scrapFlowHelpers.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('scrap');

/**
 * Cancel-task reason for a vendor scrap. Plain value in the recording (not
 * an {AES} token), so used verbatim.
 */
export const CANCEL_TASK_REASON_VALUE = 'SCRAPVEN';

/** Reason on Inspect as Unserviceable. Label confirmed from the user's own screenshot. */
export const INSPECT_UNSERVICEABLE_REASON_LABEL = 'SCRAP (Scrapped)';

/** Reason on Scrap Inventory. Label confirmed from the user's own screenshot. */
export const SCRAP_INVENTORY_REASON_LABEL = 'SCRPV (Vendor Scrapped)';

/** Attachment type for the scrap certificate. Plain value in the recording. */
export const SCRAP_ATTACHMENT_TYPE_VALUE = '1000600:SCRAP';

/** Note text written at both the cancel-task and scrap-inventory steps. */
export const SCRAP_NOTE_TEXT = 'NREP';

export interface VendorScrapResult {
  status: 'success' | 'failed';
  /** Which of the intermittent steps actually fired — recorded rather than assumed. */
  stepsTaken: string[];
  certAttached: boolean;
  errorMessage: string | null;
}

/**
 * The full vendor-scrap flow, from `discovery-full-scrap-recording.ts`.
 *
 * Receives the shipment, cancels the repair task as SCRAPVEN, completes and
 * signs the work package, inspects the returned item as unserviceable,
 * attaches the vendor's scrap certificate, and scraps the inventory.
 *
 * Three steps in that recording were flagged by the user as intermittent
 * ("lines 32, 38, and 54 will not ALWAYS appear") and several password
 * prompts are equally inconsistent. Every one of those goes through
 * clickIfPresent / enterPasswordIfPrompted with a short bounded wait, so an
 * absent dialog moves the flow on instead of timing out — the exact failure
 * mode that produced false failures in the ESD and price writers.
 *
 * This is a genuinely destructive, irreversible action: it physically
 * scraps a real part in the maintenance system. It is only ever reached
 * from an explicit, human-uploaded certificate for a specific order.
 */
export async function writeVendorScrap(
  client: MxiClient,
  orderNumber: string,
  serialNumber: string,
  certificatePath: string,
  password: string,
): Promise<VendorScrapResult> {
  const stepsTaken: string[] = [];
  let certAttached = false;
  let page: Page | undefined;

  try {
    page = await client.getAuthenticatedPage();

    await page.goto(client.todoListUrl);
    await page.locator('#idBarcodeSearchInput').click();
    await page.locator('#idBarcodeSearchInput').fill(orderNumber);
    await page.locator('#idBarcodeSearchInput').press('Enter');
    await pace(page);

    // --- Receive the shipment back from the vendor ---
    const receive = page.getByRole('link', { name: 'Receive Shipment' });
    if ((await receive.count()) === 0) {
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage: `"Receive Shipment" is not available on ${orderNumber} — it may already have been received. Check the order by hand before retrying.`,
      };
    }
    await receive.first().click();
    await pace(page);
    stepsTaken.push('received shipment');

    const qty = page.locator('input[name="aReceivedQty_1"]');
    if ((await qty.count()) > 0) {
      await qty.first().fill('1');
      await pace(page);
    }
    await clickIfPresent(page, page.getByRole('link', { name: 'OK' }));
    await clickIfPresent(page, page.getByRole('link', { name: 'Close' }));

    // --- Cancel the repair task as vendor-scrapped ---
    // The recording's link text is part-specific ("Repair CARTRIDGE, BOOST
    // PUMP"), so matched on the "Repair " prefix instead of that literal.
    const repairLink = page.getByRole('link', { name: /^Repair\s/i });
    if ((await repairLink.count()) === 0) {
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage: `Shipment received for ${orderNumber}, but no "Repair ..." task link was found to cancel. The order is PARTIALLY processed — check it by hand.`,
      };
    }
    await repairLink.first().click();
    await pace(page);

    const taskBox = page.locator('input[name="aTask"]');
    const taskCount = await taskBox.count();
    for (let i = 0; i < taskCount; i++) await taskBox.nth(i).check();
    await pace(page);

    await page.getByRole('link', { name: 'Cancel Tasks' }).click();
    await pace(page);
    await page.locator('#idSelect1').selectOption(CANCEL_TASK_REASON_VALUE);
    await page.locator('textarea[name="aNote"]').fill(SCRAP_NOTE_TEXT);
    await pace(page);
    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: cancel tasks');
    stepsTaken.push(`cancelled tasks as ${CANCEL_TASK_REASON_VALUE}`);

    // --- Complete and sign the work package ---
    await page.getByRole('link', { name: 'Complete Work Package As' }).click();
    await pace(page);
    await page.getByRole('link', { name: 'Sign', exact: true }).click();
    await pace(page);
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: sign work package');
    // Recording line 32 — user-confirmed as intermittent.
    if (await clickIfPresent(page, page.getByRole('link', { name: 'YES' }))) stepsTaken.push('confirmed YES after signing');
    await clickIfPresent(page, page.getByRole('link', { name: 'Close' }));
    await clickIfPresent(page, page.getByRole('link', { name: 'Close' }));
    stepsTaken.push('completed and signed work package');

    // --- Inspect the returned item as unserviceable ---
    await page.getByRole('link', { name: 'Receipt & Returns' }).click();
    await pace(page);

    const serialLink = page.getByRole('link', { name: serialNumber, exact: true });
    if ((await serialLink.count()) === 0) {
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage:
          `Work package completed for ${orderNumber}, but serial "${serialNumber}" was not found under Receipt & ` +
          `Returns. Refusing to guess which item to scrap. The order is PARTIALLY processed — check it by hand.`,
      };
    }
    await serialLink.first().click();
    await pace(page);

    await page.getByRole('link', { name: 'Inspect as Unserviceable' }).click();
    await pace(page);
    // Recording line 38 — user-confirmed as intermittent.
    if (await clickIfPresent(page, page.getByRole('link', { name: 'YES' }))) stepsTaken.push('confirmed YES on inspect');

    await page.locator('#idDropdownReason').selectOption({ label: INSPECT_UNSERVICEABLE_REASON_LABEL });
    const tagBox = page.locator('input[name="aGenerateServiceabilityTag"]');
    if ((await tagBox.count()) > 0) await tagBox.first().uncheck();
    await pace(page);
    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: inspect unserviceable');
    stepsTaken.push(`inspected unserviceable (${INSPECT_UNSERVICEABLE_REASON_LABEL})`);

    // --- Attach the vendor's scrap certificate ---
    await page.getByRole('link', { name: 'Add Attachment' }).click();
    await pace(page);
    await page.locator('#idSelect1').selectOption(SCRAP_ATTACHMENT_TYPE_VALUE);
    await pace(page);
    certAttached = await attachFile(page, certificatePath);
    if (!certAttached) {
      log.warn({ orderNumber }, 'scrap certificate file input not found — attachment type recorded without the file');
    }
    await page.getByRole('link', { name: 'OK', exact: true }).click();
    await pace(page);
    stepsTaken.push(certAttached ? 'attached scrap certificate' : 'attachment step ran WITHOUT the file');

    // --- Scrap the inventory ---
    await page.getByRole('link', { name: 'Scrap Inventory' }).click();
    await pace(page);
    await page.locator('#idDropdownReason').selectOption({ label: SCRAP_INVENTORY_REASON_LABEL });
    await page.locator('#idEditNotes').fill(SCRAP_NOTE_TEXT);
    await pace(page);
    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: scrap inventory');
    // Recording line 54 — user-confirmed as intermittent.
    if (await clickIfPresent(page, page.getByRole('button', { name: 'OK' }))) stepsTaken.push('confirmed OK after scrap');
    await clickIfPresent(page, page.getByRole('link', { name: 'Close' }));
    stepsTaken.push(`scrapped inventory (${SCRAP_INVENTORY_REASON_LABEL})`);

    // --- Independent verification ---
    // The recording's last line clicks a cell reading "SCRAP"; that is the
    // real end-state marker, so it is checked here rather than trusting the
    // click sequence.
    const scrapCell = page.getByRole('cell', { name: 'SCRAP', exact: true });
    const verified = (await scrapCell.count()) > 0;
    if (!verified) {
      const bodyText = await page.locator('body').innerText();
      if (!/\bSCRAP\b/.test(bodyText)) {
        return {
          status: 'failed',
          stepsTaken,
          certAttached,
          errorMessage:
            `Scrap sequence completed for ${orderNumber}/${serialNumber}, but the page does not show a SCRAP state ` +
            `afterward. Treat this as NOT confirmed and check the item by hand.`,
        };
      }
    }

    log.info({ orderNumber, serialNumber, certAttached, stepsTaken }, 'vendor scrap completed');
    return { status: 'success', stepsTaken, certAttached, errorMessage: null };
  } catch (err) {
    return {
      status: 'failed',
      stepsTaken,
      certAttached,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
