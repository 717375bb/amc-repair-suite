import type { Page } from 'playwright';
import { extractBaseStation } from '../writeUps/shared/approvedLocations.js';
import { readCurrentLocationCode } from '../writeUps/shared/scheduleWorkPackageForm.js';
import { pickLocationInPopup, repairLocationCandidates } from '../mxiWriter/scrapFlowHelpers.js';
import { createAdHocTaskForCandidate, openCreateNewTask } from '../writeUps/shared/taskRecovery.js';
import { PIN_BACK_SHOP_ORDER, resolvePinDestination, type PinBackShop, type PinBackShopAvailability } from './pinAvailability.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('backshop');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/** The one part number this whole module applies to — confirmed by explicit user direction. */
export const PIN_PART_NUMBER = '4114T06P03';

/**
 * The fixed ad-hoc task this rule attaches at a correct-base pin's
 * Create New Task step, confirmed from discovery-pins-correct-base-
 * recording.ts. Reused as-is via createAdHocTaskForCandidate (the same
 * shared helper the vendor-code write-up's own no-task recovery path
 * uses), rather than replicating the recording's raw tab-separated fill
 * string, since that helper is already proven against this exact "Create
 * New Task" -> Ad-Hoc radio -> #idInput12 -> OK -> Close control.
 */
export const PIN_ADHOC_TASK_NAME = 'JIC-72-21-00-800-806 (TROUBLESHOOTING FOR HIGH TORQUE PINS)';
export const PIN_ADHOC_TASK_CHECK_ID = 'TRFKE00H4SDG';

export function isPinBackShop(base: string | null | undefined): base is PinBackShop {
  return !!base && (PIN_BACK_SHOP_ORDER as readonly string[]).includes(base.toUpperCase());
}

/**
 * Reads the pin's current base off its ToDoList row (same mechanism as
 * the vendor-code engine's own readCurrentLocationCode) and reports
 * whether it's one of the four shops that repair pins.
 */
export async function resolvePinCurrentBase(
  page: Page,
  linkText: string,
): Promise<{ currentLocation: string; base: string | null; isBackShop: boolean }> {
  const currentLocation = await readCurrentLocationCode(page, linkText);
  const base = extractBaseStation(currentLocation);
  return { currentLocation, base, isBackShop: isPinBackShop(base) };
}

/**
 * Finds the pin's repair line on the ToDoList by its BN. Confirmed from
 * both pins recordings: the correct-base recording's own link name is the
 * fuller "Repair PIN <desc> (PN: 4114T06P03, BN: BN <n>)" shape; the
 * wrong-base recording instead clicked a bare "4114T06P03" link before
 * later clicking a separate "BN <n>" link. Only the fuller shape is
 * confirmed to uniquely identify ONE specific pin among possibly several
 * open lines for the same part number — tried first, with the bare-PN
 * shape only as a documented fallback (logged clearly, since it is NOT
 * confirmed unique when more than one pin line is open at once).
 */
export async function openPinLineByBn(page: Page, todoListUrl: string, bn: string): Promise<string> {
  await page.goto(todoListUrl);
  await pace(page);

  const fullLinkPattern = new RegExp(`Repair PIN .*PN: ${PIN_PART_NUMBER}.*BN: ${bn}\\)`, 'i');
  const fullLink = page.getByRole('link', { name: fullLinkPattern });
  if ((await fullLink.count()) > 0) {
    const linkText = (await fullLink.first().innerText()).trim();
    await fullLink.first().click();
    await pace(page);
    return linkText;
  }

  log.warn(
    { bn },
    '[pin-routing] no "Repair PIN ... (PN: ..., BN: ...)" link found — falling back to matching a bare BN link. ' +
      'NOT confirmed unique when more than one pin line is open at once; verify the right line opened.',
  );
  const bareBnLink = page.getByRole('link', { name: bn, exact: true });
  const linkText = (await bareBnLink.first().innerText()).trim();
  await bareBnLink.first().click();
  await pace(page);
  return linkText;
}

export interface PinCorrectBaseFlowResult {
  status: 'success' | 'failed';
  locationUsed: string | null;
  errorMessage: string | null;
}

