import type { VendorOorRow } from '../types.js';
import { readSheetRows } from './sheetUtils.js';

const DEFAULT_SHEET_NAME = 'Vendor OOR';

export async function parseVendorOor(
  filePath: string,
  sheetName: string = DEFAULT_SHEET_NAME,
): Promise<VendorOorRow[]> {
  return readSheetRows(filePath, sheetName, (get) => {
    const orderNumber = get('Order Number');
    if (!orderNumber) return null;

    return {
      orderNumber,
      createDate: get('Create Date'),
      vendorName: get('Vendor Name'),
      partDescription: get('Part Description'),
      partNumber: get('P/N'),
      serialNumber: get('Serial Number'),
      outboundAwb: get('Outbound AWB'),
      roEsd: get('RO ESD'),
      currentStatus: get('Current Status'),
      vendorNotes: get('Vendor Notes'),
    };
  });
}
