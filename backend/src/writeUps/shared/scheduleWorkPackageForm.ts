import type { Page } from 'playwright';
import { extractBaseStation, routeBaseStation } from './approvedLocations.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/selectors.ts, aeroRepair/returnToLocation.ts,
 * and aeroRepair/gridWait.ts per VENDOR_MODULE_REFACTOR_SPEC.md section
 * 3.4 — the Schedule Work Package form's field IDs, label-based dropdown
 * selection, and "STATION/USSTG -> STATION/DOCK" return-to-location
 * transform are confirmed identical across Aero Repair's and 0T1Y4's real
 * recordings (both BN and warranty). Pure relocation, no behavior change —
 * re-exported from aeroRepair/selectors.ts and
 * aeroRepair/returnToLocation.ts so every existing call site keeps working
 * unchanged.
 */

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 3 — every line in the real
 * 2026-08-05 batch run, INCLUDING all 6 successful ones, burned the full
 * 30s here before falling through to findGeneratedOrderNumber's own
 * (correct) check below — roughly 6.5 of ~18 minutes across 13 lines spent
 * confirming what should have been an near-instant positive read.
 *
 * REAL ROOT CAUSE: this used to poll via a raw `page.waitForFunction` with
 * a hand-rolled `a.textContent?.trim() === targetLinkText` DOM comparison —
 * the EXACT SAME whitespace-normalization bug found and fixed for the
 * vendor-bid rows (see gridWait.ts's collectVendorBidRows docstring: a real
 * production capture showed this comparison matching ZERO elements for a
 * page that had, in fact, fully rendered). That predicate never matched
 * the target link at all, on ANY line, so it never resolved true and
 * always burned the full timeout — the "definitive wait" was never
 * actually observing genuine render latency, it was just failing to find
 * its own target every single time.
 *
 * Fixed by inverting the check, per the explicit instruction: read via
 * Playwright's own accessible-name-based locator resolution (the SAME
 * mechanism findGeneratedOrderNumber's real check already correctly uses)
 * directly, with a SHORT timeout — since the underlying state was never
 * actually slow to render, just being watched for with the wrong
 * predicate. A genuine absence is still a legitimate, definitive negative
 * (findGeneratedOrderNumber's own .count() check right after this
 * correctly reports null) — this just no longer wastes 30s establishing
 * that on the common, fast, happy path.
 */
const GENERATED_ORDER_SHORT_TIMEOUT_MS = 5_000;

export async function waitForGeneratedOrderNumberSettled(
  page: Page,
  linkText: string,
  orderNumberPatternSource: string,
): Promise<void> {
  const start = Date.now();
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  const orderLink = targetTr.getByRole('link', { name: new RegExp(orderNumberPatternSource) }).first();

  try {
    await orderLink.waitFor({ state: 'attached', timeout: GENERATED_ORDER_SHORT_TIMEOUT_MS });
    log.debug({ linkText, durationMs: Date.now() - start }, '[grid-wait] generated-order-number appeared');
  } catch {
    // Swallowed deliberately: findGeneratedOrderNumber's own .count() check
    // right after this correctly reports null on a genuine absence —
    // already handled correctly downstream.
    log.debug(
      { linkText, timeoutMs: GENERATED_ORDER_SHORT_TIMEOUT_MS },
      '[grid-wait] generated-order-number did not appear within timeout — proceeding to the real check, which may still correctly report null',
    );
  }
}

/**
 * Reads the "<STATION>/<CODE>" location token (e.g. "DCA/USSTG") from the
 * row matching the TARGET line's own known-unique repair-link text.
 */
