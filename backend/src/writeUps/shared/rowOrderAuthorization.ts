/**
 * Reading a grid row's existing Repair/Exchange Order state.
 *
 * The USSTG grid's "Repair/Exchange Order" column is really three
 * sub-columns, in this fixed order (confirmed from a real captured grid,
 * data/diagnostics/grid-wait-0T1Y4-*.txt):
 *
 *   Order Number | Status | Authorization
 *
 * A real row reads e.g.  `P000BFXN | AUTH | APPROVED`.
 *
 * WHY THIS IS ANCHORED ON THE ORDER NUMBER rather than a fixed cell index:
 * the same row also carries a Vendors/Shops group whose own sub-columns are
 * `Name | Type | Status | Preferred`, and that Status is ALSO frequently
 * "APPROVED". Counting cells from the left, or grepping the row text for
 * /APPROVED|REQUESTED/, would read the vendor's status and call it the
 * order's authorization. Anchoring on the P000 token and stepping two cells
 * is the only reading that cannot confuse the two.
 */

import type { Locator } from 'playwright';

/** PSA repair order numbers: "P000" plus four alphanumerics. */
const ORDER_NUMBER_PATTERN = /^P\d{3}[A-Z0-9]{4}$/;

/**
 * Every cell's text from the grid row containing this repair link, in DOM
 * order. Returns [] rather than throwing — a row we cannot read must not
 * take the whole vendor's discovery down with it.
 */
export async function readRowCellTexts(repairLink: Locator): Promise<string[]> {
  try {
    return await repairLink.locator('xpath=ancestor::tr[1]').evaluate((tr) =>
      Array.from((tr as HTMLTableRowElement).querySelectorAll('td,th')).map(
        (c) => (c as HTMLElement).innerText ?? '',
      ),
    );
  } catch {
    return [];
  }
}

export interface RowOrderState {
  /** The existing order on this line, or null when it has none yet. */
  orderNumber: string | null;
  /** The order's own status cell (e.g. "AUTH", "OPEN"). Null when no order. */
  orderStatus: string | null;
  /** The order's AUTHORIZATION cell (e.g. "APPROVED", "REQUESTED"). Null when no order. */
  authorizationStatus: string | null;
}

/**
 * Reads the order state out of one row's cell texts, in DOM order.
 */
export function parseRowOrderState(cells: readonly string[]): RowOrderState {
  const cleaned = cells.map((c) => c.replace(/\s+/g, ' ').trim());
  const index = cleaned.findIndex((c) => ORDER_NUMBER_PATTERN.test(c));
  if (index === -1) {
    return { orderNumber: null, orderStatus: null, authorizationStatus: null };
  }
  return {
    orderNumber: cleaned[index],
    orderStatus: cleaned[index + 1] ?? null,
    authorizationStatus: cleaned[index + 2] ?? null,
  };
}

/**
 * Whether this line should be left alone because an order already exists for
 * it and that order's authorization is still only REQUESTED.
 *
 * Per the analyst (2026-09-04):
 *
 *   Given there is a part on the USSTG board
 *   When looking to see if the line is a candidate
 *   AND there is already an Order Number
 *   AND the Authorization is REQUESTED
 *   Then exclude this line item
 *
 * BOTH conditions are required. An order number with APPROVED authorization
 * is still workable, and a REQUESTED authorization with no order number
 * cannot occur — so neither half alone is a reason to skip.
 */
export function isAwaitingRequestedAuthorization(state: RowOrderState): boolean {
  return state.orderNumber !== null && state.authorizationStatus?.toUpperCase() === 'REQUESTED';
}
