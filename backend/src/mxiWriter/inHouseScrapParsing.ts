/**
 * Pure text parsing for the in-house scrap flow, split out of
 * writeInHouseScrap.ts so it can be unit-tested against REAL captured page
 * text with no browser involved.
 *
 * Exists because this parse has now been the reported bug twice
 * (2026-08-25), both times because it was reading a page that did not
 * contain the item's location at all. Keeping it pure means a regression
 * shows up in `npm test` in milliseconds instead of in a live scrap run.
 */

/**
 * MXI renders the item's location on the Inventory Details page's DETAILS
 * tab as e.g. `Location:   DAY/USSTG (Unserviceable Staging)` — confirmed
 * live against production part 820CE02Y01/403.
 *
 * `\s*` deliberately spans newlines: the label and the value are separate
 * table cells, so `innerText` may put them on one line or two depending on
 * the rendering.
 */
const LABELLED_LOCATION = /Location:\s*([A-Za-z]{3}\/[A-Za-z0-9]+)/;

/**
 * Reads the item's current location from the page text, or '' if the page
 * does not state one.
 *
 * ANCHORED ON THE LABEL, WITH NO LOOSE FALLBACK — deliberately. Earlier
 * versions fell back to the first bare `XXX/YYY` token anywhere in the
 * body, and that is actively dangerous: verified against a real
 * search-results grid, the bare pattern returns `PNS/STORE`, which is
 * ANOTHER ITEM's location. That would resolve to a confident set of repair
 * shops for the wrong site and transfer a real part to the wrong place.
 * Reading nothing and failing visibly is much better than that.
 */
export function parseCurrentLocation(bodyText: string): string {
  return bodyText.match(LABELLED_LOCATION)?.[1] ?? '';
}

/**
 * Whether the page text looks like the Inventory Details page's DETAILS
 * tab — the only tab that states the item's location.
 *
 * ROOT CAUSE THIS EXISTS FOR (2026-08-25): MXI remembers the active tab
 * for the session. This flow itself ends up on `aTab=Open.OpenChecks`
 * while reading the item's work packages, so the NEXT time an item is
 * opened MXI restores that tab and never renders the Details content.
 * Proven from a real production capture of serial L903140 taken on
 * `aTab=Open.OpenChecks`: it contains no `Location:` label and no
 * station-shaped token anywhere on the page. The flow read that page,
 * found no location, and blamed the part — "Could not read a base station
 * from this item's current location ("not found")".
 *
 * That is also why the very first serial in a batch used to succeed and
 * every one after it failed: the first left the session on the Open tab.
 */
export function looksLikeDetailsTab(bodyText: string): boolean {
  return LABELLED_LOCATION.test(bodyText);
}
