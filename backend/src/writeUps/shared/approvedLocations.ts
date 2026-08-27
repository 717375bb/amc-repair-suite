/**
 * The bases PSA can create repair orders out of.
 *
 * WHY THIS EXISTS (2026-08-27, explicit user direction): "Sometimes, parts
 * come off at maintenance bases that don't belong to PSA. There is a list
 * of locations we can create orders out of, and if a line is from a base
 * other than these, I want that line to be skipped."
 *
 * Before this, the vendor-code engine accepted ANY station code it found
 * and simply appended "/DOCK" to it — so a part removed at a non-PSA base
 * would have had a real order created against a base PSA does not operate
 * out of. Aero Repair already had its own 12-station table and treated
 * anything outside it as an exception; this brings the vendor-code family
 * up to the same standard, against the fuller list.
 *
 * Pure and separately tested — this decides whether a real order gets
 * created at all.
 */

/**
 * Bases that route to THEMSELVES: a part removed here gets its order
 * created against this same base's dock.
 */
const SELF_ROUTING_BASES = ['CAK', 'DCA', 'PHL', 'PNS', 'CVG', 'DAY', 'SAV', 'CLT', 'DFW', 'GSP', 'ORF', 'TYS'] as const;

/**
 * Bases whose work is handled out of CLT: approved to create orders from,
 * but the order is created against CLT's dock rather than their own.
 *
 * TUS (Tucson International), not TUC. The code merged on 2026-08-26 had
 * TUC — Tucumán, Argentina — which was a typo, confirmed with the user.
 */
const CLT_ROUTED_BASES = ['NQA', 'QRO', 'CKB', 'TUS'] as const;

/** Every approved base, in the order given. */
export const APPROVED_BASES: readonly string[] = [...SELF_ROUTING_BASES, ...CLT_ROUTED_BASES];

const CLT_ROUTED = new Set<string>(CLT_ROUTED_BASES.map((b) => b.toUpperCase()));
const APPROVED = new Set<string>(APPROVED_BASES.map((b) => b.toUpperCase()));

/**
 * Pulls the base station out of a location value like "DAY/USSTG" or
 * "PNS/Repair1/Shop1". Null if the value has no "<CODE>/..." shape at all.
 *
 * Case-insensitive: MXI's location casing genuinely varies by site
 * (confirmed live — "PNS/Repair1/Shop1" alongside "DFW/REPAIR1/SHOP1").
 */
export function extractBaseStation(currentLocation: string | null | undefined): string | null {
  if (!currentLocation) return null;
  const match = currentLocation.trim().match(/^([A-Za-z0-9]+)\//);
  return match ? match[1].toUpperCase() : null;
}

/** Whether PSA can create orders out of this base. */
export function isApprovedBase(baseStation: string | null | undefined): boolean {
  if (!baseStation) return false;
  return APPROVED.has(baseStation.trim().toUpperCase());
}

/**
 * The base an approved station's order is actually created against.
 *
 * NQA / QRO / CKB / TUS are handled out of CLT. Everything else routes to
 * itself.
 *
 * NOTE — PHL routes to ITSELF as of 2026-08-27. The 2026-08-26 code routed
 * it to CLT; the user's approved list names only NQA/QRO/CKB/TUS as
 * CLT-handled, and confirmed on being asked that PHL should route to
 * itself. This is a real change to where PHL parts are sent.
 */
export function routeBaseStation(baseStation: string): string {
  const normalized = baseStation.trim().toUpperCase();
  return CLT_ROUTED.has(normalized) ? 'CLT' : normalized;
}

export interface BaseApprovalResult {
  /** The base read off the location, or null if none could be read. */
  baseStation: string | null;
  approved: boolean;
  /** Where the order is created against — null unless approved. */
  routedTo: string | null;
  /** Analyst-facing reason, null when approved. */
  reason: string | null;
}

/**
 * The whole decision for one line's current location.
 *
 * An unreadable location is NOT approved. That is deliberate: "we could not
 * tell which base this is" must never become "create the order anyway".
 */
export function evaluateBaseStation(currentLocation: string | null | undefined): BaseApprovalResult {
  const baseStation = extractBaseStation(currentLocation);
  if (!baseStation) {
    return {
      baseStation: null,
      approved: false,
      routedTo: null,
      reason:
        `Could not read a base station from this line's location (${currentLocation ? `"${currentLocation}"` : 'not found'}), ` +
        `so whether PSA can create an order for it is unknown.`,
    };
  }
  if (!isApprovedBase(baseStation)) {
    return {
      baseStation,
      approved: false,
      routedTo: null,
      reason: `${baseStation} is not a base PSA creates repair orders out of, so this line was skipped.`,
    };
  }
  return { baseStation, approved: true, routedTo: routeBaseStation(baseStation), reason: null };
}
