import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { clickIfPresent, enterPasswordIfPrompted, pace, repairLocationCandidates } from './scrapFlowHelpers.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('scrap');

/** Description written into the scheduled work package, per the recording. */
export const INHOUSE_SCHEDULE_DESCRIPTION = 'scrap as NREP';

export interface InHouseScrapResult {
  status: 'success' | 'failed';
  stepsTaken: string[];
  /** The location actually picked, so a wrong site choice is visible after the fact. */
  locationUsed: string | null;
  /** Description read off the real work package, used to build the rename. */
  partDescription: string | null;
  errorMessage: string | null;
}

/**
 * Picks a repair/shop location out of MXI's own location picker popup.
 *
 * Tries the candidates from repairLocationCandidates() in preference order
 * and clicks whichever genuinely exists. Deliberately does NOT fall back to
 * "any location containing REPAIR": transferring a real part to the wrong
 * shop is worse than failing visibly, and the user's rule (BASE/REPAIR1/
 * SHOP1, sometimes BASE/REPAIR, DAY is BASE/REPAIR2/SHOP2) is specific
 * enough that anything outside it deserves a human.
 */
async function pickLocationInPopup(popup: Page, candidates: string[]): Promise<string | null> {
  // TWO REAL BUGS FIXED HERE, both found on the first live run (2026-08-23,
  // serial D5300-120 at PNS):
  //
  // 1. MXI's own location casing is INCONSISTENT between sites. The real
  //    list contains both "DFW/REPAIR1/SHOP1" (what the recording used) and
  //    "PNS/Repair1/Shop1", "CAK/Repair1/Shop1", "CLT/Repair1/Shop1". An
  //    exact, case-sensitive match therefore silently failed at every
  //    mixed-case site. Matching is now case-insensitive, and the cell is
  //    clicked using the text MXI actually renders.
  //
  // 2. The recording types "repair" into the find box first. Doing that
  //    here filtered the list to ZERO rows — so nothing could ever match.
  //    The filter is no longer used; the full list is read directly, which
  //    is also fewer moving parts.
  const readAvailable = async (): Promise<string[]> => {
    const cellTexts = await popup.locator('td').allInnerTexts();
    return [
      ...new Set(
        cellTexts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.includes('/') && t.length < 60),
      ),
    ];
  };

  const tryMatch = async (available: string[]): Promise<string | null> => {
    for (const candidate of candidates) {
      const match = available.find((a) => a.toUpperCase() === candidate.toUpperCase());
      if (match) {
        await popup.getByRole('cell', { name: match, exact: true }).first().click();
        return match;
      }
    }
    return null;
  };

  // Unfiltered first. The SCHEDULE popup already lists every repair
  // location, and filtering it returns zero rows.
  let picked = await tryMatch(await readAvailable());
  if (picked) return picked;

  // The TRANSFER popup is genuinely different: it opens on local/store
  // locations ("PNS/STORE/017", ...) and the repair shops only appear once
  // a search is run — which is exactly why the recording types into the
  // find box there. Confirmed live on serial D5300-120, where the schedule
  // popup listed the shops directly but the transfer popup did not.
  const findBox = popup.locator('#idEditFind');
  if ((await findBox.count()) === 0) {
    log.warn({ candidates }, '[in-house scrap] no expected repair location present, and no find box to search with');
    return null;
  }

  const base = (candidates[0]?.split('/')[0] ?? '').trim();
  for (const term of ['repair', base].filter(Boolean)) {
    await findBox.first().fill(term);
    await findBox.first().press('Enter');
    await popup.waitForTimeout(1800);
    picked = await tryMatch(await readAvailable());
    if (picked) return picked;
  }

  log.warn(
    { candidates, availableAfterSearch: await readAvailable() },
    '[in-house scrap] no expected repair location present in the picker, even after searching',
  );
  return null;
}

