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
 * The one link in the Inventory Receipts table that points at an inventory
 * record — i.e. the item this order actually received back.
 *
 * Located structurally rather than by its text, because that text varies:
 * on real order P000BESE it read "BN 397522" while the scrap certificate
 * said "PEL01531" and the receipt line's own description said "BN 396273".
 * Confirmed against the live page on 2026-08-28.
 */
const RECEIVED_ITEM_LINK = '#idTableInventoryReceipts a[href*="InventoryDetails.jsp"]';

/**
 * Whether this order has an inventory item on its Receipt & Returns tab.
 *
 * This is the real signal that a shipment was received — truer than whether
 * the "Receive Shipment" link is gone, and truer than whether a dialog's OK
 * button clicked cleanly. Leaves the browser back on the order's own page
 * so the caller can carry on with the next step.
 */
async function confirmShipmentReceived(page: Page, orderNumber: string, todoListUrl: string): Promise<boolean> {
  const tab = page.getByRole('link', { name: 'Receipt & Returns' });
  if ((await tab.count()) === 0) return false;
  await tab.first().click();
  await pace(page);
  const found = (await page.locator(RECEIVED_ITEM_LINK).count()) > 0;

  // Back to the order's default view — the steps after this expect the
  // task list, not the Receipt & Returns tab. MXI also remembers the active
  // tab per session, so leaving it here would affect the next order too.
  await page.goto(todoListUrl);
  await page.locator('#idBarcodeSearchInput').click();
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await pace(page);

  return found;
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
  // The receive dialog's own buttons. Short on purpose: an unresponsive
  // button here is a fault to report in seconds, not to wait 30s on.
  const RECEIVE_CLICK_TIMEOUT_MS = 8000;

  try {
    page = await client.getAuthenticatedPage();

    await page.goto(client.todoListUrl);
    await page.locator('#idBarcodeSearchInput').click();
    await page.locator('#idBarcodeSearchInput').fill(orderNumber);
    await page.locator('#idBarcodeSearchInput').press('Enter');
    await pace(page);

    // --- Receive the shipment back from the vendor ---
    //
    // RESUMABLE AS OF 2026-08-28. Two real failures on 2026-08-28 left
    // orders stuck here: P000BESC's "OK" click timed out after 30s (the
    // button was found but never became actionable), the run reported
    // failure, and a retry then refused outright because the shipment HAD
    // been received in the meantime. The order sat received-but-nothing-else
    // with no way forward but by hand.
    //
    // So: the receive is judged by whether the item actually arrived, not by
    // whether every click resolved — the same discipline that fixed the ESD
    // note verification. An already-received order resumes instead of
    // refusing, which is what makes a partially-processed order recoverable
    // by simply running it again.
    const receive = page.getByRole('link', { name: 'Receive Shipment' });
    if ((await receive.count()) > 0) {
      await receive.first().click();
      await pace(page);

      const qty = page.locator('input[name="aReceivedQty_1"]');
      if ((await qty.count()) > 0) {
        await qty.first().fill('1');
        await pace(page);
      }
      // Bounded, and a timeout here is no longer fatal on its own: the
      // verification below decides whether the receive really happened.
      // #idButtonOK is the id the failing run's own error log showed this
      // link resolving to.
      await clickIfPresent(page, page.locator('#idButtonOK'), RECEIVE_CLICK_TIMEOUT_MS);
      await clickIfPresent(page, page.getByRole('link', { name: 'Close' }), RECEIVE_CLICK_TIMEOUT_MS);
    }

    // Independently confirm the item is on the order, whether we just
    // received it or a previous run did.
    const received = await confirmShipmentReceived(page, orderNumber, client.todoListUrl);
    if (!received) {
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage:
          `${orderNumber} has no received inventory item after the receive step, and "Receive Shipment" is ` +
          `${(await receive.count()) > 0 ? 'still offered' : 'not offered'} — the shipment was not received. ` +
          `Nothing further was attempted.`,
      };
    }
    stepsTaken.push('shipment received (confirmed on Receipt & Returns)');

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

    // --- Open the item that was actually received ---
    //
    // REAL BUG FIXED (2026-08-28). This used to look for a link whose text
    // equalled the serial from the scrap certificate, and refused to
    // continue when it found none — leaving the order received, cancelled,
    // and work-package-complete but not scrapped, which is the worst place
    // to stop. It failed on real order P000BESE, and the page shows exactly
    // why: the certificate's serial was PEL01531, while the item MXI
    // actually received is batch BN 397522. They are different identifiers
    // for the same physical return, and with batch-numbered parts they
    // routinely disagree — the vendor returns a different batch than the
    // one that was sent, and the receipt line's own description even
    // carried a third value (BN 396273).
    //
    // Per the analyst's instruction: take the inventory shown on the
    // inventory receipt line, exactly as the original recording did (it
    // clicked "D19181", which was that order's received item, not its
    // certificate serial). Located structurally — the one link in the
    // Inventory Receipts table that points at an inventory record —
    // rather than by text, so nothing depends on how the item is named.
    const receiptItems = page.locator(RECEIVED_ITEM_LINK);
    const receiptItemCount = await receiptItems.count();

    if (receiptItemCount === 0) {
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage:
          `Work package completed for ${orderNumber}, but its Receipt & Returns tab shows no received inventory ` +
          `item to scrap. The order is PARTIALLY processed — check it by hand.`,
      };
    }

    // More than one received line is a genuine ambiguity about which
    // physical item to destroy, and scrapping is irreversible. Refusing is
    // correct; guessing is not.
    if (receiptItemCount > 1) {
      const names = await receiptItems.allInnerTexts();
      return {
        status: 'failed',
        stepsTaken,
        certAttached,
        errorMessage:
          `Work package completed for ${orderNumber}, but its Receipt & Returns tab lists ${receiptItemCount} ` +
          `received inventory items (${names.map((n) => n.trim()).join(', ')}). Refusing to guess which one to ` +
          `scrap. The order is PARTIALLY processed — scrap the right item by hand.`,
      };
    }

    const receivedItemName = (await receiptItems.first().innerText()).trim();
    await receiptItems.first().click();
    await pace(page);

    // Recorded because the item scrapped is no longer assumed to be the
    // certificate's serial. When they differ, the audit trail must show
    // both, so a reviewer can see what was actually destroyed.
    stepsTaken.push(
      receivedItemName === serialNumber
        ? `opened received inventory ${receivedItemName}`
        : `opened received inventory ${receivedItemName} (certificate serial was ${serialNumber})`,
    );
    if (receivedItemName !== serialNumber) {
      log.info(
        { orderNumber, certificateSerial: serialNumber, receivedItem: receivedItemName },
        'vendor scrap: received item differs from the certificate serial — using the receipt line, per batch-number handling',
      );
    }

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
