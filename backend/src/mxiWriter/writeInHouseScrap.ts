import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import { clickIfPresent, enterPasswordIfPrompted, pace, repairLocationCandidates } from './scrapFlowHelpers.js';
import { openInventoryBySerial } from './openInventoryBySerial.js';
import { evaluateBaseStation } from '../writeUps/shared/approvedLocations.js';
import {
  looksLikeDetailsTab,
  parseCurrentLocation,
  pickWorkPackageNameFieldIndex,
  toScrapWorkPackageName,
} from './inHouseScrapParsing.js';
import { createLogger } from '../logging/logger.js';

/**
 * Closes a location-picker popup, best-effort.
 *
 * REAL LEAK FOUND AND FIXED (2026-08-25): neither the schedule popup nor
 * the transfer popup was EVER closed. Both were opened via
 * `page.waitForEvent('popup')`, used, and abandoned — so a multi-serial
 * run accumulated two orphaned MXI pages per part, each one still holding
 * whatever server-side transaction state MXI attaches to a picker.
 *
 * Reported symptom this is part of: running several serials scraps the
 * FIRST successfully and fails every one after it, and the same serial
 * succeeds when it is first in the list. That is state carried between
 * iterations rather than anything wrong with the parts.
 *
 * Never throws — a popup that has already closed itself is the normal
 * case, and a cleanup failure must not fail a scrap that otherwise
 * succeeded.
 */
async function closePopupQuietly(popup: Page | undefined): Promise<void> {
  if (!popup || popup.isClosed()) return;
  try {
    await popup.close();
  } catch {
    /* already gone, or closing raced with navigation — nothing to do */
  }
}

const log = createLogger('scrap');

/**
 * Real URL markers for the inventory-details tabs this flow needs,
 * captured from production by `npm run diag:inhouse-scrap -- L903140`:
 *   after "Open"               -> .../InventoryDetails.jsp?...&aTab=Open
 *   after "Open Work Packages" -> ...&aTab=Open.OpenChecks
 * Note the first is a prefix of the second, which is fine — reaching the
 * checks view necessarily means the Open tab was reached too.
 */
const OPEN_TAB_URL_MARKER = 'aTab=Open';
const OPEN_CHECKS_URL_MARKER = 'aTab=Open.OpenChecks';
/**
 * Deliberately generous. clickIfPresent's own 6s default is far too short
 * for MXI under load — this suite has measured part-detail pages taking
 * ~19s to render (see partOwnDetails.ts). 30s matches the standard used
 * for every other genuine render wait in this project.
 */
const TAB_CLICK_TIMEOUT_MS = 30_000;
const TAB_NAV_TIMEOUT_MS = 20_000;
/**
 * For clicks that legitimately may not exist. Longer than the old 6s so a
 * slow render is not mistaken for absence, but not the full 30s — every
 * genuinely-absent one costs this much wall time, twice per part.
 */
const OPTIONAL_CLICK_TIMEOUT_MS = 15_000;

/**
 * Clicks a tab link and CONFIRMS the page actually moved to it, retrying
 * once. Returns whether the target tab was genuinely reached.
 *
 * Exists because the two callers below used to discard clickIfPresent's
 * return value entirely, so a click that never happened was
 * indistinguishable from one that did — and the next read then blamed the
 * part rather than the navigation.
 */
