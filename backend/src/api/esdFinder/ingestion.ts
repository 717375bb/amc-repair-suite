import ExcelJS from 'exceljs';
import { parseCraOor } from '../../parsers/craOorParser.js';
import { parseVendorOor } from '../../parsers/vendorOorParser.js';
import type { CraOorRow, VendorOorRow } from '../../types.js';

/**
 * File ingestion for the Open Order ESD Finder tab — new work per the spec's
 * own scoping ("the only new backend work is: file ingestion..., a
 * job/endpoint layer, and duplicate-order detection"). Deliberately does NOT
 * reimplement parsing: parseVendorOor/parseCraOor (and the header-indexed
 * readSheetRows they're both built on) are called unchanged. This module
 * only adds what they don't already do — reject a file outright when a
 * required header is missing (readSheetRows silently returns zero rows
 * instead, since a missing "Order Number" column makes every row's
 * `get('Order Number')` come back null), and track which uploaded file each
 * row came from, which the existing single-file-path parsers have no reason
 * to carry.
 */

export const VENDOR_OOR_REQUIRED_HEADERS = [
  'Order Number',
  'Create Date',
  'Vendor Name',
  'Part Description',
  'P/N',
  'Serial Number',
  'Outbound AWB',
  'RO ESD',
  'Current Status',
  'Vendor Notes',
] as const;

export const CRA_OOR_REQUIRED_HEADERS = [
  'Order Number',
  'Create Date',
  'TAT',
  'Vendor Name',
  'Part Description',
  'P/N',
  'Serial Number',
  'Order Status',
  'MXI RO ESD',
  'Notes',
] as const;

export class MissingHeadersError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly missingHeaders: string[],
  ) {
    super(`"${fileName}" is missing required header(s): ${missingHeaders.join(', ')}`);
    this.name = 'MissingHeadersError';
  }
}

/**
 * Reads row 1's real header text from the first sheet (or the named sheet)
 * — the exact same source of truth readSheetRows() itself indexes from,
 * checked here BEFORE handing off to the real parser. Header names only,
 * per the confirmed rule: match by header text, never by column position.
 */
async function readRealHeaders(filePath: string, sheetName?: string): Promise<Set<string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  const headers = new Set<string>();
  if (!sheet) return headers;
  sheet.getRow(1).eachCell((cell) => {
    const text = String(cell.value ?? '').trim();
    if (text) headers.add(text);
  });
  return headers;
}

/**
 * Exported so the HTTP layer can reject a bad upload immediately (400,
 * before a background job is even started) rather than waiting for a job
 * to spin up and fail. This is a convenience for fast feedback only — the
 * real, structural guarantee is checkRequiredHeaders() running again inside
 * parseVendorOorFileWithValidation/parseCraOorFileWithValidation
 * regardless of what a caller already checked, so the safety property does
 * not depend on every caller remembering to pre-validate.
 */
export async function validateHeadersOnly(
  filePath: string,
  fileName: string,
  role: 'vendor' | 'cra',
): Promise<void> {
  const sheetName = role === 'vendor' ? 'Vendor OOR' : 'CRA OOR';
  const required = role === 'vendor' ? VENDOR_OOR_REQUIRED_HEADERS : CRA_OOR_REQUIRED_HEADERS;
  const headers = await readRealHeaders(filePath, sheetName);
  checkRequiredHeaders(fileName, headers, required);
}

function checkRequiredHeaders(fileName: string, realHeaders: Set<string>, required: readonly string[]): void {
  const missing = required.filter((h) => !realHeaders.has(h));
  if (missing.length > 0) {
    throw new MissingHeadersError(fileName, missing);
  }
}

export interface VendorOorRowWithSource extends VendorOorRow {
  sourceFileName: string;
}

export interface CraOorRowWithSource extends CraOorRow {
  sourceFileName: string;
}

/**
 * Validates required headers are present (rejecting with a named-header
 * error if not), then calls the real, unchanged parseVendorOor. Each
 * returned row is tagged with the source file name — needed for the
 * duplicate-order-number warning below, which must say which file(s) a
 * duplicate came from. Row source is tracked by file name + the row's own
 * Order Number rather than a raw spreadsheet row index: parseVendorOor
 * silently drops rows with a blank Order Number, so a returned row's index
 * in the array no longer lines up with its original sheet row number, and
 * re-deriving that alignment would mean partially re-implementing the
 * parser's own skip logic. Order Number is also what a CRA would actually
 * search the source file by, so it's a more directly useful locator than a
 * row index would be anyway.
 */
