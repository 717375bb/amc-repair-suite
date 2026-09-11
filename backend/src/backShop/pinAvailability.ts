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

/**
 * The real column layout, per the user's own captured table (2026-09-12):
 * "Location | Owner | Restock Level | On Order | [Serviceable: Avail |
 * Resvd | Xfer (SRV) | In Kit] | [Unserviceable: U/S | Quar | Await Insp
 * | In Repair | Condemn | Xfer (U/S) | In Kit]" — a two-row grouped
 * header, "Serviceable"/"Unserviceable" spanning their own sub-columns.
 *
 * REAL BUG THIS FIXES (found live, 2026-09-12): `readPinAvailabilityTable`
 * (pinRouting.ts) used to take the first two non-label cells in a row as
 * U/S and In Repair — correct only if U/S immediately follows the label,
 * which it does not. It follows Owner, Restock Level, On Order, and four
 * Serviceable columns first, so the old code was reading Owner ("PSA")
 * and Restock Level ("-") — neither numeric, both silently parsed as 0 —
 * for EVERY base, every time. That is exactly the reported symptom: all
 * four totals came back 0, a tied "cannot decide" result on a table that
 * in fact had real, decisive numbers (CAK 31, DAY 86, GSP 100, ORF 116
 * that day).
 *
 * Fixed to not depend on a hardcoded column count at all: the leading
 * columns (Location/Owner/Restock Level/On Order) plausibly use rowspan
 * to span both header rows, which would make ABSOLUTE position counted
 * from the left unreliable between the header row and a data row. U/S and
 * In Repair's DISTANCE FROM THE END of the row is not affected by that —
 * Condemn/Xfer(U/S)/In Kit after In Repair, and Quar/Await Insp between
 * U/S and In Repair, are all real per-row data columns with no rowspan of
 * their own. So `pinRouting.ts` reads the offset-from-the-end ONCE from
 * whichever header row actually contains both "U/S" and "In Repair" as
 * their own cells, then applies that SAME offset to every data row —
 * self-deriving from the live page rather than a hardcoded guess.
 *
 * Extracted here as pure functions (operating on plain string arrays, not
 * a Playwright Page) specifically so this exact regression — a wrong
 * column read producing a false tie — can be pinned in `npm test` against
 * the user's own real captured row data, not just observed live.
 */
export interface AvailabilityColumnOffsets {
  usFromEnd: number;
  inRepairFromEnd: number;
}

/** Only if no live header row can be found — a single historical example, not read live. Verify against the live page if totals look wrong. */
export const FALLBACK_AVAILABILITY_COLUMN_OFFSETS: AvailabilityColumnOffsets = { usFromEnd: 7, inRepairFromEnd: 4 };

/**
 * Derives the offsets from a header row's own cell texts (whichever row
 * states both "U/S" and "In Repair" literally). Returns null when it
 * can't — the caller decides what to fall back to.
 */
export function computeAvailabilityColumnOffsets(headerCells: readonly string[]): AvailabilityColumnOffsets | null {
  const usIndex = headerCells.findIndex((t) => t === 'U/S');
  const inRepairIndex = headerCells.findIndex((t) => t === 'In Repair');
  if (usIndex === -1 || inRepairIndex === -1) return null;
  return { usFromEnd: headerCells.length - usIndex, inRepairFromEnd: headerCells.length - inRepairIndex };
}

function parseAvailabilityNumericCell(text: string): number {
  const trimmed = text.trim();
  const value = Number(trimmed);
  return trimmed === '' || Number.isNaN(value) ? 0 : value;
}

/** Extracts U/S units and In Repair from one data row's own cell texts (including its label cell), given offsets from either end of the row. */
export function extractUsageFromRowCells(
  cellTexts: readonly string[],
  offsets: AvailabilityColumnOffsets,
): { usUnits: number; inRepair: number } {
  const usCellText = cellTexts[cellTexts.length - offsets.usFromEnd];
  const inRepairCellText = cellTexts[cellTexts.length - offsets.inRepairFromEnd];
  return {
    usUnits: usCellText !== undefined ? parseAvailabilityNumericCell(usCellText) : 0,
    inRepair: inRepairCellText !== undefined ? parseAvailabilityNumericCell(inRepairCellText) : 0,
  };
}
