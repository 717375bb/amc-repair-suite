import ExcelJS from 'exceljs';
import { cleanCell } from './cellUtils.js';

/**
 * Shared shape behind craOorParser, vendorOorParser, and
 * vendorAssignmentsParser: open a workbook, index row 1 by header text, then
 * hand each subsequent row to `buildRow` as a `get(header)` lookup closure.
 * Returning null from `buildRow` (e.g. no order number) skips that row.
 */
export async function readSheetRows<T>(
  filePath: string,
  sheetName: string | undefined,
  buildRow: (get: (columnName: string) => string | null) => T | null,
  /**
   * Optional raw-header -> canonical-name aliases (e.g. "RO ESD" -> "MXI RO
   * ESD" for CRA OOR — see craOorParser.ts's CRA_OOR_HEADER_ALIASES).
   * Defaults to none, so every existing caller is unaffected. Registers the
   * alias's canonical name against the same column as the raw header it was
   * found under, so `get(canonicalName)` resolves correctly even though the
   * sheet itself never uses that exact text.
   */
  headerAliases: Readonly<Record<string, string>> = {},
): Promise<T[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(
      sheetName ? `Sheet "${sheetName}" not found in ${filePath}` : `No worksheet found in ${filePath}`,
    );
  }

  const headerIndex = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const header = cleanCell(cell.value);
    if (!header) return;
    headerIndex.set(header, colNumber);
    const alias = headerAliases[header];
    if (alias) headerIndex.set(alias, colNumber);
  });

  const rows: T[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const get = (name: string): string | null => {
      const col = headerIndex.get(name);
      if (col === undefined) return null;
      return cleanCell(row.getCell(col).value);
    };

    const built = buildRow(get);
    if (built) rows.push(built);
  });

  return rows;
}
