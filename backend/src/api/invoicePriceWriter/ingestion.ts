import { readSheetRows } from '../../parsers/sheetUtils.js';

/**
 * Invoice Price Writer — single-sheet ingestion. Simpler than the ESD
 * Finder's ingestion.ts: one known, fixed sheet name ("Template", per the
 * user's own real file — confirmed directly via exceljs inspection, not
 * assumed), one file, no multi-schema resolution needed. Still validates
 * required headers explicitly (a missing "PO Number" column would
 * otherwise make readSheetRows() silently return zero rows) rather than
 * letting a bad file fail silently.
 */

export const SHEET_NAME = 'Template';

export const REQUIRED_HEADERS = ['PO Number', 'Serial Number', 'Extended Amt'] as const;

export class MissingHeadersError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly missingHeaders: string[],
  ) {
    super(`"${fileName}" is missing required header(s) on the "${SHEET_NAME}" sheet: ${missingHeaders.join(', ')}`);
    this.name = 'MissingHeadersError';
  }
}

export interface InvoicePriceRow {
  orderNumber: string;
  serialNumber: string;
  newPrice: string;
}

/**
 * Validates the required headers exist on row 1 of the Template sheet,
 * throwing a clear, named-header error if not — checked directly against
 * row 1 (not inferred from whether any data row happened to have a value,
 * which would conflate "column missing" with "column present but blank on
 * every row").
 */
export async function validateHeaders(filePath: string, fileName: string): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    throw new Error(`"${fileName}" has no sheet literally named "${SHEET_NAME}".`);
  }
  const rawHeaders = new Set<string>();
  sheet.getRow(1).eachCell((cell) => {
    const text = String(cell.value ?? '').trim();
    if (text) rawHeaders.add(text);
  });
  const missing = REQUIRED_HEADERS.filter((h) => !rawHeaders.has(h));
  if (missing.length > 0) {
    throw new MissingHeadersError(fileName, missing);
  }
}

/**
 * Parses every row with a real PO Number. Rows with a blank PO Number,
 * Serial Number, or Extended Amt are skipped here (returned as part of the
 * row count difference, not surfaced as a separate error) — the caller
 * (the job runner) is what actually decides skip-vs-flag semantics for a
 * given order via classifyRow-style logic; this function's only job is
 * "give me every row that has the three fields this whole feature needs at
 * all."
 */
export async function parseInvoicePriceRows(filePath: string): Promise<InvoicePriceRow[]> {
  return readSheetRows<InvoicePriceRow>(filePath, SHEET_NAME, (get) => {
    const orderNumber = get('PO Number');
    const serialNumber = get('Serial Number');
    const newPrice = get('Extended Amt');
    if (!orderNumber || !serialNumber || !newPrice) return null;
    return { orderNumber, serialNumber, newPrice };
  });
}

export interface DuplicateOrderNumber {
  orderNumber: string;
  occurrences: number;
}

/** Same spirit as the ESD Finder's detectDuplicateOrderNumbers, adapted for one file instead of many. */
export function detectDuplicateOrderNumbers(rows: InvoicePriceRow[]): DuplicateOrderNumber[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.orderNumber.trim().toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([orderNumber, occurrences]) => ({ orderNumber, occurrences }));
}

export async function peekInvoicePriceFile(filePath: string, fileName: string): Promise<{ fileName: string; rowCount: number }> {
  await validateHeaders(filePath, fileName);
  const rows = await parseInvoicePriceRows(filePath);
  return { fileName, rowCount: rows.length };
}
