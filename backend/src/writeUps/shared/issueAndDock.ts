import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { waitForBodyTextIncludes } from './taskRecovery.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/issueOrder.ts per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.4. This supersedes that file's
 * original "vendor-module-isolation" design (which deliberately
 * reimplemented the ESD writer's reissueOrder() locally rather than share
 * cross-module) — 0T1Y4's own recording confirms byte-for-byte identical
 * Issue Order / Move to Dock sequencing to Aero Repair's, so the isolation
 * rationale no longer holds once a second vendor genuinely needs the same
 * mechanism. Pure relocation, no behavior change — re-exported from
 * aeroRepair/issueOrder.ts so every existing call site keeps working
 * unchanged.
 */

/**
 * Real, from the original Aero Repair recording: click "Issue Order", then
 * its own confirmation "OK" (exact match, since multiple OK-labeled
 * elements coexist on that screen). This is the same top-level RO Details
 * action already discovered and heavily tested in the ESD/MXI-writer
 * module (mxiWriter/selectors.ts's reissueOrder()) — that module's own
 * testing found this exact click can be unreliable (the confirmation can
 * time out while the action still silently commits server-side), which is
 * why this function's caller is expected to independently re-verify the
 * order's real state afterward rather than trust a reported success alone.
 */
export async function clickIssueOrder(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Issue Order' }).click();
  await pace(page);
}

export async function confirmIssueOrder(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
}

/** Navigates directly to an order by number via the global barcode/order search box. */
export async function navigateToOrderByNumber(page: Page, orderNumber: string, todoListUrl: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.locator('#idBarcodeSearchInput').click();
  await pace(page);
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await pace(page);
}

export interface OrderRealState {
  orderStatus: string | null;
  issuedCount: number | null;
  authorizationStatus: string | null;
}

/**
 * Navigates to the order fresh and reads its real Order Status / Issued
 * count / Authorization Status directly off the page — used both by
 * Issue-Order verification and by Auth-Flow-request verification (a
 * genuinely independent re-read, not trusting a reported click success).
 */
export async function readOrderRealState(
  page: Page,
  orderNumber: string,
  todoListUrl: string,
): Promise<OrderRealState> {
  await navigateToOrderByNumber(page, orderNumber, todoListUrl);
  await waitForBodyTextIncludes(page, 'Order Status:', `Order real state for ${orderNumber}`);
  const bodyText = await page.locator('body').innerText();
  const statusMatch = bodyText.match(/Order Status:\s*([A-Z]+)/);
  const issuedMatch = bodyText.match(/Issued:\s*(\d+)\s*time/i);
  const authMatch = bodyText.match(/Authorization Status:\s*([A-Z]+)/);
  return {
    orderStatus: statusMatch?.[1] ?? null,
    issuedCount: issuedMatch ? Number(issuedMatch[1]) : null,
    authorizationStatus: authMatch?.[1] ?? null,
  };
}

export interface IssueOrderResult {
  status: 'success' | 'failed';
  errorMessage: string | null;
}

/**
 * Explicitly-invoked, standalone Issue Order step for a real order number.
 * Does not self-verify the outcome — given the ESD module's own documented
 * history of this exact mechanism silently committing despite a reported
 * failure (or, plausibly, the reverse), the caller is expected to
 * independently re-read the order's real state afterward.
 */
