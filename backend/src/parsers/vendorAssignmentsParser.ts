import type { VendorAssignmentRow } from '../types.js';
import { readSheetRows } from './sheetUtils.js';

/**
 * Enrichment only — see matchOrders.ts. Never used to filter or drop rows.
 */
export async function parseVendorAssignments(
  filePath: string,
  sheetName?: string,
): Promise<VendorAssignmentRow[]> {
  return readSheetRows(filePath, sheetName, (get) => {
    const vendorCode = get('Vendor Code');
    const vendorName = get('Vendor Name');
    if (!vendorCode && !vendorName) return null;

    return {
      vendorCode,
      vendorName,
      certificateNumber: get('Certificate Number'),
      cra: get('CRA'),
      craEmail: get('CRA Email'),
    };
  });
}