export async function parseVendorOorFileWithValidation(
  filePath: string,
  fileName: string,
  sheetName = 'Vendor OOR',
): Promise<VendorOorRowWithSource[]> {
  const headers = await readRealHeaders(filePath, sheetName);
  checkRequiredHeaders(fileName, headers, VENDOR_OOR_REQUIRED_HEADERS);
  const rows = await parseVendorOor(filePath, sheetName);
  return rows.map((row) => ({ ...row, sourceFileName: fileName }));
}

export async function parseCraOorFileWithValidation(
  filePath: string,
  fileName: string,
  sheetName = 'CRA OOR',
): Promise<CraOorRowWithSource[]> {
  const headers = await readRealHeaders(filePath, sheetName);
  checkRequiredHeaders(fileName, headers, CRA_OOR_REQUIRED_HEADERS);
  return parseCraOor(filePath, sheetName).then((rows) => rows.map((row) => ({ ...row, sourceFileName: fileName })));
}

/**
 * State A's per-file preview: validates headers (rejecting immediately
 * with the same clear, named-header message as the full ingestion path if
 * the file is bad) and reports a row count, without running the full
 * comparison. Calls the same validated parsers as ingestEsdFinderFiles —
 * this is not a separate, lighter-weight parse path that could disagree
 * with the real one, just an early, single-file preview of it.
 */
export async function peekEsdFinderFile(
  filePath: string,
  fileName: string,
  role: 'vendor' | 'cra',
): Promise<{ fileName: string; rowCount: number }> {
  const rowCount =
    role === 'vendor'
      ? (await parseVendorOorFileWithValidation(filePath, fileName)).length
      : (await parseCraOorFileWithValidation(filePath, fileName)).length;
  return { fileName, rowCount };
}

export interface DuplicateOrderNumber {
  orderNumber: string;
  occurrences: Array<{ sourceFileName: string; vendorName: string | null }>;
}

/**
 * Real requirement, not a nice-to-have: "the same Order Number appears in
 * more than one vendor file (or more than once total in the concatenated
 * vendor pool)... should not happen." Normalizes the same way
 * matchOrders.ts does (trim + uppercase) so a duplicate isn't missed over
 * whitespace/case alone, then groups — anything with more than one real row
 * is a duplicate, regardless of whether the two rows came from the same
 * file or two different ones.
 */
export function detectDuplicateOrderNumbers(vendorRows: VendorOorRowWithSource[]): DuplicateOrderNumber[] {
  const groups = new Map<string, VendorOorRowWithSource[]>();
  for (const row of vendorRows) {
    const key = row.orderNumber.trim().toUpperCase();
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const duplicates: DuplicateOrderNumber[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    duplicates.push({
      orderNumber: group[0].orderNumber,
      occurrences: group.map((r) => ({ sourceFileName: r.sourceFileName, vendorName: r.vendorName })),
    });
  }
  return duplicates;
}

export interface IngestedEsdFinderInput {
  vendorRows: VendorOorRowWithSource[];
  craRows: CraOorRowWithSource[];
  duplicates: DuplicateOrderNumber[];
}

/**
 * Full ingestion: validates + parses every vendor file (concatenating their
 * rows into one pool, per the confirmed rule), validates + parses the
 * single CRA file, and runs duplicate-order detection over the concatenated
 * vendor pool. Throws MissingHeadersError immediately on the first file
 * with a real problem — never guesses a mapping or silently proceeds with a
 * partially-wrong file.
 */
export async function ingestEsdFinderFiles(
  vendorFiles: Array<{ filePath: string; fileName: string }>,
  craFile: { filePath: string; fileName: string },
): Promise<IngestedEsdFinderInput> {
  const vendorRowArrays = await Promise.all(
    vendorFiles.map((f) => parseVendorOorFileWithValidation(f.filePath, f.fileName)),
  );
  const vendorRows = vendorRowArrays.flat();
  const craRows = await parseCraOorFileWithValidation(craFile.filePath, craFile.fileName);
  const duplicates = detectDuplicateOrderNumbers(vendorRows);

  return { vendorRows, craRows, duplicates };
}
