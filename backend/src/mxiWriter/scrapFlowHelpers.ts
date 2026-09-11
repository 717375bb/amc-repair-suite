import type { Page } from 'playwright';
import { createLogger } from '../logging/logger.js';
import { looksLikeDetailsTab, parseCurrentLocation } from './inHouseScrapParsing.js';

const log = createLogger('scrap');

const CLICK_DELAY_MS = 750;
/** Shared by readCurrentLocationOnDetailsTab and clickUntilUrlContains below — both wait on a tab actually becoming active. */
const TAB_CLICK_TIMEOUT_MS = 30_000;
const TAB_NAV_TIMEOUT_MS = 20_000;

export async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Arms a `page.waitForEvent('popup')` wait SAFELY.
 *
 * REAL BUG FOUND AND FIXED (2026-09-12, live failure): the established
 * pattern in this codebase for "click something that opens a popup" is:
 *
 *   const popupPromise = page.waitForEvent('popup');
 *   await page.getByRole('link', { name: '...' }).click();
 *   const popup = await popupPromise;
 *
 * If the click itself is slow (its own actionability wait) and the popup
 * genuinely never opens, `popupPromise` can REJECT (Playwright's own 30s
 * default) before the code ever reaches `await popupPromise` — no handler
 * is attached to it yet at that moment. Node treats that as a genuinely
 * UNHANDLED promise rejection and crashes the entire process outright
 * (`triggerUncaughtException`), bypassing every try/catch anywhere else in
 * the codebase, including the pins batch runner's own per-BN try/catch —
 * this is exactly what turned one pin's ordinary, expected failure into
 * the whole batch stopping dead, confirmed live: runPinCorrectBaseFlow's
 * `Select Repair Location` popup wait crashed the runner mid-batch, and
 * the BN queued after it never even started.
 *
 * Fixed by attaching a no-op `.catch()` to the promise THE INSTANT it's
 * created — this satisfies Node's unhandled-rejection tracking immediately
 * (a promise only needs ONE handler attached before it settles, not before
 * every consumer awaits it), while the ORIGINAL promise returned here still
 * rejects normally for whoever awaits it afterward. Behavior for the
 * caller is unchanged either way; only the crash risk is removed.
 */
export function armPopupWait(page: Page): Promise<Page> {
  const popupPromise = page.waitForEvent('popup');
  popupPromise.catch(() => {
    /* handled here only to satisfy Node's unhandled-rejection check; the
       real rejection still reaches whoever awaits popupPromise itself */
  });
  return popupPromise;
}

/**
 * Clicks a control only if it's actually there, within a short bounded
 * wait.
 *
 * The scrap recordings are full of steps the user explicitly flagged as
 * intermittent ("lines 32, 38 and 54 will not ALWAYS appear. If they do,
 * click through as I did, if they don't, move on"). Waiting the Playwright
 * default 30s for an absent dialog and then throwing is precisely the bug
 * that produced the YES-timeout failures in the ESD/price writers, so
 * every optional step in these flows goes through here.
 *
 * Returns whether it actually clicked, so callers can record which
 * branches fired rather than guessing after the fact.
 */
export async function clickIfPresent(
  page: Page,
  locator: ReturnType<Page['getByRole']>,
  timeoutMs = 6000,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  // The click is bounded too, as of 2026-08-28. It used to run with
  // Playwright's 30s default even when the caller asked for a short
  // timeout, so an element that was visible but never became actionable
  // hung the whole flow for half a minute before throwing — which is
  // exactly what stalled a real vendor scrap on the receive step's OK
  // button (#idButtonOK: found, resolved, never clickable). A failed click
  // still throws; it is a real failure, not something to swallow.
  await locator.first().click({ timeout: timeoutMs });
  await pace(page);
  return true;
}

/**
 * Answers MXI's password challenge if it appears.
 *
 * These flows prompt for it repeatedly and NOT always at the same points,
 * so it is handled as an optional step everywhere rather than assumed.
 * Both submit styles the recordings show are supported: pressing Enter in
 * the field, and clicking a separate OK button.
 */
export async function enterPasswordIfPrompted(page: Page, password: string, timeoutMs = 8000): Promise<boolean> {
  const box = page.getByRole('textbox', { name: 'Password:' });
  try {
    await box.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return false;
  }
  await box.first().fill(password);
  await pace(page);

  // Prefer an explicit OK button when one is offered; fall back to Enter,
  // which is what several of the recorded steps used.
  const okButton = page.getByRole('button', { name: 'OK' });
  if ((await okButton.count()) > 0) {
    await okButton.first().click();
  } else {
    await box.first().press('Enter');
  }
  await pace(page);
  return true;
}

