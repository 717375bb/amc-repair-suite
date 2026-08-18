import type { CraOorRow, MatchedOrder, VendorOorRow } from '../types.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('matching');

export interface OrphanDiagnostics {
  vendorOorUniqueVendors: number;
  craOorUniqueVendors: number;
  orphanedCraRows: number;
  /** Vendor absent from Vendor OOR entirely — expected if they haven't reported this cycle. */
  orphanedFromAbsentVendor: number;
  /**
   * Vendor DOES appear elsewhere in Vendor OOR, but this specific order
   * didn't match. This is NOT automatically suspicious on its own — a vendor
   * with more open orders than replies-this-cycle will always produce some
   * of these. See likelyDuplicateOrders for the actual bug signal.
   */
  orphanedFromPresentVendor: number;
  /**
   * Orphaned CRA rows where the SAME vendor has a Vendor OOR row with the
   * identical Part Number + Serial Number under a *different* Order Number.
   * That combination can only mean one physical part — if it's genuinely
   * this, it's a real duplicate/mismatch, not a coverage gap.
   */
  likelyDuplicateOrders: Array<{ craOrderNumber: string; vendorOrderNumber: string; vendorName: string }>;
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Confirms or refutes the hypothesis that a high CRA-only orphan rate is
 * simply "this vendor hasn't reported back this cycle" rather than an Order
 * Number matching bug. Vendor-name overlap alone is too coarse a signal (a
 * vendor can legitimately have far more open orders than replies in a given
 * cycle) — the real bug signal is a Part Number + Serial Number match under
 * a different Order Number, which can only happen if the same physical part
 * got recorded under two different order numbers.
 */
export function computeOrphanDiagnostics(
  vendorRows: VendorOorRow[],
  craRows: CraOorRow[],
  matched: MatchedOrder[],
): OrphanDiagnostics {
  const vendorOorVendors = new Set(
    vendorRows.map((r) => r.vendorName).filter((v): v is string => !!v).map(normalize),
  );
  const craOorVendors = new Set(
    craRows.map((r) => r.vendorName).filter((v): v is string => !!v).map(normalize),
  );

  // Keyed by vendor|partNumber|serialNumber -> vendor OOR order number, for
  // the same-physical-part lookup below. Only keyed when both PN and serial
  // are present, since a blank serial matching another blank serial isn't
  // meaningful evidence of anything.
  const vendorOorByPartSerial = new Map<string, string>();
  for (const row of vendorRows) {
    if (!row.vendorName || !row.partNumber || !row.serialNumber) continue;
    const key = `${normalize(row.vendorName)}|${normalize(row.partNumber)}|${normalize(row.serialNumber)}`;
    vendorOorByPartSerial.set(key, row.orderNumber);
  }

  const orphanedCra = matched.filter((m) => m.flag === 'orphaned_cra_row');

  let orphanedFromAbsentVendor = 0;
  let orphanedFromPresentVendor = 0;
  const likelyDuplicateOrders: OrphanDiagnostics['likelyDuplicateOrders'] = [];

  for (const order of orphanedCra) {
    const cra = order.cra;
    const vendorName = cra?.vendorName;
    if (!vendorName) {
      orphanedFromAbsentVendor++;
      continue;
    }
    if (!vendorOorVendors.has(normalize(vendorName))) {
      orphanedFromAbsentVendor++;
      continue;
    }

    orphanedFromPresentVendor++;

    if (cra?.partNumber && cra?.serialNumber) {
      const key = `${normalize(vendorName)}|${normalize(cra.partNumber)}|${normalize(cra.serialNumber)}`;
      const vendorOrderNumber = vendorOorByPartSerial.get(key);
      if (vendorOrderNumber) {
        likelyDuplicateOrders.push({
          craOrderNumber: order.orderNumber,
          vendorOrderNumber,
          vendorName,
        });
      }
    }
  }

  return {
    vendorOorUniqueVendors: vendorOorVendors.size,
    craOorUniqueVendors: craOorVendors.size,
    orphanedCraRows: orphanedCra.length,
    orphanedFromAbsentVendor,
    orphanedFromPresentVendor,
    likelyDuplicateOrders,
  };
}

export function printOrphanDiagnostics(diagnostics: OrphanDiagnostics): void {
  const hypothesisConfirmed = diagnostics.likelyDuplicateOrders.length === 0;
  const lines = [
    '--- Orphan-rate diagnostic ---',
    `Unique vendors in Vendor OOR: ${diagnostics.vendorOorUniqueVendors}`,
    `Unique vendors in CRA OOR: ${diagnostics.craOorUniqueVendors}`,
    `Orphaned CRA-only rows: ${diagnostics.orphanedCraRows}`,
    `  - from vendors absent from Vendor OOR entirely (expected): ${diagnostics.orphanedFromAbsentVendor}`,
    `  - from vendors present elsewhere in Vendor OOR (not itself suspicious — see below): ${diagnostics.orphanedFromPresentVendor}`,
    `  - of those, matched by Part Number + Serial Number to a DIFFERENT order number for the same vendor ` +
      `(the actual bug signal): ${diagnostics.likelyDuplicateOrders.length}`,
  ];

  if (hypothesisConfirmed) {
    lines.push(
      'Hypothesis CONFIRMED: no orphaned CRA row shares a Part Number + Serial Number with a differently-numbered ' +
        'Vendor OOR row. The high orphan rate reflects reporting coverage (vendors with more open orders than ' +
        'replies this cycle), not an Order Number matching bug.',
    );
  } else {
    lines.push(
      `Hypothesis NOT confirmed: ${diagnostics.likelyDuplicateOrders.length} orphaned row(s) share an exact ` +
        'Part Number + Serial Number with a Vendor OOR row filed under a different Order Number for the same ' +
        'vendor — that can only be the same physical part. Investigate before trusting the match rate:',
    );
    for (const dup of diagnostics.likelyDuplicateOrders.slice(0, 20)) {
      lines.push(`  CRA "${dup.craOrderNumber}" vs Vendor OOR "${dup.vendorOrderNumber}" (${dup.vendorName})`);
    }
  }

  log.info({ diagnostics, hypothesisConfirmed }, lines.join('\n'));
}
