import type { CraOorRow, MatchedOrder, VendorAssignmentRow, VendorOorRow } from '../types.js';

function normalizeOrderNumber(orderNumber: string): string {
  return orderNumber.trim().toUpperCase();
}

function normalizeVendorName(vendorName: string): string {
  return vendorName.trim().toUpperCase();
}

/**
 * Joins Vendor OOR to CRA OOR on Order Number. Rows with no match on either
 * side are kept and flagged (orphaned_vendor_row / orphaned_cra_row) rather
 * than dropped, so nothing silently disappears from the output.
 *
 * Vendor Assignments is enrichment only (CRA owner name/email for display) —
 * it never filters or drops rows from either report.
 */
export function matchOrders(
  vendorRows: VendorOorRow[],
  craRows: CraOorRow[],
  vendorAssignments: VendorAssignmentRow[] = [],
): MatchedOrder[] {
  const craByOrder = new Map<string, CraOorRow>();
  for (const row of craRows) {
    craByOrder.set(normalizeOrderNumber(row.orderNumber), row);
  }

  const assignmentByVendorName = new Map<string, VendorAssignmentRow>();
  for (const assignment of vendorAssignments) {
    if (assignment.vendorName) {
      assignmentByVendorName.set(normalizeVendorName(assignment.vendorName), assignment);
    }
  }

  const lookupAssignment = (vendorName: string | null): VendorAssignmentRow | undefined => {
    if (!vendorName) return undefined;
    return assignmentByVendorName.get(normalizeVendorName(vendorName));
  };

  const matched: MatchedOrder[] = [];
  const matchedCraKeys = new Set<string>();

  for (const vendor of vendorRows) {
    const key = normalizeOrderNumber(vendor.orderNumber);
    const cra = craByOrder.get(key) ?? null;
    const assignment = lookupAssignment(vendor.vendorName);

    if (cra) matchedCraKeys.add(key);

    matched.push({
      orderNumber: vendor.orderNumber,
      vendor,
      cra,
      flag: cra ? 'ok' : 'orphaned_vendor_row',
      craOwnerName: assignment?.cra ?? null,
      craOwnerEmail: assignment?.craEmail ?? null,
    });
  }

  for (const cra of craRows) {
    const key = normalizeOrderNumber(cra.orderNumber);
    if (matchedCraKeys.has(key)) continue;

    const assignment = lookupAssignment(cra.vendorName);
    matched.push({
      orderNumber: cra.orderNumber,
      vendor: null,
      cra,
      flag: 'orphaned_cra_row',
      craOwnerName: assignment?.cra ?? null,
      craOwnerEmail: assignment?.craEmail ?? null,
    });
  }

  return matched;
}
