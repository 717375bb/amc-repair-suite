import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { waitForBodyTextIncludes } from './gridWait.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Real, from the ORIGINAL discovery-writeOrder-recording.ts (lines 47-48):
 *
 *   await page.getByRole('link', { name: 'Issue Order' }).click();
 *   await page.getByRole('link', { name: 'OK', exact: true }).click();
 *
 * Just those two steps — click "Issue Order", then its own confirmation
 * "OK" (exact match, since multiple OK-labeled elements coexist on that
 * screen, same reason mxiWriter/selectors.ts's reissueOrder() uses exact
 * there too). Nothing else appeared between them in the real recording —
 * no extra dialog, no intermediate confirmation. This is the SAME
 * top-level RO Details action already discovered and heavily tested in
 * the ESD/MXI-writer module (see mxiWriter/selectors.ts's reissueOrder());
 * implemented separately here per the vendor-module-isolation design, not
 * because the underlying mechanism differs.
 *
 * The ESD module's own testing found this exact click can be unreliable —
 * the "YES"/OK confirmation can time out while the action still silently
 * commits server-side (see PHASE2_MXI_WRITER_SPEC.md's reissueOrder()
 * anomaly addenda). That history is why this function's caller is expected
 * to independently re-verify the order's real state afterward rather than
 * trust a reported success alone — this function itself does not
 * self-verify (deliberately kept simple/isolated per this task's scope).
 */
export async function clickIssueOrder(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Issue Order' }).click();
  await pace(page);
}

export async function confirmIssueOrder(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
}

/**
 * Navigates directly to an order by number via the global barcode/order
 * search box — same mechanism mxiWriter/selectors.ts's findOrderByNumber /
 * navigateToOrder already use, reimplemented locally here rather than
 * imported cross-module, per this project's vendor-module-isolation design
 * (aeroRepair doesn't share logic with other vendor/workflow modules).
 */
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
 * count / Authorization Status directly off the page — the same read
 * approve-issue's CLI already did inline; extracted here so reject-issue
 * (and, later, the write-up flow's own authorization-request step) can
 * use the identical check before deciding what to record, rather than
 * trusting a stale write_up_actions row that may no longer reflect
 * reality (e.g. if the order was already issued by an earlier
 * approve-issue run).
 */
export async function readOrderRealState(
  page: Page,
  orderNumber: string,
  todoListUrl: string,
): Promise<OrderRealState> {
  await navigateToOrderByNumber(page, orderNumber, todoListUrl);
  // SYSTEMATIC AUDIT FIX: this used to read page.locator('body').innerText()
  // immediately after navigation+750ms pace, with no wait of its own — the
  // same whole-body-read vulnerability class fixed elsewhere. "Order
  // Status:" is the same label this function's own regex already depends
  // on being present.
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
 * Explicitly-invoked, standalone Issue Order step for a real order number —
 * deliberately NOT called anywhere from runAeroRepairWriteUp() or any other
 * part of the write-up flow. This is its own callable action, invoked only
 * on request, per this task's explicit requirement: Issue Order has never
 * been exercised anywhere in this project and needs to be proven in
 * isolation before it's anywhere near an automatic flow.
 *
 * Does not self-verify the outcome — given the ESD module's own documented
 * history of this exact mechanism silently committing despite a reported
 * failure (or, plausibly, the reverse), the caller is expected to
 * independently re-read the order's real state afterward, not trust this
 * function's return value alone.
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
 * Read-only. Finds the order's real OUTBOUND shipment (the one carrying
 * the part TO the vendor — Ship From "<STATION>/DOCK", Ship To a vendor
 * code) and reports whether its line is still at "<STATION>/USSTG"
 * (not yet docked) or anything else (already docked, or further along —
 * e.g. already shipped and received by the vendor).
 *
 * REAL BUG FOUND AND FIXED, from a real production case: this used to
 * identify "the outbound shipment" purely by the presence of a clickable
 * "Move to Dock" link — but that link disappears once the shipment
 * progresses past PEND (confirmed live: `P000BAL4`'s outbound shipment had
 * been moved to dock AND received by the vendor by someone else, entirely
 * outside this automation, between sessions — real proof that humans can
 * and do perform this step without ever calling this code, so
 * write_up_dock_moves can never be trusted as sole source of truth for
 * the real world, only for what this automation itself did). Against
 * that real state, the old link-presence check found the link on NEITHER
 * shipment and reported 'no_outbound_shipment_found' — wrong; the
 * shipment genuinely exists, it's just already past the point a "Move to
 * Dock" action is offered for.
 *
 * Fixed to identify by the stable, state-independent "Ship From" value
 * instead (confirmed real and consistent across every order checked —
 * NH, Georgia, Indy, DFW — always literally "<STATION>/DOCK" for the
 * outbound leg, regardless of how far the shipment has actually
 * progressed), then reads that shipment's own line's real Current
 * Location — scoped specifically to the "Shipment Lines" section of the
 * page, not the whole body, since the page's own "Identification"
 * section header (Ship From/Ship To) contains a same-shaped
 * "STATION/CODE" token that a whole-page regex would risk matching
 * instead of the actual per-line value.
 *
 * REAL BUG FOUND AND FIXED (found live, batch-execute proof run — all 4
 * lines failed identically at the "not yet docked" click step): this
 * originally took `client: MxiClient` and called `client.getAuthenticatedPage()`
 * itself. `MxiClient.getAuthenticatedPage()` has a real, non-obvious side
 * effect — its `isSessionAlive()` liveness probe does `page.goto(todoListUrl,
 * ...)` on EVERY call whenever the current URL doesn't literally contain
 * "login.jsp", i.e. it navigates away from wherever the page currently is.
 * `moveOutboundShipmentToDock()` called `client.getAuthenticatedPage()`
 * a SECOND time right after this function returned (to get "the page" for
 * the click sequence) — silently discarding the shipment detail page this
 * function had carefully navigated to and left the page sitting on,
 * bouncing it back to the To Do List instead. The subsequent checkbox
 * click then timed out looking for a checkbox that was never on that page.
 * Every other function in this file takes `page: Page` directly and calls
 * `client.getAuthenticatedPage()` exactly once, at the very top of a
 * flow, then reuses that same reference — this function now does the
 * same, so a caller controls page-fetching exactly once and this
 * "stay on the shipment page" contract can't be silently broken by a
 * second call. **This is a general hazard worth remembering**: never
 * call `getAuthenticatedPage()` more than once within a single logical
 * flow that depends on page continuity — fetch it once, cache the `Page`
 * reference, use raw `page.*` calls for everything after that.
 */
export async function readOutboundShipmentDockState(
  page: Page,
  todoListUrl: string,
  orderNumber: string,
): Promise<OutboundShipmentDockState> {
  await navigateToOrderByNumber(page, orderNumber, todoListUrl);
  await page.getByRole('link', { name: 'Receipt & Returns' }).click();
  await pace(page);
  // SYSTEMATIC AUDIT FIX: allInnerTexts() on a zero-match locator returns
  // an empty array immediately — no wait at all. A render-latency race
  // here would silently look identical to "genuinely no shipments yet",
  // the same false-negative shape as every other read fixed this project.
  // No proven "definitely zero shipments" marker text exists to wait for
  // instead (unlike the OEM grid's "no inventory"), so this waits for at
  // least one real shipment link — a reasonable expectation given this
  // function is only ever called once an order is already past Issue
  // Order, by which point at least one shipment should exist. Best-effort:
  // swallowed on timeout, same reasoning as waitForGeneratedOrderNumberSettled
  // — a genuine zero after 30s is left to the existing, already-correct
  // 'no_outbound_shipment_found' handling below, not thrown.
  try {
    await page.waitForFunction(() => document.querySelectorAll('a').length > 0 &&
      Array.from(document.querySelectorAll('a')).some((a) => /^SRRR\d+/.test((a.textContent ?? '').trim())),
      undefined, { timeout: 30_000, polling: 250 });
  } catch {
    // Swallowed — see comment above.
  }
  const shipmentIds = await page.getByRole('link', { name: /^SRRR\d+/ }).allInnerTexts();

  let outboundShipmentId: string | null = null;
  for (const shipmentId of shipmentIds) {
    await navigateToOrderByNumber(page, orderNumber, todoListUrl);
    await page.getByRole('link', { name: 'Receipt & Returns' }).click();
    await pace(page);
    await page.getByRole('link', { name: shipmentId, exact: true }).click();
    // SYSTEMATIC AUDIT FIX: reads immediately for "Ship From:" right after
    // this click — same whole-body-read vulnerability class fixed
    // elsewhere. Wait for the marker this function's own regex depends on.
    await waitForBodyTextIncludes(page, 'Ship From:', `Shipment detail ${shipmentId} for order ${orderNumber}`);

    const bodyText = await page.locator('body').innerText();
    const shipFromMatch = bodyText.match(/Ship From:\s*([^\t\n]+)/);
    if (shipFromMatch && shipFromMatch[1].trim().endsWith('/DOCK')) {
      outboundShipmentId = shipmentId;
      break; // still on this shipment's own detail page
    }
  }

  if (!outboundShipmentId) {
    return { status: 'no_outbound_shipment_found', shipmentId: null };
  }

  // SYSTEMATIC AUDIT FIX: reads immediately for the "Shipment Lines"
  // section — already confirmed present (this is the same page the
  // "Ship From:" wait above just confirmed rendered), but the "Shipment
  // Lines" sub-section specifically is what this next read depends on.
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
 * Real, from the ORIGINAL discovery-writeOrder-recording.ts (lines 49-53) —
 * "Move to Dock" on the order's OUTBOUND shipment (the one carrying the
 * part TO the vendor), NOT the inbound one that later brings it back. Per
 * the user's explicit correction: the part is physically sitting in the
 * USSTG bin right now, and this action is what tells the physical stores
 * team to pull it and prep it for outbound shipping — it's the real last
 * step of writing up an order, done right after Issue Order.
 *
 * Reads the real current state via readOutboundShipmentDockState() FIRST,
 * before attempting anything — see that function's docstring for the real
 * incident (`P000BAL4`) that made this necessary. If the shipment is
 * already at dock or further along, reports 'already_docked_externally'
 * and does not click anything (clicking "Move to Dock" again on an
 * already-progressed shipment was never tested and isn't assumed safe).
 *
 * Does not self-verify beyond confirming the click sequence completed —
 * same discipline as issueGeneratedOrder(): the caller should
 * independently re-read the shipment's real state afterward.
 */
export async function moveOutboundShipmentToDock(client: MxiClient, orderNumber: string): Promise<MoveToDockResult> {
  try {
    // Fetched exactly once, reused for the whole flow — see
    // readOutboundShipmentDockState's docstring for why calling
    // client.getAuthenticatedPage() again mid-flow is unsafe.
    const page = await client.getAuthenticatedPage();
    const dockState = await readOutboundShipmentDockState(page, client.todoListUrl, orderNumber);

    if (dockState.status === 'no_outbound_shipment_found') {
      return { status: 'no_outbound_shipment_found', shipmentId: null, errorMessage: null };
    }

    if (dockState.status === 'already_docked_or_further') {
      return { status: 'already_docked_externally', shipmentId: dockState.shipmentId, errorMessage: null };
    }

    // dockState.status === 'not_yet_docked' — page is already sitting on
    // this shipment's own detail page, ready to act.
    await page.locator('input[name="aShipmentLine"]').check();
    await pace(page);
    await page.getByRole('link', { name: 'Move to Dock' }).click();
    await pace(page);
    await page.getByRole('link', { name: 'Close' }).click();
    await pace(page);

    return { status: 'success', shipmentId: dockState.shipmentId, errorMessage: null };
  } catch (err) {
    return { status: 'failed', shipmentId: null, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
