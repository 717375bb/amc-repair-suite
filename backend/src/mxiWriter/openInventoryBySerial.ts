import type { Page } from 'playwright';
import { clickIfPresent, pace } from './scrapFlowHelpers.js';
import { PART_DETAILS_URL_MARKER } from '../writeUps/shared/partOwnDetails.js';
import { parseSearchVerdict, type SearchVerdict } from './inventorySearchVerdict.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('scrap');

const DETAILS_NAV_TIMEOUT_MS = 30_000;
const SEARCH_VERDICT_TIMEOUT_MS = 20_000;
const TAB_CLICK_TIMEOUT_MS = 6_000;

/** PartDetails.jsp — the PART record, distinct from the inventory record. */
export const PART_RECORD_URL_MARKER = 'PartDetails.jsp';

/** The "Note" section header on the part's Details tab; proves the tab rendered. */
const PART_NOTE_SECTION = '#idGrpReceivingNotes';

export type OpenInventoryStatus =
  | 'opened'
  /** MXI positively stated zero results for that serial. A real answer. */
  | 'not_found'
  /** The search never stated an outcome at all. A fault, NOT an answer. */
  | 'search_not_rendered'
  /** MXI said there are results, but no row for this serial could be clicked. A fault. */
  | 'row_not_clickable'
  /** A hit was clicked but its details page never loaded. A fault, not an answer. */
  | 'details_not_reached';

export interface OpenInventoryResult {
  status: OpenInventoryStatus;
  /** Where the browser actually ended up, for a failure message that names it. */
  url: string;
  error: string | null;
}

/**
 * Searches inventory by serial and leaves the browser on the results page.
 *
 * Shared by both openers below so there is exactly one implementation of the
 * navigation and of the "did MXI actually answer" wait. Returns null when the
 * search succeeded; a failed OpenInventoryResult otherwise.
 */