/**
 * The already-at-a-correct-base pin flow, from
 * discovery-pins-correct-base-recording.ts: Create New Task (fixed
 * ad-hoc task, see PIN_ADHOC_TASK_NAME/PIN_ADHOC_TASK_CHECK_ID above),
 * Schedule Work Package to the SAME base's repair shop, then a Create
 * Transfer to that same shop.
 *
 * Reuses pickLocationInPopup/repairLocationCandidates (mxiWriter/
 * scrapFlowHelpers.ts) — the already-production-proven mechanism for this
 * exact "Select Repair Location" / "Select Local Location" popup pair,
 * confirmed to handle both the DAY exception (REPAIR2/SHOP2) and MXI's
 * inconsistent location casing across sites.
 *
 * The recording's own Close sequence after Create New Task shows only ONE
 * "Close" link click, while the shared createAdHocTaskForCandidate helper
 * (used elsewhere for this same control) expects a "Close" CELL first,
 * then a "Close" LINK. Both are attempted here, the cell one tolerated as
 * optional, matching this project's established "click through if it
 * appears, if not, move on" convention for intermittent confirmation
 * steps (scrapFlowHelpers.ts) rather than assuming either recording is
 * the complete picture.
 */
export async function runPinCorrectBaseFlow(page: Page, base: PinBackShop): Promise<PinCorrectBaseFlowResult> {
  await openCreateNewTask(page);
  await page.locator('#idRadioAdHoc').check();
  await pace(page);
  await page.locator('#idInput12').click();
  await page.locator('#idInput12').fill(`${PIN_ADHOC_TASK_NAME} ${PIN_ADHOC_TASK_CHECK_ID}`);
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);

  const closeCell = page.getByRole('cell', { name: 'Close' });
  if ((await closeCell.count()) > 0) {
    await closeCell.first().click();
    await pace(page);
  }
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);

  await page.getByRole('link', { name: 'Schedule Work Package' }).click();
  await pace(page);

  const candidates = repairLocationCandidates(base);
  const scheduleLocation = page.locator('#idEditFieldScheduledLocation');
  await scheduleLocation.click();
  await scheduleLocation.fill(base.toLowerCase());
  const schedulePopupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Select Repair Location' }).click();
  const schedulePopup = await schedulePopupPromise;
  await schedulePopup.waitForLoadState('domcontentloaded');
  const scheduled = await pickLocationInPopup(schedulePopup, candidates);
  if (!scheduled) {
    return {
      status: 'failed',
      locationUsed: null,
      errorMessage: `None of the expected repair locations (${candidates.join(', ')}) exist in the picker for ${base}.`,
    };
  }
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);

  const bnLink = page.getByRole('link', { name: /^BN /, exact: false }).first();
  await bnLink.click();
  await pace(page);
  await page.getByRole('link', { name: 'Create Transfer' }).click();
  await pace(page);

  const transferPopupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Select Local Location' }).click();
  const transferPopup = await transferPopupPromise;
  await transferPopup.waitForLoadState('domcontentloaded');
  // Per the same rule confirmed for in-house scrap: the transfer location
  // is always the same as the scheduled location.
  const transferred = await pickLocationInPopup(transferPopup, [scheduled]);
  if (!transferred) {
    return {
      status: 'failed',
      locationUsed: scheduled,
      errorMessage: `Scheduled to ${scheduled}, but that same location was not found in the transfer picker.`,
    };
  }
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);

  return { status: 'success', locationUsed: transferred, errorMessage: null };
}

/**
 * Reaches the part-level Availability tab for pins, via
 * discovery-availability-table-recording.ts's own confirmed working path:
 * ToDoList -> Menu -> "Unserviceable Staging Clerk" -> "Part Search" ->
 * fill the OEM part number search box -> Search -> click the part number
 * link -> click the "Availability" tab (#idTabAvailability).
 *
 * That same recording's file also contains an EARLIER, different attempt
 * (Menu -> "Unserviceable Inventories" -> Options... -> #idOEMPartNo) that
 * is NOT used here — it never reaches idTabAvailability at all, and reads
 * as an abandoned dead end the analyst tried first, same as other
 * recordings in this project that contain exploratory clicks before the
 * real working sequence.
 *
 * This is a fresh, PART-NUMBER-level navigation (Part Search), independent
 * of whichever specific BN/serial triggered the check — deliberately NOT
 * assumed to share page state with a repair line opened via
 * openPinLineByBn. Callers that need to return to a specific BN's line
 * afterward (e.g. to run Create Shipment) should re-open it explicitly via
 * openPinLineByBn rather than relying on this navigation returning there.
 */
