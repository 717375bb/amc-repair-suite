import type { CraOorRow } from '../types.js';
import { readSheetRows } from './sheetUtils.js';

const DEFAULT_SHEET_NAME = 'CRA OOR';

export async function parseCraOor(
  filePath: string,
  sheetName: string = DEFAULT_SHEET_NAME,
): Promise<CraOorRow[]> {
  return readSheetRows(filePath, sheetName, (get) => {
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
  });
}
