import type { MatchedOrder, VendorAssignmentRow, VendorOorRow } from '../types.js';

function normalizeVendorName(vendorName: string): string {
  return vendorName.trim().toUpperCase();
}

/**
 * Turns Vendor OOR rows straight into the shape the inference engine
 * consumes, with no CRA file and no join.
 *
 * WHY THIS EXISTS (2026-08-26, explicit user direction): the ESD Finder
 * used to require a CRA OOR file purely so vendor rows could be matched to
 * it. The comparison had stopped earning its keep — every field the
 * inference actually reads (`roEsd`, `currentStatus`, `vendorNotes`) comes
 * off the VENDOR row, so the join was an extra file to produce and an
 * extra way to fail, for no decision it influenced.
 *
 * DO NOT reuse `matchOrders(vendorRows, [])` for this. It flags every
 * unmatched vendor row `orphaned_vendor_row`, and that match flag becomes
 * the row's ESD flag verbatim in applyInferenceRules — so with an empty
 * CRA list every single row would come out non-actionable and the tab
 * would silently write nothing. These rows are flagged `'ok'` because
 * they genuinely are the thing being acted on.
 *
 * `cra: null` is already handled throughout the downstream pipeline
 * (`applyInferenceRules` reads `order.cra?.mxiRoEsd ?? null` and
 * `order.cra?.orderStatus ?? null`), so `mxiEsdRaw` and `deltaDaysVsMxi`
 * simply come out null — which is exactly right when no CRA file was
 * supplied to state them.
 *
 * Vendor Assignments stays enrichment-only, same as in `matchOrders`: it
 * adds the CRA owner name/email for display and never filters or drops a
 * row.
 */
export function buildVendorOnlyOrders(
  vendorRows: VendorOorRow[],
  vendorAssignments: VendorAssignmentRow[] = [],
): MatchedOrder[] {
  const assignmentByVendorName = new Map<string, VendorAssignmentRow>();
  for (const assignment of vendorAssignments) {
    if (assignment.vendorName) {
      assignmentByVendorName.set(normalizeVendorName(assignment.vendorName), assignment);
    }
  }

  return vendorRows.map((vendor) => {
    const assignment = vendor.vendorName
      ? assignmentByVendorName.get(normalizeVendorName(vendor.vendorName))
      : undefined;
    return {
      orderNumber: vendor.orderNumber,
      vendor,
      cra: null,
      flag: 'ok' as const,
      craOwnerName: assignment?.cra ?? null,
      craOwnerEmail: assignment?.craEmail ?? null,
    };
  });
}