/**
 * Attaches a file to the currently-open MXI attachment form.
 *
 * Handles BOTH mechanisms rather than assuming one: a real
 * `input[type=file]` in the DOM (set directly, which works even when it's
 * hidden behind styled markup), and a click that opens the browser's file
 * chooser (intercepted via Playwright's filechooser event). The recording
 * couldn't show which applies because the file was dragged in, and drag
 * -and-drop isn't captured by codegen.
 */
export async function attachFile(page: Page, filePath: string, timeoutMs = 10_000): Promise<boolean> {
  // 1. A real file input, hidden or not.
  const fileInput = page.locator('input[type="file"]');
  if ((await fileInput.count()) > 0) {
    await fileInput.first().setInputFiles(filePath);
    await pace(page);
    return true;
  }

  // 2. A control that opens the OS file chooser when clicked.
  const trigger = page
    .getByRole('link', { name: /browse|choose|select file|attach/i })
    .or(page.getByRole('button', { name: /browse|choose|select file|attach/i }));
  if ((await trigger.count()) === 0) return false;

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: timeoutMs }),
      trigger.first().click(),
    ]);
    await chooser.setFiles(filePath);
    await pace(page);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the repair/shop location a scrapped item is staged and
 * transferred to, from the inventory's current location.
 *
 * Per explicit user direction (2026-08-23): an item sitting at
 * `<BASE>/USSTG` goes to `<BASE>/REPAIR1/SHOP1`; sometimes the site only
 * has a plain `<BASE>/REPAIR`; and DAY is a known exception that goes to
 * `DAY/REPAIR2/SHOP2`.
 *
 * Returns CANDIDATES in preference order rather than one guessed string —
 * the caller picks whichever actually exists in the real location picker,
 * so a site that doesn't match the common shape fails visibly instead of
 * silently transferring to a location that isn't there.
 */
export function repairLocationCandidates(currentLocation: string): string[] {
  const base = (currentLocation.split('/')[0] ?? '').trim().toUpperCase();
  if (!base) return [];
  if (base === 'DAY') return [`DAY/REPAIR2/SHOP2`, `DAY/REPAIR1/SHOP1`, `DAY/REPAIR`];
  return [`${base}/REPAIR1/SHOP1`, `${base}/REPAIR`, `${base}/REPAIR1`];
}

/**
 * Closes a location-picker popup, best-effort.
 *
 * REAL LEAK FOUND AND FIXED (2026-08-25, in writeInHouseScrap.ts, moved
 * here 2026-09-10 to share with the pins back-shop routing tool): neither
 * the schedule popup nor the transfer popup was EVER closed there. Both
 * were opened via `page.waitForEvent('popup')`, used, and abandoned — so a
 * multi-serial run accumulated two orphaned MXI pages per part, each one
 * still holding whatever server-side transaction state MXI attaches to a
 * picker.
 *
 * Never throws — a popup that has already closed itself is the normal
 * case, and a cleanup failure must not fail a flow that otherwise
 * succeeded.
 */
export async function closePopupQuietly(popup: Page | undefined): Promise<void> {
  if (!popup || popup.isClosed()) return;
  try {
    await popup.close();
  } catch {
    /* already gone, or closing raced with navigation — nothing to do */
  }
}

/**
 * Picks a repair/shop location out of MXI's own location picker popup.
 *
 * Tries the candidates (see repairLocationCandidates above) in preference
 * order and clicks whichever genuinely exists. Deliberately does NOT fall
 * back to "any location containing REPAIR": transferring a real part to
 * the wrong shop is worse than failing visibly.
 *
 * Moved here from writeInHouseScrap.ts (2026-09-10) so the pins back-shop
 * routing tool's own correct-base flow (Schedule Work Package -> Select
 * Repair Location -> Create Transfer -> Select Local Location, same
 * mechanism confirmed by discovery-pins-correct-base-recording.ts) can
 * reuse this ALREADY-PRODUCTION-PROVEN popup mechanic rather than
 * re-guessing it — including the two real bugs fixed below, which would
 * otherwise have needed re-discovering for pins too.
 */
export async function pickLocationInPopup(popup: Page, candidates: string[]): Promise<string | null> {
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
    log.warn({ candidates }, '[location-picker] no expected repair location present, and no find box to search with');
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
    '[location-picker] no expected repair location present in the picker, even after searching',
  );
  return null;
}

