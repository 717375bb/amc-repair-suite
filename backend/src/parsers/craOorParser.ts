import type { CraOorRow } from '../types.js';
import { readSheetRows } from './sheetUtils.js';

const DEFAULT_SHEET_NAME = 'CRA OOR';

/**
 * Real-world CRA OOR exports have been seen using "RO ESD" for the column
 * this parser reads as MXI RO ESD (confirmed against a real file dropped
 * into the ESD Finder tab, sheet named "VendorOrders" — see #4a). A small,
 * explicit alias map rather than a fuzzy match, so a future header variant
 * can be added here without touching parse logic. Deliberately CRA-OOR-only:
 * Vendor OOR has its own, different, legitimate "RO ESD" column (the
 * vendor's promised ship date) that must never be aliased away — this map
 * is never applied to that parser.
 */
export const CRA_OOR_HEADER_ALIASES: Readonly<Record<string, string>> = {
  'RO ESD': 'MXI RO ESD',
};

export async function parseCraOor(
  filePath: string,
  sheetName: string = DEFAULT_SHEET_NAME,
): Promise<CraOorRow[]> {
  return readSheetRows(
    filePath,
    sheetName,
    (get) => {
      const orderNumber = get('Order Number');
      if (!orderNumber) return null;

      return {
        orderNumber,
        createDate: get('Create Date'),
        tat: get('TAT'),
        vendorName: get('Vendor Name'),
        partDescription: get('Part Description'),
        partNumber: get('P/N'),
        serialNumber: get('Serial Number'),
        orderStatus: get('Order Status'),
        mxiRoEsd: get('MXI RO ESD'),
        notes: get('Notes'),
      };
    },
    CRA_OOR_HEADER_ALIASES,
  );
}