async function clickUntilUrlContains(
  page: Page,
  locator: ReturnType<Page['getByRole']>,
  marker: string,
  label: string,
  serialNumber: string,
): Promise<boolean> {
  if (page.url().includes(marker)) return true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const clicked = await clickIfPresent(page, locator, TAB_CLICK_TIMEOUT_MS);
    if (!clicked) {
      log.warn({ serialNumber, label, attempt, url: page.url() }, '[in-house scrap] tab link never became visible');
      continue;
    }
    try {
      await page.waitForURL((url) => url.href.includes(marker), { timeout: TAB_NAV_TIMEOUT_MS });
      return true;
    } catch {
      log.warn(
        { serialNumber, label, attempt, url: page.url(), expected: marker },
        '[in-house scrap] clicked the tab but the URL never reached it — retrying',
      );
    }
  }
  return page.url().includes(marker);
}

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
  // Tracked so a failure ANYWHERE below still closes them — several of the
  // early returns between here and the end used to abandon an open popup.
  let schedulePopup: Page | undefined;
  let transferPopup: Page | undefined;

  try {
    page = await client.getAuthenticatedPage();

    // Start every serial from a clean browser context. `page.goto` below
    // resets the MAIN page, but it does nothing about extra pages left
    // open by a previous serial in the same batch — which, before the
    // popup fix in this file, was two per part and growing. This is the
    // reset the reported symptom asked for: "there's simply an issue with
    // it moving into the next part."
    //
    // Only the client's own page is kept; anything else is a leftover.
    for (const other of page.context().pages()) {
      if (other !== page) await closePopupQuietly(other);
    }

    // Search for the serial and open its inventory details page.
    //
    // EXTRACTED (2026-08-27) into openInventoryBySerial so the back-shop
    // discovery pass reaches a part through the EXACT same navigation this
    // write does. Two implementations would be free to drift, and a
    // discovery pass that opened a different record than the write would
    // recommend scrapping one part and then scrap another. Every comment
    // explaining why each step looks the way it does moved with the code.
    const opened = await openInventoryBySerial(page, client.todoListUrl, serialNumber);
    if (opened.status === 'not_found') {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage: `No inventory item found for serial "${serialNumber}". Nothing was changed.`,
      };
    }
    stepsTaken.push(`found inventory for serial ${serialNumber}`);

    // Every other non-'opened' status is a FAULT rather than an answer about
    // the part (search never rendered, results stated but no clickable row,
    // details page never loaded). Handled as one branch on purpose: a new
    // status added to openInventoryBySerial must never fall through here and
    // be treated as a successfully opened part.
    if (opened.status !== 'opened') {
      log.warn(
        { serialNumber, status: opened.status, landedOn: opened.url, stepsTaken },
        '[in-house scrap] could not open the inventory details page for this serial',
      );
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage: `${opened.error} Its location was never actually looked for, so nothing was changed.`,
      };
    }

    // ROOT CAUSE FOUND AND FIXED (2026-08-25, second report of the same
    // error): MXI remembers the ACTIVE TAB for the session. This very flow
    // ends up on `aTab=Open.OpenChecks` while reading an item's work
    // packages, so the next time an item is opened MXI restores that tab —
    // and the Details content, the only place the location is stated, is
    // never rendered at all.
    //
    // Proven from a real production capture of this exact serial
    // (data/diagnostics/inhouse-scrap-L903140-*.txt, taken on
    // aTab=Open.OpenChecks): no `Location:` label, and no station-shaped
    // token anywhere on the page. The flow read that page, found no
    // location, and blamed the part.
    //
    // This is also the real explanation for the earlier "first serial
    // succeeds, every one after it fails" report — the first serial left
    // the session sitting on the Open tab.
    let bodyText = await page.locator('body').innerText();
    if (!looksLikeDetailsTab(bodyText)) {
      log.info(
        { serialNumber, url: page.url() },
        '[in-house scrap] details tab not active (MXI restored a previous tab) — selecting it explicitly',
      );
      await clickIfPresent(page, page.getByRole('link', { name: 'Details', exact: true }), TAB_CLICK_TIMEOUT_MS);
      try {
        // Wait for the location LABEL itself, not for a fixed delay — the
        // content-aware discipline used everywhere else in this suite.
        await page.waitForFunction(
          () => /Location:\s*[A-Za-z]{3}\/[A-Za-z0-9]+/.test(document.body?.innerText ?? ''),
          undefined,
          { timeout: TAB_NAV_TIMEOUT_MS, polling: 250 },
        );
      } catch {
        /* reported below, with the real page state */
      }
      bodyText = await page.locator('body').innerText();
    }

    const currentLocation = parseCurrentLocation(bodyText);
    const candidates = repairLocationCandidates(currentLocation);
    if (candidates.length === 0) {
      log.warn(
        { serialNumber, url: page.url(), onDetailsTab: looksLikeDetailsTab(bodyText) },
        '[in-house scrap] no base station readable even after selecting the Details tab',
      );
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Could not read a base station from this item's current location ("${currentLocation || 'not found'}") ` +
          `on its own details page (url "${page.url()}"). Nothing was changed.`,
      };
    }
    log.info({ serialNumber, currentLocation, candidates }, 'derived in-house scrap location candidates');

    // APPROVED-BASE GATE (2026-08-27, explicit user direction: "In-house
    // scrap should consult the approved locations list").
    //
    // The daily back-shop listing genuinely contains parts at bases PSA
    // does not operate out of — GNV/USSTG appears on the live sheet — and
    // scrapping is irreversible, so this refuses rather than improvising a
    // shop at a site we have no business creating work at.
    //
    // A GATE only: the shop this part is sent to is still derived from its
    // OWN base, exactly as before. approvedLocations.ts also knows that
    // NQA/QRO/CKB/TUS are handled out of CLT for ORDER CREATION, but
    // applying that here would redirect real parts to a different physical
    // shop than they go to today. That is a separate decision and is
    // deliberately not taken as a side effect of adding this check.
    const approval = evaluateBaseStation(currentLocation);
    if (!approval.approved) {
      log.info(
        { serialNumber, currentLocation, baseStation: approval.baseStation },
        '[in-house scrap] not an approved base — skipping, nothing changed',
      );
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `${approval.reason ?? `${currentLocation} is not an approved base.`} ` +
          `Serial ${serialNumber} was not scrapped and nothing was changed.`,
      };
    }

    // REAL BUG FOUND AND FIXED (2026-08-25). Reported as: the flow "says
    // there's no work package, even though there is".
    //
    // These two clicks used to be fire-and-forget. clickIfPresent waits
    // only 6s for the link to become VISIBLE and returns false if it does
    // not — and both return values were discarded. So on a slow page the
    // tab was never switched, the flow read the Details tab instead of the
    // Open Work Packages tab, found no `aCheck` there, and blamed the
    // part: "No open work package for serial X."
    //
    // 6s is far too short here. This same suite has already measured MXI
    // part-detail pages taking ~19s to render under load (see the
    // usage-table work in partOwnDetails.ts), which is exactly why a
    // read-only probe of this flow succeeded while the real batch failed —
    // the probe was fast enough to win the race every time.
    //
    // Now: click, then positively CONFIRM the tab actually changed, with a
    // retry. The URL markers are real, captured from production by
    // `npm run diag:inhouse-scrap` against serial L903140 —
    // ".../InventoryDetails.jsp?...&aTab=Open" after the first click and
    // "...&aTab=Open.OpenChecks" after the second.
    const onOpenTab = await clickUntilUrlContains(
      page,
      page.getByRole('link', { name: 'Open', exact: true }),
      OPEN_TAB_URL_MARKER,
      'Open tab',
      serialNumber,
    );
    const onOpenChecks = await clickUntilUrlContains(
      page,
      page.getByRole('link', { name: 'Open Work Packages' }),
      OPEN_CHECKS_URL_MARKER,
      'Open Work Packages tab',
      serialNumber,
    );

    if (!onOpenChecks) {
      // Never conflate "we could not get to the list" with "the list is
      // empty". The whole point of this fix.
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Could not open the Open Work Packages view for serial ${serialNumber} (reached Open tab: ${onOpenTab}; ` +
          `still on "${page.url()}"). Its work packages were never actually listed, so this says nothing about ` +
          `whether one exists. Nothing was changed.`,
      };
    }

    // A CLOSED page is its own distinct failure and must be reported as
    // one. Reported live (2026-08-25): "it's completely shutting down the
    // MXI page after clicking the Open Work Package role and saying
    // there's no work package". Those are two different things, and
    // everything below reads the page — on a closed page each of those
    // reads throws something opaque, which is how a shut-down browser ends
    // up disguised as "no work package".
    if (page.isClosed()) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `The MXI page closed while opening the work packages for serial ${serialNumber}. This is a browser/session ` +
          `failure, NOT a missing work package — nothing was read and nothing was changed.`,
      };
    }

    const checkBox = page.locator('input[name="aCheck"]');
    if ((await checkBox.count()) === 0) {
      // Evidence first — a disputed "no work package" verdict was
      // previously unfalsifiable after the fact. Best-effort throughout;
      // capture must never replace the real result.
      try {
        const seen = await page.evaluate(() => ({
          url: window.location.href,
          checkboxNames: Array.from(document.querySelectorAll('input[type="CHECKBOX" i]'))
            .map((i) => i.getAttribute('name') || '(no name)')
            .slice(0, 30),
          pnLinks: Array.from(document.querySelectorAll('a'))
            .map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim())
            .filter((t) => /\(PN:/i.test(t))
            .slice(0, 10),
          mentionsWorkPackage: (document.body?.innerText ?? '').includes('Work Package'),
        }));
        log.warn(
          { serialNumber, ...seen, pagesInContext: page.context().pages().length },
          '[in-house scrap] no aCheck checkbox found — recording what the page actually showed',
        );
      } catch (probeErr) {
        log.warn(
          { serialNumber, error: probeErr instanceof Error ? probeErr.message : String(probeErr) },
          '[in-house scrap] could not even read the page while reporting a missing work package',
        );
      }
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
    // Same tab-click class as the Open/Open Work Packages pair above, so
    // the same generous timeout: at 6s a slow render reads as "the tab
    // isn't there" and the click is skipped silently.
    await clickIfPresent(page, page.getByRole('link', { name: 'Details' }), TAB_CLICK_TIMEOUT_MS);
    await page.getByRole('link', { name: 'Edit Work Package' }).click();
    await pace(page);

    // REAL BUG FOUND AND FIXED (2026-08-25): the rename silently did not
    // happen, while the flow still reported that it had.
    //
    // It targeted `#idInput10` — a generated, positional id copied from the
    // discovery recording — as `if (count > 0) { fill }`. When that id did
    // not match, the fill was skipped, OK was clicked anyway, and
    // `renamed work package to "Scrap ..."` went into stepsTaken
    // regardless. The scrap completed with the package still called
    // "Repair ...", which is exactly what was reported: "It all worked,
    // only thing it didn't do was change the name."
    //
    // Now the field is identified by its CONTENT (it is the input already
    // holding the package's current name), which survives id changes, and
    // every stage is verified: the field must be found, the typed value
    // must read back, and the committed page must actually show the new
    // name. A rename that cannot be confirmed FAILS rather than being
    // reported as done.
    const newWorkPackageName = toScrapWorkPackageName(wpText);

    const textInputs = page.locator('input[type="text" i], input:not([type])');
    const inputCount = await textInputs.count();
    const values: string[] = [];
    for (let i = 0; i < inputCount; i++) {
      values.push(await textInputs.nth(i).inputValue().catch(() => ''));
    }
    // `#idInput10` stays the first choice — it IS right when it matches,
    // and it came from the real recording — but it is no longer trusted
    // blindly.
    const byRecordedId = page.locator('#idInput10');
    const recordedIdValue =
      (await byRecordedId.count()) > 0 ? await byRecordedId.first().inputValue().catch(() => null) : null;
    const useRecordedId =
      recordedIdValue !== null &&
      pickWorkPackageNameFieldIndex([recordedIdValue], wpText) === 0;

    const fieldIndex = useRecordedId ? -1 : pickWorkPackageNameFieldIndex(values, wpText);
    const nameField = useRecordedId ? byRecordedId.first() : fieldIndex >= 0 ? textInputs.nth(fieldIndex) : null;

    if (!nameField) {
      log.warn(
        { serialNumber, url: page.url(), inputCount, values: values.slice(0, 20), currentName: wpText },
        '[in-house scrap] could not identify the work package name field',
      );
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Could not find the work package name field on the Edit Work Package page for serial ${serialNumber} ` +
          `(url "${page.url()}", ${inputCount} text input(s) present). The rename was NOT made and nothing else ` +
          `was changed.`,
      };
    }

    // .fill() replaces the whole value in one DOM-level set. The recording
    // pressed ArrowLeft eleven times first, which is what a human does to
    // clear a field; this project already established (see selectors.ts's
    // updateEsdField) that .fill() is both correct and safer here.
    await nameField.fill(newWorkPackageName);
    await pace(page);

    const typedBack = await nameField.inputValue();
    if (typedBack.replace(/\s+/g, ' ').trim() !== newWorkPackageName.replace(/\s+/g, ' ').trim()) {
      // Do NOT click OK on a field that did not take the value — that
      // would commit the old name and report a rename that never happened.
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Typed the new work package name for serial ${serialNumber} but the field read back as "${typedBack}" ` +
          `instead of "${newWorkPackageName}". Nothing was submitted and nothing was changed.`,
      };
    }

    await page.getByRole('link', { name: 'OK' }).click();
    await pace(page);

    // Independent confirmation that the rename actually committed — the
    // same discipline writeEsdAndNotes uses. A click is not evidence.
    let renameConfirmed = false;
    try {
      await page.waitForFunction(
        (expected) => (document.body?.innerText ?? '').replace(/\s+/g, ' ').includes(expected),
        newWorkPackageName.replace(/\s+/g, ' ').trim(),
        { timeout: TAB_NAV_TIMEOUT_MS, polling: 250 },
      );
      renameConfirmed = true;
    } catch {
      /* reported below */
    }

    if (!renameConfirmed) {
      return {
        status: 'failed',
        stepsTaken,
        locationUsed,
        partDescription,
        errorMessage:
          `Submitted the rename to "${newWorkPackageName}" for serial ${serialNumber}, but the page never showed ` +
          `that name afterwards (url "${page.url()}"). The work package may still be named "${wpText}" — check it ` +
          `by hand before scheduling or transferring this part.`,
      };
    }

    stepsTaken.push(`renamed work package to "${newWorkPackageName}"`);

    // --- Schedule to the repair shop ---
    await page.getByRole('link', { name: 'Schedule Work Package' }).click();
    await pace(page);

    const schedulePopupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Select Repair Location' }).click();
    schedulePopup = await schedulePopupPromise;
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
    transferPopup = await transferPopupPromise;
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

    // These two are genuinely conditional — the recording shows the second
    // OK does not always appear — so they stay optional. But WHICH of them
    // fired is now recorded rather than discarded: if a required OK is
    // ever skipped because the page was slow rather than because it was
    // absent, the transfer is incomplete, and the audit trail has to show
    // that instead of a clean "success". Same reasoning as the tab clicks
    // above, applied where the click legitimately may not exist.
    const firstOk = await clickIfPresent(page, page.getByRole('link', { name: 'OK' }), OPTIONAL_CLICK_TIMEOUT_MS);
    const secondOk = await clickIfPresent(page, page.getByRole('link', { name: 'OK' }), OPTIONAL_CLICK_TIMEOUT_MS);
    stepsTaken.push(`transfer confirmations clicked: ${[firstOk && 'OK#1', secondOk && 'OK#2'].filter(Boolean).join(', ') || 'none'}`);
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
  } finally {
    // Runs on EVERY exit — success, early return, or throw — so the next
    // serial in a batch starts from a clean context instead of inheriting
    // this one's open pickers.
    await closePopupQuietly(schedulePopup);
    await closePopupQuietly(transferPopup);
  }
}
