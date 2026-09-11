import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import { extractBaseStation } from '../writeUps/shared/approvedLocations.js';
import { runSerialSearch } from '../mxiWriter/openInventoryBySerial.js';
import {
  armPopupWait,
  clickUntilUrlContains,
  pickLocationInPopup,
  readCurrentLocationOnDetailsTab,
  repairLocationCandidates,
} from '../mxiWriter/scrapFlowHelpers.js';
import { createAdHocTaskForCandidate, openCreateNewTask } from '../writeUps/shared/taskRecovery.js';
import {
  computeAvailabilityColumnOffsets,
  extractUsageFromRowCells,
  FALLBACK_AVAILABILITY_COLUMN_OFFSETS,
  PIN_BACK_SHOP_ORDER,
  resolvePinDestination,
  type AvailabilityColumnOffsets,
  type PinBackShop,
  type PinBackShopAvailability,
} from './pinAvailability.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import type { MxiEnv } from '../mxiWriter/config.js';
import { insertWriteUpAction } from '../db/db.js';
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
 * Whether a part number is the pin this whole module applies to. Trimmed
 * and uppercased the same way every other part-number comparison in this
 * project is (see e.g. partModificationNotes.ts), so "4114t06p03" or
 * " 4114T06P03 " off a real sheet still matches.
 */
export function isPinPartNumber(partNumber: string | null | undefined): boolean {
  return !!partNumber && partNumber.trim().toUpperCase() === PIN_PART_NUMBER;
}

/** Real URL markers for the inventory-details tabs, same values writeInHouseScrap.ts already confirmed against production. */
const OPEN_TAB_URL_MARKER = 'aTab=Open';
const OPEN_CHECKS_URL_MARKER = 'aTab=Open.OpenChecks';

/**
 * Finds a pin by its BN, reads its current base, and lands on its own
 * Work Package view (ready for Create New Task) — REPLACES the previous
 * ToDoList-link-click entry point entirely.
 *
 * REAL BUG FIXED (2026-09-12, found via a live failed run — every pin
 * timed out on `getByRole('link', { name: '<the given BN>', exact: true
 * })`, and watching the browser showed it never even attempted a search).
 * The recordings this module was originally built from
 * (discovery-pins-correct-base-recording.ts,
 * discovery-pins-wrong-base-recording.ts) turned out to be an inaccurate
 * capture — confirmed directly by the user: "The recording was a little
 * weird and didn't truly capture the whole process." A THIRD recording,
 * discovery-pins-start-recording.ts, was made specifically to capture the
 * real entry sequence (and, per the user, is authoritative only up through
 * "clicking into the part and the work package" — anything after that
 * point that disagrees with the original two recordings defers to them,
 * per explicit instruction). That recording shows:
 *
 *   Menu -> "Unserviceable Staging Clerk >" -> "Inventory Search"
 *   -> fill aSerialNo_SERIAL with "BN <n>" -> Search
 *   -> click the result row (recorded as a PLAIN "BN" match, NOT an exact
 *      full-string match — the result link's real accessible name is not
 *      confirmed to be the exact "BN <n>" string, so this does not use
 *      exact:true either)
 *   -> "Open" tab -> "Open Work Packages" tab
 *   -> "Repair PIN <component> (PN: ...)" link (a PREFIX match here too —
 *      the component description varies per pin, only "Repair PIN" is
 *      stable)
 *
 * Reuses three already-proven pieces rather than re-guessing any of them:
 *   - `runSerialSearch` (mxiWriter/openInventoryBySerial.ts) — the exact
 *     search-box mechanism already proven for both plain serials and (per
 *     this new recording) BN-prefixed identifiers.
 *   - `clickUntilUrlContains` (mxiWriter/scrapFlowHelpers.ts) — the
 *     Open -> Open Work Packages tab navigation already proven live for
 *     in-house scrap, including its own documented race-condition fix.
 *   - `readCurrentLocationOnDetailsTab` (mxiWriter/scrapFlowHelpers.ts) —
 *     reads the item's own "Location:" label, working around MXI's
 *     real tab-memory quirk. Called BEFORE the Open/Open-Work-Packages
 *     navigation below (order matters: it forces the Details tab active
 *     if needed, which would otherwise undo the Open Work Packages tab
 *     this function needs to end on).
 *
 * Everything AFTER landing on the Work Package view (Create New Task,
 * Schedule Work Package, Create Transfer, Create Shipment) is UNCHANGED —
 * still built from the original two recordings, per the user's own
 * explicit instruction to defer to them for anything past this point.
 */