export async function issueGeneratedOrder(client: MxiClient, orderNumber: string): Promise<IssueOrderResult> {
  try {
    const page = await client.getAuthenticatedPage();
    await navigateToOrderByNumber(page, orderNumber, client.todoListUrl);
    await clickIssueOrder(page);
    await confirmIssueOrder(page);
    return { status: 'success', errorMessage: null };
  } catch (err) {
    return { status: 'failed', errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export interface MoveToDockResult {
  status: 'success' | 'failed' | 'no_outbound_shipment_found' | 'already_docked_externally';
  shipmentId: string | null;
  errorMessage: string | null;
}

export interface OutboundShipmentDockState {
  status: 'not_yet_docked' | 'already_docked_or_further' | 'no_outbound_shipment_found';
  shipmentId: string | null;
}

/**
 * Read-only. Finds the order's real OUTBOUND shipment (Ship From
 * "<STATION>/DOCK", Ship To a vendor code) and reports whether its line is
 * still at "<STATION>/USSTG" (not yet docked) or anything else (already
 * docked, or further along). Identifies the outbound shipment by the
 * stable, state-independent "Ship From" value rather than the presence of
 * a clickable "Move to Dock" link (which disappears once the shipment
 * progresses past PEND — confirmed live via a real case where a human
 * docked and received a shipment entirely outside this automation between
 * sessions).
 */
export async function readOutboundShipmentDockState(
  page: Page,
  todoListUrl: string,
  orderNumber: string,
): Promise<OutboundShipmentDockState> {
  await navigateToOrderByNumber(page, orderNumber, todoListUrl);
  await page.getByRole('link', { name: 'Receipt & Returns' }).click();
  await pace(page);
  try {
    await page.waitForFunction(() => document.querySelectorAll('a').length > 0 &&
      Array.from(document.querySelectorAll('a')).some((a) => /^SRRR\d+/.test((a.textContent ?? '').trim())),
      undefined, { timeout: 30_000, polling: 250 });
  } catch {
    // Swallowed deliberately — a genuine zero-shipment case falls through
    // to the already-correct 'no_outbound_shipment_found' handling below.
  }
  const shipmentIds = await page.getByRole('link', { name: /^SRRR\d+/ }).allInnerTexts();

  let outboundShipmentId: string | null = null;
  for (const shipmentId of shipmentIds) {
    await navigateToOrderByNumber(page, orderNumber, todoListUrl);
    await page.getByRole('link', { name: 'Receipt & Returns' }).click();
    await pace(page);
    await page.getByRole('link', { name: shipmentId, exact: true }).click();
    await waitForBodyTextIncludes(page, 'Ship From:', `Shipment detail ${shipmentId} for order ${orderNumber}`);

    const bodyText = await page.locator('body').innerText();
    const shipFromMatch = bodyText.match(/Ship From:\s*([^\t\n]+)/);
    if (shipFromMatch && shipFromMatch[1].trim().endsWith('/DOCK')) {
      outboundShipmentId = shipmentId;
      break;
    }
  }

  if (!outboundShipmentId) {
    return { status: 'no_outbound_shipment_found', shipmentId: null };
  }

  await waitForBodyTextIncludes(page, 'Shipment Lines', `Shipment lines for ${outboundShipmentId}`);
  const fullBodyText = await page.locator('body').innerText();
  const linesSectionIdx = fullBodyText.indexOf('Shipment Lines');
  const linesSectionText = linesSectionIdx >= 0 ? fullBodyText.slice(linesSectionIdx) : fullBodyText;
  const currentLocationMatch = linesSectionText.match(/\b([A-Z]{3})\/([A-Z0-9]+)\b/);
  const notYetDocked = !!currentLocationMatch && currentLocationMatch[2] === 'USSTG';

  return {
    status: notYetDocked ? 'not_yet_docked' : 'already_docked_or_further',
    shipmentId: outboundShipmentId,
  };
}

/**
 * "Move to Dock" on the order's OUTBOUND shipment (the one carrying the
 * part TO the vendor). Reads the real current state via
 * readOutboundShipmentDockState() FIRST — if the shipment is already at
 * dock or further along, reports 'already_docked_externally' and does not
 * click anything. Does not self-verify beyond confirming the click
 * sequence completed — same discipline as issueGeneratedOrder(): the
 * caller should independently re-read the shipment's real state afterward.
 *
 * `page` is fetched exactly once by the caller and passed in — never call
 * client.getAuthenticatedPage() a second time mid-flow (its isSessionAlive()
 * probe can navigate away from wherever the page currently is, silently
 * discarding page continuity a caller depends on).
 */
export async function moveOutboundShipmentToDock(client: MxiClient, orderNumber: string): Promise<MoveToDockResult> {
  try {
    const page = await client.getAuthenticatedPage();
    const dockState = await readOutboundShipmentDockState(page, client.todoListUrl, orderNumber);

    if (dockState.status === 'no_outbound_shipment_found') {
      return { status: 'no_outbound_shipment_found', shipmentId: null, errorMessage: null };
    }

    if (dockState.status === 'already_docked_or_further') {
      return { status: 'already_docked_externally', shipmentId: dockState.shipmentId, errorMessage: null };
    }

    // REAL BUG FOUND AND FIXED (user-reported, 2026-08-23): "a significant
    // number of orders are being written up and issued, but the move to
    // dock is not actually occurring, even though the UI says it is."
    //
    // The cause was that this function returned status:'success' purely
    // because nothing threw — it never re-read the dock state afterward.
    // Every other MXI write in this project independently re-verifies its
    // real outcome (writeEsdAndNotes, writePriceLineUpdate, the
    // authorization step in vendorCodeWriteUp); this one was the gap, and
    // "no exception" is exactly the signal that has already proven
    // untrustworthy against MXI elsewhere.
    const lineCheckboxes = page.locator('input[name="aShipmentLine"]');
    const lineCount = await lineCheckboxes.count();
    if (lineCount === 0) {
      return {
        status: 'failed',
        shipmentId: dockState.shipmentId,
        errorMessage:
          `Outbound shipment ${dockState.shipmentId ?? '(unknown)'} for ${orderNumber} showed no selectable ` +
          `shipment line to move — nothing was clicked.`,
      };
    }
    // .check() is strict-mode and throws on a multi-match; check each line
    // explicitly rather than letting that surface as an opaque failure.
    for (let i = 0; i < lineCount; i++) {
      await lineCheckboxes.nth(i).check();
    }
    await pace(page);
    await page.getByRole('link', { name: 'Move to Dock' }).click();
    await pace(page);
    await page.getByRole('link', { name: 'Close' }).click();
    await pace(page);

    // THE ACTUAL CHECK: re-read the real dock state from a fresh
    // navigation. Only a page that now genuinely reports docked counts as
    // success.
    const verified = await readOutboundShipmentDockState(page, client.todoListUrl, orderNumber);
    if (verified.status === 'already_docked_or_further') {
      return { status: 'success', shipmentId: verified.shipmentId ?? dockState.shipmentId, errorMessage: null };
    }

    return {
      status: 'failed',
      shipmentId: dockState.shipmentId,
      errorMessage:
        `Move to Dock did not verify for ${orderNumber}: the click sequence completed without error, but an ` +
        `independent re-read still reports "${verified.status}"` +
        `${verified.shipmentId ? ` for shipment ${verified.shipmentId}` : ''}. ` +
        `The part has NOT moved — treat this as not docked.`,
    };
  } catch (err) {
    return { status: 'failed', shipmentId: null, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