export async function readCurrentLocationCode(page: Page, linkText: string): Promise<string> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const row = repairLink.locator('xpath=ancestor::tr[1]');
  const rowText = await row.innerText();
  // Case-insensitive: MXI's own location casing varies by site — the real
  // location picker holds DFW/REPAIR1/SHOP1 alongside PNS/Repair1/Shop1,
  // CAK/, CLT/, GSP/, ORF/, SAV/ (confirmed live 2026-08-23). An
  // uppercase-only match threw outright at those sites.
  const match = rowText.match(/\b([A-Za-z]{3})\/([A-Za-z0-9]+)\b/);
  if (!match) {
    throw new Error(
      `Could not find a "<STATION>/<CODE>" location token in the target line's row text: "${rowText}"`,
    );
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * Given an order's current location (e.g. "DCA/USSTG"), extract the station
 * code and return "<code>/DOCK" — the value filled into Return to Location.
 * Confirmed against both Aero Repair's and 0T1Y4's recordings (DCA/USSTG ->
 * DCA/DOCK; PNS/USSTG -> PNS/DOCK; PHL/USSTG -> PHL/DOCK).
 *
 * Throws rather than guessing if the input doesn't match the expected
 * "<CODE>/..." shape.
 */
export function transformReturnToLocation(currentLocation: string): string {
  const base = extractBaseStation(currentLocation);
  if (!base) {
    throw new Error(
      `Could not extract a station code from return-to-location value "${currentLocation}" — expected a "<CODE>/..." shape.`,
    );
  }
  // Routing lives in approvedLocations.ts, which is also what the
  // discovery-time approval check uses — one source of truth, so the base
  // a line is ACCEPTED for can never disagree with the base its order is
  // actually created against.
  //
  // Two changes from the inline switch this replaces, both confirmed with
  // the user on 2026-08-27: TUC was a typo for TUS, and PHL now routes to
  // ITSELF rather than to CLT.
  return `${routeBaseStation(base)}/DOCK`;
}

/** `Schedule Work Package` link on the To Do List / order-line view. */
export async function clickScheduleWorkPackage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Schedule Work Package' }).click();
  await pace(page);
}

/**
 * `Schedule Work Package` lands on `ScheduleCheck.jsp`, a generic
 * internal/external-vendor toggle defaulted to "Work done internally".
 * Selecting this radio (the second of the two `input[type="radio"]`
 * elements on this page) is what reveals the vendor-specific fields
 * (Charge To Account, Purchasing Contact, Terms & Conditions, etc.).
 */
export async function selectExternalVendorWorkPackage(page: Page): Promise<void> {
  await page.locator('input[type="radio"]').nth(1).check();
  await pace(page);
}

export async function readChargeToAccount(page: Page): Promise<string> {
  return page.locator('#idEditFieldChargeToAccount').inputValue();
}

export async function fillChargeToAccount(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldChargeToAccount').click();
  await pace(page);
  await page.locator('#idEditFieldChargeToAccount').fill(value);
  await pace(page);
}

export async function fillPurchasingContact(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldPurchasingContact').click();
  await pace(page);
  await page.locator('#idEditFieldPurchasingContact').fill(value);
  await pace(page);
}

/**
 * Selected by visible label (`selectOption({ label })`) — the recording
 * only captured opaque `{AES}...` encoded values, confirmed unstable across
 * sessions (see VENDOR_MODULE_REFACTOR_SPEC.md's open items).
 */
export async function selectConditions(page: Page, label: string): Promise<void> {
  await page.locator('#idDropdownTermsConditions').selectOption({ label });
  await pace(page);
}

export async function fillReturnToLocation(page: Page, value: string): Promise<void> {
  await page.locator('#idEditFieldReturnToLocation').click();
  await pace(page);
  await page.locator('#idEditFieldReturnToLocation').fill(value);
  await pace(page);
}

/** Same label-based caveat as selectConditions. */
export async function selectTransportation(page: Page, label: string): Promise<void> {
  await page.locator('#idDropdownTransportType').selectOption({ label });
  await pace(page);
}

export async function fillNotesToVendor(page: Page, value: string): Promise<void> {
  await page.locator('#idTextAreaNoteToVendor').click();
  await pace(page);
  await page.locator('#idTextAreaNoteToVendor').fill(value);
  await pace(page);
}

/** Exact-match "OK" link that confirms/saves the Schedule Work Package form. */
export async function confirmScheduleWorkPackage(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
}

/** Clicks the newly-generated order number link to navigate into it. */
export async function openGeneratedOrder(page: Page, orderNumber: string): Promise<void> {
  await page.getByRole('link', { name: orderNumber, exact: true }).click();
  await pace(page);
}

const ORDER_NUMBER_PATTERN = /^P\d{3}[A-Z0-9]{4}$/;

/**
 * Scoped to the SAME row as the specific repair line just scheduled (via
 * its known-unique linkText) — the part-number-filtered grid can show
 * OTHER pre-existing orders for OTHER lines of the same part number, so an
 * unscoped "first order-number-shaped link on the page" search is unsafe.
 */
export async function findGeneratedOrderNumber(page: Page, linkText: string): Promise<string | null> {
  await waitForGeneratedOrderNumberSettled(page, linkText, ORDER_NUMBER_PATTERN.source);

  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  const orderLinks = targetTr.getByRole('link', { name: ORDER_NUMBER_PATTERN });
  const count = await orderLinks.count();
  if (count === 0) return null;
  return (await orderLinks.first().innerText()).trim();
}
