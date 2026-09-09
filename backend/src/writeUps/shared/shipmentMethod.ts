import { resolveCraCodeForVendorCode } from './craAssignments.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT (oversized-part shipping method, 2026-09-10) — per
 * explicit user direction: "among Monica Gonzalez's vendors, anything with
 * the keywords TRANSCOWL, REVERSER GA, or INLET COWL in their descriptions
 * needs to be shipped via shipment method FEDEX-LT rather than FEDEX-2."
 *
 * These are all large nacelle/thrust-reverser structures — they don't move
 * on an ordinary parcel service, which is why the rule keys on the part
 * itself rather than on the vendor alone.
 *
 * Scoped to one CRA's vendors by explicit instruction, NOT engine-wide.
 * That scoping is real and load-bearing: the same keyword on another CRA's
 * vendor is not covered by this direction, and quietly widening it would
 * change how other people's parts ship. Widening later is a one-line
 * change to CRA_CODES_IN_SCOPE, not a rewrite.
 */
export const LONG_FREIGHT_TRANSPORTATION = 'FEDEX-LT';

/** Monica Gonzalez, per craAssignments.ts's own table. */
const CRA_CODES_IN_SCOPE = new Set(['232134']);

/**
 * Matched case-insensitively against the part's description, on
 * whitespace-normalized text so "REVERSER  GA" (a real possibility in
 * hand-maintained MXI descriptions) still matches "REVERSER GA".
 *
 * Substring, not whole-word, deliberately — unlike contractCodes.ts, which
 * is whole-word because an account code appearing inside a longer token
 * would be a false positive. Here the opposite is true: "INLET COWLING"
 * and "TRANSCOWL ASSY" are the same oversized structures the rule is
 * about, and requiring an exact word boundary would miss them.
 */
const LONG_FREIGHT_KEYWORDS = ['TRANSCOWL', 'REVERSER GA', 'INLET COWL'] as const;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toUpperCase();
}

/** The keyword that matched, or null. Exported for testing and for logging which one fired. */
export function matchLongFreightKeyword(partDescription: string | null | undefined): string | null {
  if (!partDescription) return null;
  const haystack = normalize(partDescription);
  return LONG_FREIGHT_KEYWORDS.find((keyword) => haystack.includes(keyword)) ?? null;
}

/**
 * Returns the Transport Type this line should use INSTEAD of the vendor's
 * configured default, or null to mean "no override — use the default".
 *
 * Null is the answer for every line that doesn't match, which is the
 * overwhelming majority; the caller keeps its existing default path
 * untouched rather than this function having to know what the default is.
 */
export function resolveTransportationOverride(
  vendorCode: string,
  partDescription: string | null | undefined,
): string | null {
  const craCode = resolveCraCodeForVendorCode(vendorCode);
  if (!craCode || !CRA_CODES_IN_SCOPE.has(craCode)) return null;

  const keyword = matchLongFreightKeyword(partDescription);
  if (!keyword) return null;

  log.info(
    { vendorCode, craCode, keyword, partDescription, transportation: LONG_FREIGHT_TRANSPORTATION },
    '[shipment-method] oversized-part keyword matched — overriding Transport Type',
  );
  return LONG_FREIGHT_TRANSPORTATION;
}
