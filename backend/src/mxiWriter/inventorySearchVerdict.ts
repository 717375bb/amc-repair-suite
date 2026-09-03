/**
 * Reading MXI's own verdict line off an inventory search result page.
 *
 * REAL BUG THIS EXISTS TO FIX (found 2026-08-27): openInventoryBySerial
 * clicked Search, waited a flat pace(), then counted matching links — and
 * reported "No inventory item found for serial X" when the count was zero.
 * A back-shop discovery run over 32 real parts returned that for four
 * serials that had opened successfully five minutes earlier in the same
 * session, and a direct re-search of one of them (BN 397172) showed MXI
 * plainly answering "1 inventory item was found." The parts were always
 * there; the results simply had not rendered when we looked.
 *
 * That is the failure this project keeps hitting: a fault reported as a
 * confident answer. Downstream it is worse than a crash — in the in-house
 * scrap flow "not found" is a terminal failure for the part, and in
 * discovery it would silently drop a part off the day's list.
 *
 * The fix is to wait for MXI to actually STATE an outcome. Both forms below
 * are verbatim from live production pages captured on 2026-08-27:
 *   0 results: "0 of 0 inventory items were found."
 *   1 result:  "1 inventory item was found."
 */

export interface SearchVerdict {
  /** How many rows the page says it is showing. Zero is a real, trustworthy answer. */
  shown: number;
  /** The total behind an "N of M" phrasing, else null. */
  total: number | null;
  /** The matched sentence, verbatim, for an error message that quotes MXI rather than us. */
  raw: string;
}

/**
 * Matches both phrasings in one pass. Singular/plural and was/were vary with
 * the count, so neither is pinned; the "N of M" prefix is optional because
 * the single-result page omits it.
 */
const VERDICT = /(\d+)(?:\s+of\s+(\d+))?\s+inventory\s+items?\s+(?:was|were)\s+found/i;

/**
 * MXI's stated result count, or null when the page has not said anything yet.
 *
 * Null means "no answer on the page", NOT "no results" — the entire point of
 * this module. Callers must keep waiting, or report a fault, never treat it
 * as an empty result.
 */
export function parseSearchVerdict(pageText: string): SearchVerdict | null {
  const m = VERDICT.exec(pageText ?? '');
  if (!m) return null;
  const shown = Number(m[1]);
  if (!Number.isFinite(shown)) return null;
  const total = m[2] !== undefined ? Number(m[2]) : null;
  return { shown, total: Number.isFinite(total as number) ? total : null, raw: m[0] };
}
