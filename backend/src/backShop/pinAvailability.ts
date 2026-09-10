/**
 * Pins (PN 4114T06P03) sent for repair, when NOT already at one of the
 * four back shops that repair them, are transferred to whichever of those
 * shops currently has the LOWEST total of U/S units + In Repair parts.
 *
 * WHY THIS EXISTS / evidence trail (2026-09-10, per explicit user
 * direction and discovery-pins-wrong-base-recording.ts): the part
 * availability table shows, for each of CAK/DAY/GSP/ORF in that column
 * order, a U/S-units cell followed by an In-Repair cell — a blank
 * In-Repair cell renders as a hashed/link-styled cell with no visible
 * number rather than being omitted (confirmed by explicit user direction:
 * "It seems as if the cell becomes hashed if it doesn't have a number").
 * The recording's own real values were CAK 31+(blank)=31, DAY
 * 30+(blank)=30, GSP 72+112=184, ORF 88+84=172 — and the recording's own
 * actual next step shipped to DAY, the LOWEST of the four totals. That is
 * direct evidence for the rule (not a guess): destination = lowest total,
 * matching the ordinary logistics sense of sending a part to whichever
 * shop currently has the least backlog.
 *
 * The user separately confirmed this rule directly (2026-09-10) after an
 * earlier "highest total" mis-read of the same recording was corrected.
 */

export const PIN_BACK_SHOP_ORDER = ['CAK', 'DAY', 'GSP', 'ORF'] as const;
export type PinBackShop = (typeof PIN_BACK_SHOP_ORDER)[number];

export interface PinBackShopAvailability {
  base: PinBackShop;
  /** Blank/hashed cells are read as 0 — see module docblock. */
  usUnits: number;
  inRepair: number;
}

export interface PinDestinationResult {
  destination: PinBackShop | null;
  totals: Record<PinBackShop, number>;
  /** True when two or more bases are tied for the lowest total — destination is null rather than an arbitrary pick. */
  tied: boolean;
}

/**
 * Picks the back shop with the lowest U/S + In Repair total. Ties are
 * reported rather than broken arbitrarily — sending a real part to the
 * wrong shop because of a coin-flip tie-break is worse than stopping for a
 * human to decide, and no recording has ever shown a real tie to confirm
 * how MXI's own analysts break one.
 */
export function resolvePinDestination(rows: readonly PinBackShopAvailability[]): PinDestinationResult {
  const totals = Object.fromEntries(PIN_BACK_SHOP_ORDER.map((b) => [b, 0])) as Record<PinBackShop, number>;
  for (const row of rows) {
    totals[row.base] = row.usUnits + row.inRepair;
  }

  const lowest = Math.min(...PIN_BACK_SHOP_ORDER.map((b) => totals[b]));
  const lowestBases = PIN_BACK_SHOP_ORDER.filter((b) => totals[b] === lowest);

  return {
    destination: lowestBases.length === 1 ? lowestBases[0] : null,
    totals,
    tied: lowestBases.length > 1,
  };
}