/**
 * The in-house scrap flow, from `discovery-inhouse-scrap-recording.ts`.
 *
 * Finds the item by serial through Unserviceable Staging Clerk > Inventory
 * Search, renames its open work package to a Scrap description, schedules
 * it to the site's repair shop, and creates a transfer to that same
 * location.
 *
 * Unlike the vendor path there is no certificate — an in-house scrap is
 * PSA's own decision, so the serial number is the only input.
 */
export async function writeInHouseScrap(
  client: MxiClient,
  serialNumber: string,
  password: string,
): Promise<InHouseScrapResult> {
  const stepsTaken: string[] = [];
  let locationUsed: string | null = null;
  let partDescription: string | null = null;
  let page: Page | undefined;

  try {
    page = await client.getAuthenticatedPage();
    await page.goto(client.todoListUrl);
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
    await pace(page);

    const hit = page.getByRole('link', { name: serialNumber, exact: true });
    if ((await hit.count()) === 0) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage: `No inventory item found for serial "${serialNumber}". Nothing was changed.`,
      };
    }
    await hit.first().click();
    stepsTaken.push(`found inventory for serial ${serialNumber}`);

    // REAL BUG FIXED (2026-08-23, first live run): this read the page after
    // a flat 750ms pace() and got nothing, failing with "could not read a
    // base station" — while a read-only pre-flight using a 2500ms wait read
    // "PNS/USSTG" from the same page without trouble. It was never a
    // parsing problem, just reading before the detail page had rendered.
    //
    // Waits for the location pattern itself to appear rather than guessing
    // a longer sleep — same content-aware-wait discipline as
    // waitForUnassignedTasksSectionResolved.
    try {
      await page.waitForFunction(
        () => /\b[A-Za-z]{3}\/[A-Za-z0-9]+/.test(document.body?.innerText ?? ''),
        undefined,
        { timeout: 20_000, polling: 250 },
      );
    } catch {
      // Fall through — the explicit "couldn't read a location" error below
      // is clearer than a raw timeout.
    }

    // Current location drives which repair shop this goes to.
    const bodyText = await page.locator('body').innerText();
    // Case-insensitive — MXI renders mixed-case locations at many sites
    // (PNS/Repair1/Shop1, CAK/, CLT/, GSP/, ORF/, SAV/). Only the base
    // station is used downstream, and repairLocationCandidates() uppercases
    // it, so a mixed-case read still resolves correctly.
    const locationMatch = bodyText.match(/\b([A-Za-z]{3})\/[A-Za-z0-9]+/);
    const currentLocation = locationMatch?.[0] ?? '';
    const candidates = repairLocationCandidates(currentLocation);
    if (candidates.length === 0) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Could not read a base station from this item's current location ("${currentLocation || 'not found'}"), ` +
          `so the repair shop to send it to is unknown. Nothing was changed.`,
      };
    }
    log.info({ serialNumber, currentLocation, candidates }, 'derived in-house scrap location candidates');

    await clickIfPresent(page, page.getByRole('link', { name: 'Open', exact: true }));
    await clickIfPresent(page, page.getByRole('link', { name: 'Open Work Packages' }));

    const checkBox = page.locator('input[name="aCheck"]');
    if ((await checkBox.count()) === 0) {
      // Per user direction a missing work package should be created. That
      // is a genuinely different flow (the existing Create Work Package
      // path) and has not been proven from this entry point, so it stops
      // here rather than improvising a destructive sequence.
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `No open work package for serial ${serialNumber}. One needs creating first — that path is not wired into ` +
          `this flow yet, so nothing was changed.`,
      };
    }
    await checkBox.first().check();
    await pace(page);

    // Matched by the "(PN: ...)" naming convention rather than a "Repair "
    // prefix. TWO reasons, both found live:
    //   - after this flow renames the package it starts with "Scrap", so a
    //     Repair-prefix match would fail on any retry;
    //   - "Scrap Inventory" is an ACTION link on this same page, so a
    //     Scrap-prefix match grabs that instead of the work package.
    // Every real package name seen carries "(PN: ..., SN: ...)".
    const wpLink = page.getByRole('link', { name: /\(PN:/i });
    if ((await wpLink.count()) === 0) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage: `No work package link (matched on "(PN:") found for serial ${serialNumber}. Nothing was changed.`,
      };
    }
    const wpText = (await wpLink.first().innerText()).replace(/\s+/g, ' ').trim();
    // Strips EITHER prefix so a re-run doesn't produce "Scrap Scrap ...".
    partDescription = wpText.replace(/^(Repair|Scrap)\s+/i, '').trim();
    await wpLink.first().click();
    await pace(page);

    // --- Rename the work package to a Scrap description ---
    await clickIfPresent(page, page.getByRole('link', { name: 'Details' }));
    await page.getByRole('link', { name: 'Edit Work Package' }).click();
    await pace(page);

    const nameField = page.locator('#idInput10');
    if ((await nameField.count()) > 0) {
      // .fill() replaces the whole value in one DOM-level set. The
      // recording pressed ArrowLeft eleven times first, which is what a
      // human does to clear a masked field; this project has already
      // established (see selectors.ts's updateEsdField) that .fill() is
      // both correct and safer than simulated keystrokes here.
      await nameField.first().fill(`Scrap ${partDescription}`);
      await pace(page);
    }
    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);
    stepsTaken.push(`renamed work package to "Scrap ${partDescription}"`);

    // --- Schedule to the repair shop ---
    await page.getByRole('link', { name: 'Schedule Work Package' }).click();
    await pace(page);

    const schedulePopupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Select Repair Location' }).click();
    const schedulePopup = await schedulePopupPromise;
    await schedulePopup.waitForLoadState('domcontentloaded');
    locationUsed = await pickLocationInPopup(schedulePopup, candidates);
    if (!locationUsed) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `None of the expected repair locations (${candidates.join(', ')}) exist in the picker for this site. ` +
          `Refusing to guess a different one — a wrong shop would transfer a real part to the wrong place.`,
      };
    }
    await pace(page);

    const descBox = page.locator('#idTextAreaDescription');
    if ((await descBox.count()) > 0) await descBox.first().fill(INHOUSE_SCHEDULE_DESCRIPTION);
    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: schedule work package');
    stepsTaken.push(`scheduled to ${locationUsed}`);

    // --- Create the transfer to the same location ---
    const itemLink = page.getByRole('link', { name: new RegExp(`\\(PN:`, 'i') });
    if ((await itemLink.count()) > 0) {
      await itemLink.first().click();
      await pace(page);
    }
    await page.getByRole('link', { name: 'Create Transfer' }).click();
    await pace(page);

    const transferPopupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Select Local Location' }).click();
    const transferPopup = await transferPopupPromise;
    await transferPopup.waitForLoadState('domcontentloaded');
    // Per explicit user direction: "The transfer location will always be
    // the same as the scheduled location." Pinned to exactly what was
    // scheduled rather than re-deriving, so the two can never disagree.
    const transferPicked = await pickLocationInPopup(transferPopup, [locationUsed]);
    if (!transferPicked) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Work package was scheduled to ${locationUsed}, but that location could not be selected for the transfer. ` +
          `The item is PARTIALLY processed — check it by hand.`,
      };
    }
    await pace(page);

    await clickIfPresent(page, page.getByRole('link', { name: 'OK' }));
    await clickIfPresent(page, page.getByRole('link', { name: 'OK' }));
    if (await enterPasswordIfPrompted(page, password)) stepsTaken.push('password: create transfer');
    stepsTaken.push(`created transfer to ${locationUsed}`);

    log.info({ serialNumber, locationUsed, stepsTaken }, 'in-house scrap completed');
    return { status: 'success', stepsTaken, locationUsed, partDescription, errorMessage: null };
  } catch (err) {
    return {
      status: 'failed',
      stepsTaken,
      locationUsed,
      partDescription,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