export async function navigateToPinAvailabilityTab(page: Page, todoListUrl: string): Promise<void> {
  await page.goto(todoListUrl);
  await pace(page);
  await page.locator('#idMenuButton').click();
  await pace(page);
  await page.getByRole('link', { name: /Unserviceable Staging Clerk/i }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Part Search' }).click();
  await pace(page);
  await page.locator('input[name="aPartNo_OEM"]').fill(`\t${PIN_PART_NUMBER}`);
  await pace(page);
  await page.getByRole('link', { name: 'Search' }).click();
  await pace(page);
  await page.getByRole('link', { name: PIN_PART_NUMBER, exact: true }).first().click();
  await pace(page);
  await page.locator('#idTabAvailability').click();
  await pace(page);
}

export interface PinAvailabilityRowRead extends PinBackShopAvailability {
  /**
   * The row's own label cell, exact rendered text (e.g.
   * "CAK (AKRON-CANTON REGIONAL)") — confirmed shape from
   * discovery-availability-table-recording.ts's own clicked cell. Needed
   * to click this exact row later (confirmPinAvailabilitySelection),
   * since only the base CODE is known ahead of time, not the full city
   * name in parentheses.
   */
  rowLabelText: string;
}

function parseAvailabilityNumericCell(text: string): number {
  const trimmed = text.trim();
  const value = Number(trimmed);
  return trimmed === '' || Number.isNaN(value) ? 0 : value;
}

/**
 * Reads the Availability tab's table (must already be open — see
 * navigateToPinAvailabilityTab), one row per back shop. Each row is
 * located by its own label cell text ("<CODE> (<City Name>)", confirmed
 * from discovery-availability-table-recording.ts) rather than by a table
 * id — no recording ever captured the table's own id/class (codegen only
 * records clicked elements), and a base's own name is a far more
 * specific, collision-resistant anchor regardless.
 *
 * Within a matched row, the first non-label cell is read as U/S units and
 * the second as In Repair — the same order already confirmed against
 * discovery-pins-wrong-base-recording.ts's own real outcome (see
 * pinAvailability.ts's docblock: CAK 31+0, DAY 30+0, GSP 72+112, ORF
 * 88+84, DAY being both the lowest total AND the recording's own actual
 * shipped-to destination). Not from an explicit column header — none was
 * ever captured — so the full row is logged alongside the parsed numbers
 * for verification on the first live run.
 */
export async function readPinAvailabilityTable(page: Page): Promise<PinAvailabilityRowRead[]> {
  const rows: PinAvailabilityRowRead[] = [];
  for (const base of PIN_BACK_SHOP_ORDER) {
    const labelCell = page.getByRole('cell', { name: new RegExp(`^${base}\\s*\\(`) });
    if ((await labelCell.count()) === 0) {
      log.warn({ base }, '[pin-routing] no row found for this base on the Availability tab — treating its total as 0');
      rows.push({ base, usUnits: 0, inRepair: 0, rowLabelText: '' });
      continue;
    }
    const rowLabelText = (await labelCell.first().innerText()).replace(/\s+/g, ' ').trim();
    const tr = labelCell.first().locator('xpath=ancestor::tr[1]');
    const cellTexts = (await tr.locator('td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const numericCells = cellTexts.filter((t) => t !== rowLabelText);
    const usUnits = numericCells[0] !== undefined ? parseAvailabilityNumericCell(numericCells[0]) : 0;
    const inRepair = numericCells[1] !== undefined ? parseAvailabilityNumericCell(numericCells[1]) : 0;
    log.info({ base, rowLabelText, cellTexts, usUnits, inRepair }, '[pin-routing] read availability row');
    rows.push({ base, usUnits, inRepair, rowLabelText });
  }
  return rows;
}

/**
 * Confirms the computed destination on the Availability tab itself:
 * clicks that base's own row-label cell, then OK — the exact final two
 * steps of discovery-availability-table-recording.ts. `rowLabelText` must
 * be the exact text read for that row by readPinAvailabilityTable above
 * (the full city name in parentheses is not knowable ahead of time).
 */
export async function confirmPinAvailabilitySelection(page: Page, rowLabelText: string): Promise<void> {
  await page.getByRole('cell', { name: rowLabelText, exact: true }).click();
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
}

/**
 * MXI's confirmed real date-field format, DD-MMM-YYYY uppercased (e.g.
 * "10-JUN-2026") — the same format esdFormatting.ts's toMxiDateFormat
 * already writes for the Promise By field elsewhere in this project, per
 * explicit user direction (2026-09-10): "You can just type in the date in
 * the box with the normal format" — no calendar picker needed at all.
 */
export function toMxiDateString(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${day}-${month}-${date.getFullYear()}`;
}

/**
 * Fills a date field directly. Deliberately `.fill()`, never a
 * click-then-type sequence: selectors.ts's own updateEsdField documents a
 * REAL bug on a different MXI date field where per-keystroke JS validation
 * silently corrupted typed input (e.g. typing "09-JUL-2026" over
 * "10-JUL-2026" produced "10-JUL-2020") — `.fill()` sets the value via a
 * direct DOM input/change event, sidestepping that class of bug, and is
 * applied here on the same reasoning even though this specific field
 * wasn't the one tested.
 *
 * `fieldId` (idShipByDate / idEstArrivalDate) is inferred from the
 * recording's own button ids (idShipByDate_SelectBtn /
 * idEstArrivalDate_SelectBtn) rather than confirmed directly — no
 * recording ever exercised typing into these fields, only the calendar
 * button. A wrong guess here fails loudly (locator not found) rather than
 * silently corrupting a date, since a missing element throws.
 */
async function fillMxiDateField(page: Page, fieldId: string, date: Date): Promise<void> {
  const value = toMxiDateString(date);
  const field = page.locator(`#${fieldId}`);
  await field.click();
  await field.fill(value);
  await pace(page);
  log.info({ fieldId, value }, '[pin-routing] filled date field directly');
}

export interface PinShipmentFlowResult {
  status: 'success' | 'failed';
  shipTo: string | null;
  errorMessage: string | null;
}

/**
 * Create Shipment for the wrong-base transfer, from
 * discovery-pins-wrong-base-recording.ts, with the business rules
 * confirmed directly by the user (2026-09-10) replacing what that single
 * recording's own literal values could not generalize on their own:
 *   - Ship From: left alone — autofills.
 *   - Ship To: "<destinationBase>/DOCK".
 *   - Ship By date: today, typed directly (no calendar picker — the
 *     recording's own SelectBtn/calendar-link clicks are NOT used; see
 *     fillMxiDateField above).
 *   - Estimated Arrival date: tomorrow, same direct-fill mechanism.
 *   - Reason: always "REPAIR" (selected by label, a real `<select>` —
 *     same #idDropdownReason control writeVendorScrap.ts already selects
 *     by label elsewhere, rather than the recording's own raw encoded
 *     option value, which is opaque and not confirmed stable).
 * Then checks the shipment line and clicks Move to Dock, same as the
 * recording.
 *
 * Must be called with the page already on the target BN's own repair
 * line / Work Package Details (e.g. immediately after openPinLineByBn) —
 * NOT assumed to follow on from navigateToPinAvailabilityTab's own
 * Part-Search-based navigation, which is a different, independent path
 * (see that function's own docblock).
 */
export async function runPinWrongBaseShipmentFlow(page: Page, destinationBase: PinBackShop): Promise<PinShipmentFlowResult> {
  const bnLink = page.getByRole('link', { name: /^BN /, exact: false }).first();
  await bnLink.click();
  await pace(page);
  await page.getByRole('link', { name: 'Create Shipment' }).click();
  await pace(page);

  const shipTo = `${destinationBase}/DOCK`;
  const shipToField = page.locator('#idFieldShipTo');
  await shipToField.click();
  await shipToField.fill(shipTo);
  await pace(page);
  const suggestion = page.getByText(shipTo, { exact: true });
  if ((await suggestion.count()) === 0) {
    return {
      status: 'failed',
      shipTo: null,
      errorMessage: `Filled Ship To with "${shipTo}" but no matching autocomplete suggestion appeared to confirm it.`,
    };
  }
  await suggestion.first().click();
  await pace(page);

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  await fillMxiDateField(page, 'idShipByDate', today);
  await fillMxiDateField(page, 'idEstArrivalDate', tomorrow);

  await page.locator('#idDropdownReason').selectOption({ label: 'REPAIR' });
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);

  await page.locator('input[name="aShipmentLine"]').check();
  await pace(page);
  await page.getByRole('link', { name: 'Move to Dock' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);

  return { status: 'success', shipTo, errorMessage: null };
}
