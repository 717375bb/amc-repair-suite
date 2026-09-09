/**
 * Whether a quote should be handled as an exchange.
 *
 * Two independent sources, deliberately kept apart:
 *
 *  - the VENDOR's own document, read by the extraction
 *    (`suggests_exchange`) — a fact about what the vendor offered;
 *  - the ANALYST's decision, recorded per extraction — a PSA-side judgement
 *    that may go either way.
 *
 * ADDED 2026-09-04 on the analyst's instruction: "I want to be able to mark
 * an order as an exchange, even if the AI does not discover that it should
 * be one." The override also works in the other direction — an analyst who
 * disagrees with a model-detected exchange can turn it off — because a
 * one-way override would leave a wrong positive with no remedy.
 *
 * Mirrors quoteDisposition's shape on purpose: the model's read is a
 * DEFAULT, a human row overrides it, and the origin of the decision stays
 * visible in the audit trail rather than being flattened into one boolean.
 */

export interface ExchangeDecision {
  /** What the extraction read off the vendor's document. */
  vendorSuggested: boolean;
  /** The analyst's override, or null when they have not expressed one. */
  humanDecision: boolean | null;
}

/**
 * The exchange state that actually drives the MXI action.
 *
 * A human decision always wins — including a human "no" over a model "yes".
 */
export function resolveIsExchange(decision: ExchangeDecision): boolean {
  return decision.humanDecision ?? decision.vendorSuggested;
}

/** How the current exchange state came to be, for the review UI and the audit trail. */
export type ExchangeOrigin = 'vendor' | 'analyst_set' | 'analyst_cleared' | 'none';

export function exchangeOrigin(decision: ExchangeDecision): ExchangeOrigin {
  if (decision.humanDecision === true) return 'analyst_set';
  if (decision.humanDecision === false) return 'analyst_cleared';
  return decision.vendorSuggested ? 'vendor' : 'none';
}

export function exchangeOriginLabel(origin: ExchangeOrigin): string {
  switch (origin) {
    case 'vendor':
      return 'Exchange — vendor offered a replacement';
    case 'analyst_set':
      return 'Exchange — set by analyst';
    case 'analyst_cleared':
      return 'Not an exchange — cleared by analyst';
    default:
      return 'Not an exchange';
  }
}
