import ExcelJS from 'exceljs';
import { cleanCell } from '../parsers/cellUtils.js';
import { readSheetRows } from '../parsers/sheetUtils.js';
import type { BackShopRow } from './backShopRows.js';

/**
 * Reads the daily back-shop listing (BackShopListing.xlsm, sheet "Today").
 *
 * Confirmed against the real workbook: row 1 is the header row, EXCEPT that
 * A1 holds the sheet's date rather than a header ("8/27/2026"), and column A
 * of each data row holds a composite "PartNo&SerialNo" key. Neither is used
 * as a field — the part number and serial are read from their own named
 * columns, so a change to that composite key cannot silently shift what
 * gets scrapped.
 *
 * `readSheetRows` indexes row 1 by header text, so A1's date simply becomes
 * an unused extra key. The date is read separately below rather than
 * special-casing that shared helper for one caller.
 */

export const BACK_SHOP_SHEET = 'Today';

/** Real headers, confirmed by direct inspection of the live workbook. */
const HEADER = {
  partName: 'Part Name',
  partNumber: 'Part No',
  serialNumber: 'Serial No',
  cra: 'CRA',
  status: 'Status',
  location: 'Location',
  workPackageNo: 'Work Package No',
} as const;

export class BackShopSheetError extends Error {}

export interface ParsedBackShopListing {
  sheetDate: Date | null;
  rows: BackShopRow[];
  /** Rows present on the sheet but skipped for want of a part number or serial. */
  skippedIncomplete: number;
}

/**
 * The date in A1.
 *
 * Excel may hand this back as a real Date or as text depending on how the
 * cell is formatted, so both are handled. Returns null rather than guessing
 * — judgeFreshness treats an unreadable date as a warning, never as "fine".
 */
async function readSheetDate(filePath: string): Promise<Date | null> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(BACK_SHOP_SHEET);
  if (!sheet) throw new BackShopSheetError(`Sheet "${BACK_SHOP_SHEET}" not found in ${filePath}.`);

  const raw = sheet.getRow(1).getCell(1).value;
  if (raw instanceof Date) return raw;
  const text = cleanCell(raw);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function parseBackShopListing(filePath: string): Promise<ParsedBackShopListing> {
  const sheetDate = await readSheetDate(filePath);

  let skippedIncomplete = 0;
  let sheetRow = 1; // row 1 is the header; readSheetRows starts handing us row 2

  const rows = await readSheetRows<BackShopRow>(filePath, BACK_SHOP_SHEET, (get) => {
    sheetRow += 1;
    const partNumber = get(HEADER.partNumber);
    const serialNumber = get(HEADER.serialNumber);
    // A row without both is not something we can search MXI for. Counted so
    // "47 rows on the sheet, 44 checked" is explainable rather than a silent
    // discrepancy.
    if (!partNumber || !serialNumber) {
      // Genuinely blank trailing rows are not worth reporting as skipped.
      if (partNumber || serialNumber || get(HEADER.partName)) skippedIncomplete += 1;
      return null;
    }
    return {
      partNumber,
      serialNumber,
      partName: get(HEADER.partName),
      cra: get(HEADER.cra),
      status: get(HEADER.status),
      location: get(HEADER.location),
      workPackageNo: get(HEADER.workPackageNo),
      sheetRow,
    };
  });

  if (rows.length === 0 && skippedIncomplete === 0) {
    throw new BackShopSheetError(
      `Sheet "${BACK_SHOP_SHEET}" in ${filePath} produced no rows with both a "${HEADER.partNumber}" and a ` +
        `"${HEADER.serialNumber}". Check the headers are unchanged before trusting an empty result.`,
    );
  }

  return { sheetDate, rows, skippedIncomplete };
}