export async function openPinByBn(
  page: Page,
  todoListUrl: string,
  bn: string,
): Promise<{ currentLocation: string; base: string | null; isBackShop: boolean }> {
  const searchFailure = await runSerialSearch(page, todoListUrl, bn);
  if (searchFailure) {
    throw new Error(`Could not find inventory for BN "${bn}": ${searchFailure.error ?? searchFailure.status} (url "${searchFailure.url}").`);
  }

  const hit = page.getByRole('link', { name: bn });
  if ((await hit.count()) === 0) {
    throw new Error(`Inventory search for BN "${bn}" reported results, but no link on the page matched "${bn}".`);
  }
  await hit.first().click();
  await pace(page);

  // Read location FIRST, before switching to Open Work Packages below —
  // this may itself force the Details tab active, which would otherwise
  // undo the tab this function needs to end on.
  const { currentLocation, onDetailsTab } = await readCurrentLocationOnDetailsTab(page, bn);
  const base = extractBaseStation(currentLocation);
  log.info({ bn, currentLocation, base, onDetailsTab }, '[pin-routing] resolved current base via inventory search');

  const onOpenTab = await clickUntilUrlContains(page, page.getByRole('link', { name: 'Open', exact: true }), OPEN_TAB_URL_MARKER, 'Open tab', bn);
  const onOpenChecks = await clickUntilUrlContains(
    page,
    page.getByRole('link', { name: 'Open Work Packages' }),
    OPEN_CHECKS_URL_MARKER,
    'Open Work Packages tab',
    bn,
  );
  if (!onOpenChecks) {
    throw new Error(
      `Could not open the Open Work Packages view for BN "${bn}" (reached Open tab: ${onOpenTab}; still on "${page.url()}").`,
    );
  }

  const repairLink = page.getByRole('link', { name: /^Repair PIN/i });
  if ((await repairLink.count()) === 0) {
    throw new Error(`No "Repair PIN..." work package link found for BN "${bn}" on the Open Work Packages view (url "${page.url()}").`);
  }
  await repairLink.first().click();
  await pace(page);

  return { currentLocation, base, isBackShop: isPinBackShop(base) };
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
  // REAL BUG FOUND AND FIXED (2026-09-12, live failure — two real pins
  // both timed out here waiting 30s for #idEditFieldScheduledLocation):
  // this field IS in discovery-pins-correct-base-recording.ts, but the
  // already-production-proven in-house scrap flow's own Schedule Work
  // Package step (writeInHouseScrap.ts) has NO such field at all — it
  // goes straight from clicking "Schedule Work Package" to "Select Repair
  // Location", which opens the popup on its own. Treated as OPTIONAL here
  // rather than required either way: filled when present (matching the
  // recording), skipped when it genuinely isn't there (matching the
  // proven scrap mechanism) — never a hard 30s block on a field whose
  // real presence isn't settled.
  const scheduleLocation = page.locator('#idEditFieldScheduledLocation');
  try {
    await scheduleLocation.first().waitFor({ state: 'visible', timeout: 8000 });
    await scheduleLocation.click();
    await scheduleLocation.fill(base.toLowerCase());
    await pace(page);
  } catch {
    log.info(
      { base },
      '[pin-routing] no scheduled-location field found on Schedule Work Package — proceeding straight to Select Repair Location',
    );
  }
  const schedulePopupPromise = armPopupWait(page);
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

  const transferPopupPromise = armPopupWait(page);
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
 * openPinByBn. Callers that need to return to a specific BN's line
 * afterward (e.g. to run Create Shipment) should re-open it explicitly via
 * openPinByBn rather than relying on this navigation returning there.
 */
export async function navigateToPinAvailabilityTab(page: Page, todoListUrl: string): Promise<void> {
  await page.goto(todoListUrl);
  await pace(page);
  await page.locator('#idMenuButton').click();
  await pace(page);
  // REAL BUG FOUND AND FIXED (2026-09-12, live failure): a bare
  // /Unserviceable Staging Clerk/i matches TWO menu entries — the clerk
  // role itself AND "Unserviceable Staging Clerk Reports" — which
  // Playwright's strict mode rejects outright. This exact bug was already
  // found and fixed in openInventoryBySerial.ts's runSerialSearch
  // (2026-08-23); this second occurrence, written separately for this
  // function, didn't get the same anchor. Anchored the same way: the
  // accessible name normalises to "Unserviceable Staging Clerk >", while
  // the Reports entry has a word between the name and the chevron.
  await page.getByRole('link', { name: /^Unserviceable Staging Clerk\s*>/i }).click();
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

/**
 * Reads the offset-from-the-end for U/S and In Repair off whichever
 * header row actually contains both as their own cells on the live page —
 * see pinAvailability.ts's computeAvailabilityColumnOffsets for why
 * "from the end" and the full evidence trail for this fix. Falls back to
 * a single historical example (logged loudly) only if no such header row
 * can be found.
 */
/**
 * Absurdly generous upper bound on how many cells a genuine header ROW
 * could plausibly have — real one is ~17 (Location/Owner/Restock
 * Level/On Order/Serviceable/Unserviceable group headers plus 11
 * sub-columns). Anything past this means the "row" isn't really the
 * header row at all (see the real bug this guards below).
 */
const MAX_PLAUSIBLE_HEADER_CELLS = 40;

async function findAvailabilityColumnOffsets(page: Page): Promise<AvailabilityColumnOffsets> {
  // REAL BUG FOUND AND FIXED (2026-09-12, live failure — a real table with
  // decisive numbers (CAK 31/DAY 86/GSP 100/ORF 116) still came back as a
  // 0-0-0-0 tie even AFTER the column-offset fix). Logged evidence showed
  // why: `page.locator('tr').filter({ hasText: 'U/S' }).filter({ hasText:
  // 'In Repair' })` matched an OUTER WRAPPER row, not the real header row
  // — MXI's Availability tab nests the actual data table inside a layout
  // table, and the wrapper row's own aggregate text includes the ENTIRE
  // nested table's content concatenated together (confirmed live: the
  // "header row" this found had 240+ cells, and the derived offsets were
  // usFromEnd: 232 / inRepairFromEnd: 229 — nonsense numbers that, applied
  // to a real ~15-cell data row, indexed out of bounds and silently
  // returned undefined -> 0 for every base, all over again).
  //
  // Fixed to use the SAME "find one specific, uniquely-matching CELL, then
  // take its NEAREST ancestor <tr>" pattern already proven correct for the
  // data rows below (labelCell's own xpath ancestor::tr[1]) — a `<tr>`
  // located this way can never accidentally be an outer wrapper, since it
  // is defined as the closest enclosing row of a cell whose OWN exact text
  // is "U/S", not a row merely CONTAINING that text somewhere in its
  // (possibly deeply nested) descendants.
  const usHeaderCell = page.getByRole('cell', { name: 'U/S', exact: true }).first();
  if ((await usHeaderCell.count()) > 0) {
    const headerRow = usHeaderCell.locator('xpath=ancestor::tr[1]');
    const headerCells = (await headerRow.locator('td, th').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const offsets = computeAvailabilityColumnOffsets(headerCells);
    // Second line of defense: even via the anchor-cell approach, refuse
    // to trust an obviously-too-large result rather than silently
    // indexing out of bounds again.
    if (offsets && headerCells.length <= MAX_PLAUSIBLE_HEADER_CELLS) {
      log.info({ headerCells, offsets }, '[pin-routing] derived availability column offsets from the live header row');
      return offsets;
    }
    log.warn(
      { headerCells, headerCellCount: headerCells.length, offsets },
      '[pin-routing] found a "U/S" cell but its nearest row looks implausible as a real header row — falling back rather than trusting it',
    );
  }
  log.warn(
    { fallback: FALLBACK_AVAILABILITY_COLUMN_OFFSETS },
    '[pin-routing] could not find a header row stating both "U/S" and "In Repair" — falling back to the offsets from ' +
      'a single historical example table. Verify against the live page if totals look wrong.',
  );
  return FALLBACK_AVAILABILITY_COLUMN_OFFSETS;
}

/**
 * Reads the Availability tab's table (must already be open — see
 * navigateToPinAvailabilityTab), one row per back shop. Each row is
 * located by its own label cell text ("<CODE> (<City Name>)", confirmed
 * from discovery-availability-table-recording.ts) rather than by a table
 * id — no recording ever captured the table's own id/class (codegen only
 * records clicked elements), and a base's own name is a far more
 * specific, collision-resistant anchor regardless.
 */
export async function readPinAvailabilityTable(page: Page): Promise<PinAvailabilityRowRead[]> {
  const offsets = await findAvailabilityColumnOffsets(page);
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
    const { usUnits, inRepair } = extractUsageFromRowCells(cellTexts, offsets);
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
 * REAL BUG FOUND AND FIXED (2026-09-12, live failure — `locator.click:
 * Timeout 30000ms exceeded ... waiting for locator('#idShipByDate')`):
 * the field id was inferred from the recording's own calendar-BUTTON ids
 * (idShipByDate_SelectBtn / idEstArrivalDate_SelectBtn) by stripping the
 * suffix — flagged at the time as "not confirmed directly." It was wrong.
 * With explicit user permission, drove a real Playwright session to
 * Create Shipment (against production, BN 398511 — a real pin already
 * mid-flow from an earlier failed attempt, nothing yet submitted) and
 * inspected the actual DOM: `idShipByDate` bare does not exist at all.
 * MXI renders this as a composite date/time WIDGET, several real inputs
 * sharing the base id as a prefix — confirmed live:
 *   idShipByDate_$DATE$          (text, "dd-MMM-yyyy" placeholder — this one)
 *   idShipByDate_$TIME$          (text, "HH:mm" placeholder)
 *   idShipByDate_$TIMEZONE_DISPLAY$ (text, read-only display, "UTC")
 *   idShipByDate_$TIMEZONE$      (hidden, "Etc/UTC")
 *   idShipByDate_$DEFAULT_TIME_TO_END_OF_DAY$ (hidden, "true")
 * — and the same shape for `idEstArrivalDate_$DATE$`. `fieldId` is now
 * the confirmed real DATE subfield id including the literal `$...$`
 * suffix, addressed via an attribute selector rather than `#id` so the
 * `$` characters never need CSS-escaping. The TIME/TIMEZONE subfields are
 * left untouched — `_$DEFAULT_TIME_TO_END_OF_DAY$` being "true" suggests
 * MXI fills a real time itself when only the date is set; not confirmed
 * beyond that, since no recording or prior code ever exercised this
 * widget's time portion.
 */
async function fillMxiDateField(page: Page, fieldId: string, date: Date): Promise<void> {
  const value = toMxiDateString(date);
  const field = page.locator(`[id="${fieldId}_$DATE$"]`);
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
 * Create Shipment for the wrong-base transfer, with the business rules
 * confirmed directly by the user (2026-09-10) replacing what a single
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
 * Then checks the shipment line and clicks Move to Dock, same as both
 * recordings below.
 *
 * REAL BUG FOUND (2026-09-12, live failure): getting to Create Shipment
 * used to be a single step — a "BN ..." link click, from
 * discovery-pins-wrong-base-recording.ts. That timed out live
 * (`getByRole('link', { name: /^BN / })` never found).
 *
 * A short-lived fix tried that path AND a second one as a fallback. Per
 * explicit user correction, that's wrong: discovery-pins-start-recording.ts
 * "uses the correct HTML, just some of my inputs weren't correct" — i.e.
 * the ORIGINAL "BN ..." link recording is the one that doesn't reflect the
 * real page, not just an alternate path worth keeping as a fallback. Now
 * uses ONLY discovery-pins-start-recording.ts's own continuation — the
 * same verified-real session openPinByBn's entry logic already comes
 * from: a "Component: PIN ... (PN..." cell containing its own link, then
 * "Details", then "Create Shipment".
 *
 * REAL BUG FOUND AND FIXED (2026-09-12, live failure — "Filled Ship To
 * with 'CAK/DOCK' but no matching autocomplete suggestion appeared"):
 * this code filled the WHOLE target string ("CAK/DOCK") into the Ship To
 * field before searching for a suggestion. discovery-pins-wrong-base-
 * recording.ts's own real, successful sequence typed only the bare
 * station code:
 *   await page.locator('#idFieldShipTo').fill('DAY');
 *   await page.getByText('DAY/DOCK').click();
 * — not 'DAY/DOCK'. The autocomplete is evidently keyed/searched on the
 * station code alone; searching the full "<base>/DOCK" string apparently
 * matches nothing, which is exactly the reported symptom. Fixed to fill
 * only `destinationBase` and then look for the "<destinationBase>/DOCK"
 * suggestion, matching the recording exactly. (That same recording also
 * shows an earlier click into '#idFieldShipToLink', opening a separate
 * "Select Location" popup and typing into its own '#idEditFind' — but the
 * recording then abandons that popup with no selection ever made in it
 * and falls through to the direct-fill-and-click-suggestion sequence
 * above, the same "abandoned exploratory attempt before the real working
 * sequence" shape already seen in other recordings in this project. Not
 * used here for that reason.)
 */
const REACH_CREATE_SHIPMENT_TIMEOUT_MS = 15_000;

export async function runPinWrongBaseShipmentFlow(page: Page, destinationBase: PinBackShop): Promise<PinShipmentFlowResult> {
  const componentLink = page.getByRole('cell', { name: /^Component:/i }).getByRole('link');
  try {
    await componentLink.first().waitFor({ state: 'visible', timeout: REACH_CREATE_SHIPMENT_TIMEOUT_MS });
  } catch {
    return {
      status: 'failed',
      shipTo: null,
      errorMessage: 'Could not reach Create Shipment: no "Component: ..." cell with a link was found on the page.',
    };
  }
  await componentLink.first().click();
  await pace(page);
  await page.getByRole('link', { name: 'Details' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Create Shipment' }).click();
  await pace(page);

  // Filled directly, no autocomplete-suggestion confirmation step — per
  // explicit user direction (2026-09-12), after the suggestion never
  // reliably appeared even once the field held the right value: "There's
  // no need to look for an autocomplete confirmation, just assume the
  // string is correct."
  const shipTo = `${destinationBase}/DOCK`;
  const shipToField = page.locator('#idFieldShipTo');
  await shipToField.click();
  await shipToField.fill(shipTo);
  await pace(page);

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  await fillMxiDateField(page, 'idShipByDate', today);
  await fillMxiDateField(page, 'idEstArrivalDate', tomorrow);

  // REAL BUG FOUND AND FIXED (2026-09-12, live failure — locator.selectOption
  // timed out 30s on #idDropdownReason, "did not find some options"): the
  // real option's label is "REPAIR (Repair Return)", not bare "REPAIR" —
  // selectOption({label}) requires an exact match. Confirmed live by
  // reading every real <option> on this exact dropdown. writeVendorScrap.ts
  // already uses this same full-literal-label convention for this same
  // #idDropdownReason control (INSPECT_UNSERVICEABLE_REASON_LABEL =
  // 'SCRAP (Scrapped)', SCRAP_INVENTORY_REASON_LABEL = 'SCRPV (Vendor
  // Scrapped)') — this just hadn't been matched to it.
  await page.locator('#idDropdownReason').selectOption({ label: 'REPAIR (Repair Return)' });
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

export interface PinsRoutingRunResult {
  bn: string;
  currentLocation: string;
  base: string | null;
  /** 'unknown' only when a real exception was thrown before the base was even resolved (see pinsRoutingRunner.ts's own catch) — never fabricated. */
  path: 'correct_base' | 'wrong_base' | 'unknown';
  status: 'success' | 'failed' | 'tied' | 'destination_not_found';
  /** Set only on the correct-base path. */
  locationUsed: string | null;
  /** Set only on the wrong-base path. */
  destination: PinBackShop | null;
  totals: Record<PinBackShop, number> | null;
  errorMessage: string | null;
}

/**
 * The full per-BN pins routing decision and write, extracted from
 * cli/pinsRoutingCli.ts (2026-09-11) so the CLI and the new
 * api/jobRunners/pinsRoutingRunner.ts (the Back Shop "Run Pins process"
 * button) share one implementation rather than two copies that could
 * silently drift. Writes the same `write_up_actions` audit row(s) the CLI
 * always has — callers don't need to duplicate that.
 *
 * Same two flows as the CLI: correct-base (pin already at CAK/DAY/GSP/ORF)
 * runs live end-to-end; wrong-base reads the Availability tab, computes
 * the lowest-total destination, confirms it there, and runs Create
 * Shipment. See runPinCorrectBaseFlow/runPinWrongBaseShipmentFlow's own
 * docblocks for what's still unverified against real MXI.
 */
export async function runPinsRoutingForBn(
  client: MxiClient,
  db: Database.Database,
  env: MxiEnv,
  bn: string,
): Promise<PinsRoutingRunResult> {
  const page = await client.getAuthenticatedPage();
  const { currentLocation, base, isBackShop } = await openPinByBn(page, client.todoListUrl, bn);

  if (isBackShop && isPinBackShop(base)) {
    const result = await runPinCorrectBaseFlow(page, base);
    insertWriteUpAction(db, {
      // Pins aren't vendor-coded — 'PINS' is a free-text marker for this
      // column, same append-only table every other write-up flow logs to.
      vendor: 'PINS',
      partNumber: PIN_PART_NUMBER,
      targetEnv: env,
      outcome: result.status === 'success' ? 'filled' : 'error',
      stationCode: base,
      routedLocation: result.locationUsed,
      filledFieldsJson: JSON.stringify({ bn, result }),
      errorMessage: result.errorMessage,
      orderNumber: null,
    });
    return {
      bn,
      currentLocation,
      base,
      path: 'correct_base',
      status: result.status,
      locationUsed: result.locationUsed,
      destination: null,
      totals: null,
      errorMessage: result.errorMessage,
    };
  }

  log.warn(
    { bn, currentLocation },
    '[pins-routing] pin is not at CAK/DAY/GSP/ORF — reading the part availability table to compute the transfer destination',
  );
  await navigateToPinAvailabilityTab(page, client.todoListUrl);
  const rows = await readPinAvailabilityTable(page);
  const resolved = resolvePinDestination(rows);

  if (resolved.tied || !resolved.destination) {
    const errorMessage = 'Two or more back shops tied for the lowest total — not guessing a destination.';
    insertWriteUpAction(db, {
      vendor: 'PINS',
      partNumber: PIN_PART_NUMBER,
      targetEnv: env,
      outcome: 'pending_manual',
      stationCode: base,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved }),
      errorMessage,
      orderNumber: null,
    });
    return { bn, currentLocation, base, path: 'wrong_base', status: 'tied', locationUsed: null, destination: null, totals: resolved.totals, errorMessage };
  }

  const destinationRow = rows.find((r) => r.base === resolved.destination);
  if (!destinationRow || !destinationRow.rowLabelText) {
    const errorMessage = `Computed destination ${resolved.destination}, but its row was never found/read on the Availability tab — cannot confirm the selection there.`;
    insertWriteUpAction(db, {
      vendor: 'PINS',
      partNumber: PIN_PART_NUMBER,
      targetEnv: env,
      outcome: 'pending_manual',
      stationCode: base,
      routedLocation: resolved.destination,
      filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved }),
      errorMessage,
      orderNumber: null,
    });
    return {
      bn,
      currentLocation,
      base,
      path: 'wrong_base',
      status: 'destination_not_found',
      locationUsed: null,
      destination: resolved.destination,
      totals: resolved.totals,
      errorMessage,
    };
  }

  log.info({ bn, totals: resolved.totals, destination: resolved.destination }, '[pins-routing] confirming destination on the Availability tab');
  await confirmPinAvailabilitySelection(page, destinationRow.rowLabelText);

  // The Availability tab was reached via an independent Part Search
  // (navigateToPinAvailabilityTab's own docblock) — re-opening this BN's
  // own line explicitly rather than assuming that navigation returns to
  // it, matching this project's established "never assume page state
  // carried across a detour" discipline.
  await openPinByBn(page, client.todoListUrl, bn);
  const shipmentResult = await runPinWrongBaseShipmentFlow(page, resolved.destination);

  insertWriteUpAction(db, {
    vendor: 'PINS',
    partNumber: PIN_PART_NUMBER,
    targetEnv: env,
    outcome: shipmentResult.status === 'success' ? 'filled' : 'error',
    stationCode: base,
    routedLocation: shipmentResult.shipTo,
    filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved, shipmentResult }),
    errorMessage: shipmentResult.errorMessage,
    orderNumber: null,
  });

  return {
    bn,
    currentLocation,
    base,
    path: 'wrong_base',
    status: shipmentResult.status,
    locationUsed: null,
    destination: resolved.destination,
    totals: resolved.totals,
    errorMessage: shipmentResult.errorMessage,
  };
}