async function runSerialSearch(
  page: Page,
  todoListUrl: string,
  serialNumber: string,
): Promise<OpenInventoryResult | null> {
  await page.goto(todoListUrl);
  await pace(page);

  // --- Inventory Search by serial ---
  await page.locator('#idMenuButton').click();
  await pace(page);
  // REAL BUG CAUGHT IN PRE-FLIGHT (2026-08-23): a bare
  // /Unserviceable Staging Clerk/i matches TWO menu entries — the clerk
  // role itself AND "Unserviceable Staging Clerk Reports" — which
  // Playwright's strict mode rejects outright. Anchored so only the role
  // menu matches: the accessible name normalises to
  // "Unserviceable Staging Clerk >", while the Reports entry has a word
  // between the name and the chevron.
  await page.getByRole('link', { name: /^Unserviceable Staging Clerk\s*>/i }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Inventory Search' }).click();
  await pace(page);

  await page.locator('input[name="aSerialNo_SERIAL"]').fill(serialNumber);
  await page.getByRole('link', { name: 'Search' }).click();

  // REAL BUG FOUND AND FIXED (2026-08-27): this used to pace() and then
  // count matching links, so a results page that had not rendered yet
  // became a confident "No inventory item found for serial X". A discovery
  // run over 32 real parts produced that for four serials that had opened
  // fine five minutes earlier in the same session; re-searching one of them
  // directly showed MXI answering "1 inventory item was found."
  //
  // Now it waits for MXI to actually STATE an outcome (see
  // inventorySearchVerdict.ts for the two real phrasings), so a "not found"
  // can only ever come from the page positively saying zero. Anything else
  // is reported as the fault it is rather than as an answer about the part.
  let verdict: SearchVerdict | null = null;
  try {
    await page.waitForFunction(
      () => {
        if (document.readyState !== 'complete') return false;
        // Inlined deliberately: a named helper declared in this scope is
        // rewritten by tsx/esbuild's keepNames into a __name(...) call that
        // does not exist inside page.evaluate. That has bitten this repo
        // twice — see createWorkPackage.ts and readRemovalDate.ts.
        return /(\d+)(?:\s+of\s+(\d+))?\s+inventory\s+items?\s+(?:was|were)\s+found/i.test(
          document.body?.innerText ?? '',
        );
      },
      undefined,
      { timeout: SEARCH_VERDICT_TIMEOUT_MS, polling: 250 },
    );
    verdict = parseSearchVerdict(await page.locator('body').innerText());
  } catch {
    /* reported below as a fault, with the page we were left looking at */
  }

  if (!verdict) {
    log.warn({ serialNumber, url: page.url() }, '[inventory] search never stated a result count');
    return {
      status: 'search_not_rendered',
      url: page.url(),
      error:
        `The inventory search for serial "${serialNumber}" never reported a result count ` +
        `after ${SEARCH_VERDICT_TIMEOUT_MS / 1000}s, so whether this part exists is unknown.`,
    };
  }

  if (verdict.shown === 0) {
    return {
      status: 'not_found',
      url: page.url(),
      error: `No inventory item found for serial "${serialNumber}".`,
    };
  }

  return null;
}

/**
 * Finds one part by serial and leaves the browser on its INVENTORY Details
 * page — the specific physical item, where its current location lives.
 *
 * EXTRACTED (2026-08-27) from writeInHouseScrap so the back-shop discovery
 * pass can reach a part exactly the way the scrap itself does. Moved
 * verbatim, comments included — the two must not drift, because a
 * discovery pass that opened a different record than the write would
 * recommend scrapping one part and scrap another.
 */
export async function openInventoryBySerial(
  page: Page,
  todoListUrl: string,
  serialNumber: string,
): Promise<OpenInventoryResult> {
  const searchFailure = await runSerialSearch(page, todoListUrl, serialNumber);
  if (searchFailure) return searchFailure;

  const hit = page.getByRole('link', { name: serialNumber, exact: true });
  if ((await hit.count()) === 0) {
    log.warn({ serialNumber, url: page.url() }, '[inventory] results reported but no row matched this serial exactly');
    return {
      status: 'row_not_clickable',
      url: page.url(),
      error: `The search for serial "${serialNumber}" reported results, but no row carried that serial exactly.`,
    };
  }
  await hit.first().click();

  // Confirm the details page genuinely loaded before anything is read off
  // it. A serial link click that has not navigated leaves the SEARCH RESULTS
  // page showing — which also contains the serial, so a text-based wait
  // passes on the wrong page. That exact confusion produced a real bug on
  // 2026-08-25 ("could not read a base station"), and the fix was to check
  // the URL, the document being complete, AND this serial being present.
  try {
    await page.waitForFunction(
      ({ marker, sn }) =>
        window.location.href.includes(marker) &&
        document.readyState === 'complete' &&
        (document.body?.innerText ?? '').includes(sn),
      { marker: PART_DETAILS_URL_MARKER, sn: serialNumber },
      { timeout: DETAILS_NAV_TIMEOUT_MS, polling: 250 },
    );
  } catch {
    log.warn({ serialNumber, url: page.url() }, '[inventory] never reached the details page after clicking the serial');
    return {
      status: 'details_not_reached',
      url: page.url(),
      error:
        `Clicking serial ${serialNumber} never landed on its inventory details page ` +
        `(still on "${page.url()}" after ${DETAILS_NAV_TIMEOUT_MS / 1000}s).`,
    };
  }

  return { status: 'opened', url: page.url(), error: null };
}

/**
 * Finds a part by serial and leaves the browser on the PART record's Details
 * tab, where the human-written part note lives.
 *
 * A DIFFERENT RECORD from openInventoryBySerial, and the distinction is the
 * whole point. From the same search results row, clicking the SERIAL opens
 * the physical item (InventoryDetails.jsp); clicking the PART NUMBER opens
 * the part (PartDetails.jsp). A first back-shop discovery run read the
 * inventory record and found no scrap wording on ANY of 32 real parts — the
 * notes there are system-generated Merlin tags. The analyst's recording
 * (discovery-part-detail-scrap-recording.ts) showed the real path: click the
 * part number, then Details, where a note reads
 * "REPAIRS - HIGH SCRAP RATE. SEND TO DAY BACKSHOP MG 3.9.26".
 *
 * The note is therefore part-NUMBER level: every serial of a given part
 * number shares it.
 */
export async function openPartDetailsBySerial(
  page: Page,
  todoListUrl: string,
  serialNumber: string,
  partNumber: string,
): Promise<OpenInventoryResult> {
  const searchFailure = await runSerialSearch(page, todoListUrl, serialNumber);
  if (searchFailure) return searchFailure;

  const partLink = page.getByRole('link', { name: partNumber, exact: true });
  if ((await partLink.count()) === 0) {
    log.warn(
      { serialNumber, partNumber, url: page.url() },
      '[inventory] results reported but no row carried this part number exactly',
    );
    return {
      status: 'row_not_clickable',
      url: page.url(),
      error:
        `The search for serial "${serialNumber}" reported results, but no row carried part number ` +
        `"${partNumber}" exactly, so the part record was not opened. (Does the sheet's part number ` +
        `match MXI's OEM Part No?)`,
    };
  }
  await partLink.first().click();
  await pace(page);

  // Per the recording. Harmless when Details is already the active tab, and
  // necessary when MXI has restored a different one — the same session-level
  // tab memory behind the 2026-08-25 "could not read a base station" bug.
  // clickIfPresent rather than click(): a missing tab must not throw here,
  // because the wait below reports the real state either way.
  await clickIfPresent(page, page.getByRole('link', { name: 'Details', exact: true }), TAB_CLICK_TIMEOUT_MS);

  // The Note SECTION's presence proves the Details tab content rendered.
  // Deliberately not the note cell itself: a part with no note still has the
  // section, so waiting on the section separates "the tab did not render" (a
  // fault) from "this part has no note" (a real answer).
  try {
    await page.waitForFunction(
      ({ marker, section }) =>
        window.location.href.includes(marker) &&
        document.readyState === 'complete' &&
        document.querySelector(section) !== null,
      { marker: PART_RECORD_URL_MARKER, section: PART_NOTE_SECTION },
      { timeout: DETAILS_NAV_TIMEOUT_MS, polling: 250 },
    );
  } catch {
    log.warn({ serialNumber, partNumber, url: page.url() }, '[inventory] never reached the part record details tab');
    return {
      status: 'details_not_reached',
      url: page.url(),
      error:
        `Opening part ${partNumber} (via serial ${serialNumber}) never reached its part details tab ` +
        `(still on "${page.url()}" after ${DETAILS_NAV_TIMEOUT_MS / 1000}s), so its note was not read.`,
    };
  }

  return { status: 'opened', url: page.url(), error: null };
}
