import { resolveCraCodeForVendorCode } from './craAssignments.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT (oversized-part shipping method, 2026-09-10; extended
 * 2026-09-10 for FADEC) — keyword-in-description overrides for Transport
 * Type, each independently scoped.
 *
 * Two rules exist today, with genuinely different scope, which is why each
 * rule carries its own `craCodesInScope` rather than sharing one global
 * list:
 *
 * - TRANSCOWL / REVERSER GA / INLET COWL -> FEDEX-LT, scoped to Monica
 *   Gonzalez's vendors only (explicit user instruction: "among Monica
 *   Gonzalez's vendors..."). These are large nacelle/thrust-reverser
 *   structures that don't move on an ordinary parcel service.
 * - FADEC -> FEDEX-P1, per explicit user direction NOT vendor/CRA-scoped
 *   ("this is actually broadly applicable to all vendors") — `null` scope
 *   means every vendor in the shared engine, regardless of CRA.
 *
 * Rules are checked in array order and the FIRST match wins — today's two
 * rules can never both match the same description (no overlapping
 * keywords), but the ordering is still a deliberate, explicit choice
 * rather than an accident of iteration, should that change later.
 */
export interface TransportationOverrideRule {
  /** Human-readable id for logging/audit. */
  id: string;
  /** Substring keywords (case/whitespace-insensitive) — ANY match fires this rule. */
  keywords: readonly string[];
  transportation: string;
  /** CRA codes this rule applies to, or null for every vendor in the shared engine. */
  craCodesInScope: ReadonlySet<string> | null;
}

export const LONG_FREIGHT_TRANSPORTATION = 'FEDEX-LT';
export const FADEC_TRANSPORTATION = 'FEDEX-P1';

/** Monica Gonzalez, per craAssignments.ts's own table. */
const MONICA_GONZALEZ_CRA_CODE = '232134';

const TRANSPORTATION_OVERRIDE_RULES: readonly TransportationOverrideRule[] = [
  {
    id: 'FADEC',
    keywords: ['FADEC'],
    transportation: FADEC_TRANSPORTATION,
    craCodesInScope: null,
  },
  {
    id: 'OVERSIZED_NACELLE_STRUCTURE',
    keywords: ['TRANSCOWL', 'REVERSER GA', 'INLET COWL'],
    transportation: LONG_FREIGHT_TRANSPORTATION,
    craCodesInScope: new Set([MONICA_GONZALEZ_CRA_CODE]),
  },
];

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The rule that matches, or null. Exported for testing and so a caller can
 * log which rule/keyword fired.
 *
 * Substring, not whole-word, deliberately — unlike contractCodes.ts, which
 * is whole-word because an account code appearing inside a longer token
 * would be a false positive. Here the opposite is true: "INLET COWLING"
 * and "TRANSCOWL ASSY" are the same oversized structures a rule is about,
 * and requiring an exact word boundary would miss them.
 */
export function matchTransportationOverrideRule(
  partDescription: string | null | undefined,
  vendorCode: string,
): TransportationOverrideRule | null {
  if (!partDescription) return null;
  const haystack = normalize(partDescription);

  for (const rule of TRANSPORTATION_OVERRIDE_RULES) {
    if (!rule.keywords.some((keyword) => haystack.includes(keyword))) continue;
    if (rule.craCodesInScope) {
      const craCode = resolveCraCodeForVendorCode(vendorCode);
      if (!craCode || !rule.craCodesInScope.has(craCode)) continue;
    }
    return rule;
  }
  return null;
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
  const rule = matchTransportationOverrideRule(partDescription, vendorCode);
  if (!rule) return null;

  log.info(
    { vendorCode, ruleId: rule.id, partDescription, transportation: rule.transportation },
    '[shipment-method] transportation override rule matched',
  );
  return rule.transportation;
}
