/**
 * What should happen to an extracted quote.
 *
 * Three distinct exclusion reasons, deliberately NOT collapsed into one
 * boolean — they have different origins, different authorities, and
 * different downstream consequences:
 *
 *  - `excluded_nrep`  the VENDOR said the part is non-repairable. A fact
 *                     read off their document, applied automatically. There
 *                     is no repair to price, so writing a price/ESD would
 *                     be wrong.
 *  - `excluded_ber`   the CRA judged it Beyond Economical Repair. A PSA-side
 *                     commercial decision that only a human may make — never
 *                     the AI, never the vendor, however expensive the quote.
 *  - `excluded_other` the analyst simply doesn't want it written. No reason
 *                     required, and none is recorded — asking for a
 *                     justification on a plain "not this one" would just
 *                     produce meaningless boilerplate.
 *
 * Both scrap reasons (NREP and BER) are what a future scrap workflow will
 * key on; `excluded_other` deliberately is not, because "skip this" is not
 * a statement about the part's condition.
 *
 * NOTE: the scrap PROCESS itself is explicitly out of scope for now (per
 * user direction). This module only records the signal so that process can
 * find these rows when it's built.
 */
export type QuoteDisposition = 'pending' | 'excluded_nrep' | 'excluded_ber' | 'excluded_other';

/** The two dispositions that mean "this part is heading for scrap". */
export const SCRAP_DISPOSITIONS: readonly QuoteDisposition[] = Object.freeze(['excluded_nrep', 'excluded_ber']);

/** The dispositions a human may set directly. `excluded_nrep` is absent on purpose — it's vendor-derived, not a human choice. */
export type HumanSettableDisposition = 'pending' | 'excluded_ber' | 'excluded_other';

export function isHumanSettableDisposition(value: string): value is HumanSettableDisposition {
  return value === 'pending' || value === 'excluded_ber' || value === 'excluded_other';
}

/**
 * The disposition a freshly-extracted row starts at.
 *
 * A vendor-stated non-repairable auto-excludes (per explicit user
 * direction): if the part can't be repaired there is no repair to price,
 * so a price/ESD write would be writing a promise about work nobody is
 * going to do. Everything else starts `pending` — writable once reviewed.
 *
 * This is a DEFAULT, not a lock: a later human disposition row overrides
 * it, so an analyst who disagrees with the model's NREP read can still put
 * the row back to `pending`.
 */
export function initialDisposition(vendorSaysNonRepairable: boolean): QuoteDisposition {
  return vendorSaysNonRepairable ? 'excluded_nrep' : 'pending';
}

/**
 * What MXI action a reviewed quote actually needs.
 *
 * CHANGED 2026-08-23, per explicit user direction: NREP and BER rows used
 * to be a dead end — recorded, excluded from the write, and left for a
 * scrap workflow that didn't exist yet. That workflow's first half now
 * does exist (writeScrapPriceLines), so those rows route to it instead of
 * being skipped.
 *
 * The disposition names are deliberately unchanged: `excluded_nrep` and
 * `excluded_ber` still accurately mean "this part is heading for scrap,
 * not repair". What changed is that heading for scrap now HAS an action.
 */
export type QuoteWriteAction =
  /** Vendor offered a replacement unit — Convert Repair To Exchange. */
  | 'exchange'
  /** Part is being scrapped — add the SCRAP price line and zero the original. */
  | 'scrap_price'
  /** Ordinary repair quote — Unit Price + Price Type=QUOTE + ESD. */
  | 'price_line'
  /** Nothing to do (analyst excluded it, or it isn't a quote). */
  | 'none';

export function resolveWriteAction(
  disposition: QuoteDisposition,
  suggestsExchange: boolean,
): QuoteWriteAction {
  // Scrap wins over exchange: if the part is being scrapped there is no
  // unit to exchange. Checked first so the two can never both fire.
  if (disposition === 'excluded_nrep' || disposition === 'excluded_ber') return 'scrap_price';
  if (disposition === 'excluded_other') return 'none';
  return suggestsExchange ? 'exchange' : 'price_line';
}

export function isWritable(disposition: QuoteDisposition): boolean {
  return disposition !== 'excluded_other';
}

export function writeActionLabel(action: QuoteWriteAction): string {
  switch (action) {
    case 'exchange':
      return 'Convert to exchange';
    case 'scrap_price':
      return 'Scrap pricing';
    case 'price_line':
      return 'Price + ESD';
    default:
      return 'No action';
  }
}

export function dispositionLabel(disposition: QuoteDisposition): string {
  switch (disposition) {
    case 'excluded_nrep':
      return 'NREP — vendor says non-repairable';
    case 'excluded_ber':
      return 'BER — beyond economical repair';
    case 'excluded_other':
      return 'Excluded';
    default:
      return 'Ready to write';
  }
}