/**
 * Reads an inventory item's current location off its own Details tab —
 * moved here from writeInHouseScrap.ts (2026-09-12) so the pins back-shop
 * routing tool (pinRouting.ts) can reuse the EXACT same, already-proven
 * mechanism rather than a second copy that could drift, per explicit user
 * direction that pins are found "just like when scrapping a part out of
 * the back shop" — i.e. via the same Inventory Search
 * (openInventoryBySerial), not the ToDoList link-click the pins
 * recordings' own (confirmed incomplete/inaccurate) capture showed.
 *
 * ROOT CAUSE THIS WORKS AROUND (found live, 2026-08-25, in-house scrap):
 * MXI remembers the ACTIVE TAB for the session. Opening an item after a
 * PRIOR item left the session on `aTab=Open.OpenChecks` restores that
 * same tab — and the Details content, the only place the location is
 * stated, is never rendered at all. This is also why a serial processed
 * FIRST in a batch used to succeed while every one after it failed.
 * Detects that (`looksLikeDetailsTab`) and explicitly re-selects "Details"
 * before reading, rather than trusting whatever tab happens to be active.
 *
 * Returns currentLocation: '' (not a guess) when no location label is
 * found even after that — `parseCurrentLocation` is anchored on the
 * "Location:" label with no loose fallback, since a real production
 * capture proved a loose bare-token fallback can read a DIFFERENT item's
 * location off the same page (a search-results grid also containing
 * "PNS/STORE"). `onDetailsTab` is returned too so a caller's own failure
 * log can say whether the tab was ever successfully confirmed active, not
 * just that the location came back empty.
 */
export interface CurrentLocationRead {
  currentLocation: string;
  onDetailsTab: boolean;
}

export async function readCurrentLocationOnDetailsTab(page: Page, identifier: string): Promise<CurrentLocationRead> {
  let bodyText = await page.locator('body').innerText();
  if (!looksLikeDetailsTab(bodyText)) {
    log.info(
      { identifier, url: page.url() },
      '[location] details tab not active (MXI restored a previous tab) — selecting it explicitly',
    );
    await clickIfPresent(page, page.getByRole('link', { name: 'Details', exact: true }), TAB_CLICK_TIMEOUT_MS);
    try {
      // Content-aware wait for the location LABEL itself, not a fixed delay.
      await page.waitForFunction(
        () => /Location:\s*[A-Za-z]{3}\/[A-Za-z0-9]+/.test(document.body?.innerText ?? ''),
        undefined,
        { timeout: TAB_NAV_TIMEOUT_MS, polling: 250 },
      );
    } catch {
      /* reported below via the empty-string return, with the real page state already logged by the caller */
    }
    bodyText = await page.locator('body').innerText();
  }
  return { currentLocation: parseCurrentLocation(bodyText), onDetailsTab: looksLikeDetailsTab(bodyText) };
}

/**
 * Clicks a tab link and CONFIRMS the page actually moved to it (checked via
 * URL marker, with one retry) — moved here from writeInHouseScrap.ts
 * (2026-09-12) so the pins back-shop routing tool can reuse this exact,
 * already-proven mechanism instead of a second copy.
 *
 * REAL BUG THIS EXISTS TO FIX (2026-08-25, in-house scrap): a plain
 * `clickIfPresent` only waits for the link to become VISIBLE and its
 * return value used to be discarded — so on a slow page (measured ~19s
 * for a part-detail page to render under load) the tab was never actually
 * switched, the flow read whatever tab was already active instead, and a
 * genuinely-present item was reported as having nothing there. Now
 * positively confirms the URL itself changed before treating the click as
 * real.
 */
export async function clickUntilUrlContains(
  page: Page,
  locator: ReturnType<Page['getByRole']>,
  marker: string,
  label: string,
  identifier: string,
): Promise<boolean> {
  if (page.url().includes(marker)) return true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const clicked = await clickIfPresent(page, locator, TAB_CLICK_TIMEOUT_MS);
    if (!clicked) {
      log.warn({ identifier, label, attempt, url: page.url() }, '[tab-nav] tab link never became visible');
      continue;
    }
    try {
      await page.waitForURL((url) => url.href.includes(marker), { timeout: TAB_NAV_TIMEOUT_MS });
      return true;
    } catch {
      log.warn(
        { identifier, label, attempt, url: page.url(), expected: marker },
        '[tab-nav] clicked the tab but the URL never reached it — retrying',
      );
    }
  }
  return page.url().includes(marker);
}
