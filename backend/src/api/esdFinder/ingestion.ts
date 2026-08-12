import ExcelJS from 'exceljs';
import { CRA_OOR_HEADER_ALIASES, parseCraOor } from '../../parsers/craOorParser.js';
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
 * One known OOR shape — the required column list plus any raw-header
 * aliases that apply only to this shape (see CRA_OOR_HEADER_ALIASES).
 * headerAliases is intentionally empty for Vendor OOR: its own "RO ESD"
 * column is a different, legitimate field and must never be aliased.
 */
interface OorSchema {
  role: 'vendor' | 'cra';
  requiredHeaders: readonly string[];
  headerAliases: Readonly<Record<string, string>>;
}

const VENDOR_OOR_SCHEMA: OorSchema = {
  role: 'vendor',
  requiredHeaders: VENDOR_OOR_REQUIRED_HEADERS,
  headerAliases: {},
};

const CRA_OOR_SCHEMA: OorSchema = {
  role: 'cra',
  requiredHeaders: CRA_OOR_REQUIRED_HEADERS,
  headerAliases: CRA_OOR_HEADER_ALIASES,
};

const KNOWN_OOR_SCHEMAS: readonly OorSchema[] = [VENDOR_OOR_SCHEMA, CRA_OOR_SCHEMA];

function schemaForRole(role: 'vendor' | 'cra'): OorSchema {
  return role === 'vendor' ? VENDOR_OOR_SCHEMA : CRA_OOR_SCHEMA;
}

/** Row 1's real, raw cell text — no aliasing applied here, just what's literally in the sheet. */
function readRawHeaderRow(sheet: ExcelJS.Worksheet): string[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell) => {
    const text = String(cell.value ?? '').trim();
    if (text) headers.push(text);
  });
  return headers;
}

function applyHeaderAliases(rawHeaders: readonly string[], aliases: Readonly<Record<string, string>>): Set<string> {
  const aliased = new Set(rawHeaders);
  for (const raw of rawHeaders) {
    const alias = aliases[raw];
    if (alias) aliased.add(alias);
  }
  return aliased;
}

function schemaMatches(rawHeaders: readonly string[], schema: OorSchema): boolean {
  const aliased = applyHeaderAliases(rawHeaders, schema.headerAliases);
  return schema.requiredHeaders.every((h) => aliased.has(h));
}

/**
 * Resolves which worksheet is the real data sheet for the given OOR schema,
 * and validates its headers — replacing the old hardcoded
 * getWorksheet('Vendor OOR') / getWorksheet('CRA OOR') lookup, which failed
 * silently (empty header set, reported as "every column missing") the
 * moment a real export used a different sheet name. Real files have been
 * seen using "VendorOrders" instead of either nominal name (see #4a) — so
 * sheet resolution is by CONTENT: whichever worksheet's row-1 headers
 * (after this schema's own aliases) satisfy the required column list,
 * never by name. Falls back to the first/only worksheet if no sheet
 * matches by content (every real file seen so far is single-sheet); that
 * sheet's genuinely missing headers are then reported normally. Throws
 * immediately, before any fallback, only if the workbook has no worksheets
 * at all — the one case content resolution genuinely can't recover from.
 *
 * Also tries the OTHER known OOR schema before giving up: a file that's
 * really CRA-OOR-shaped dropped in as "vendor" role should get a specific
 * "this looks like CRA OOR, not Vendor OOR" error, not a flat wall of "10
 * headers missing" that looks like a totally malformed file.
 */
async function resolveAndValidateSheet(
  filePath: string,
  fileName: string,
  schema: OorSchema,
): Promise<{ sheetName: string }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheetsInfo = workbook.worksheets.map((sheet) => ({ name: sheet.name, rawHeaders: readRawHeaderRow(sheet) }));

  // TEMP DIAGNOSTIC — #4a, read-only, no behavior change. Always fires
  // before any resolution decision, so (unlike the old readRealHeaders(),
  // which returned early on a sheet-name miss) it never silently skips
  // printing just because nothing resolved.
  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    console.log(`[diag-4a] resolveAndValidateSheet: file="${filePath}" fileName="${fileName}" role="${schema.role}"`);
    console.log('[diag-4a]   required column list:', JSON.stringify(schema.requiredHeaders));
    for (const sheet of workbook.worksheets) {
      const rawHeaders = readRawHeaderRow(sheet);
      console.log(`[diag-4a]   sheet "${sheet.name}" row 1 raw headers:`, JSON.stringify(rawHeaders));
      for (let r = 2; r <= 3; r++) {
        const rowValues: unknown[] = [];
        sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => rowValues.push(cell.value));
        console.log(`[diag-4a]     row ${r} raw values:`, JSON.stringify(rowValues));
      }
    }
  }

  if (sheetsInfo.length === 0) {
    throw new Error(
      `"${fileName}": could not resolve a header row — the workbook has no worksheets at all. ` +
        `Looking for (role "${schema.role}"): ${schema.requiredHeaders.join(', ')}.`,
    );
  }

  const contentMatches = sheetsInfo.filter((s) => schemaMatches(s.rawHeaders, schema));

  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    if (contentMatches.length === 0) {
      console.log(`[diag-4a]   no sheet matched role "${schema.role}" by content.`);
    } else {
      console.log(
        `[diag-4a]   sheet(s) matching role "${schema.role}" by content:`,
        JSON.stringify(contentMatches.map((s) => s.name)),
      );
      if (contentMatches.length > 1) {
        console.log('[diag-4a]   NOTE: more than one sheet matches — taking the first. Worth a closer look if this is unexpected.');
      }
    }
  }

  if (contentMatches.length > 0) {
    return { sheetName: contentMatches[0].name };
  }

  // No sheet satisfies this schema. Check whether the file matches the
  // OTHER known schema instead before falling back — see docstring.
  const otherSchema = KNOWN_OOR_SCHEMAS.find((s) => s.role !== schema.role);
  const otherMatch = otherSchema ? sheetsInfo.find((s) => schemaMatches(s.rawHeaders, otherSchema)) : undefined;
  if (otherSchema && otherMatch) {
    throw new Error(
      `"${fileName}": expected a ${schema.role.toUpperCase()} OOR file, but its headers match the ` +
        `${otherSchema.role.toUpperCase()} OOR schema instead (sheet "${otherMatch.name}"). ` +
        `Confirm this file was dropped in the correct spot.`,
    );
  }

  // Fall back to the first/only worksheet and report its genuinely missing
  // headers normally — real workbooks seen so far are single-sheet.
  const fallback = sheetsInfo[0];
  const aliased = applyHeaderAliases(fallback.rawHeaders, schema.headerAliases);
  const missing = schema.requiredHeaders.filter((h) => !aliased.has(h));

  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    console.log(`[diag-4a]   falling back to first sheet "${fallback.name}" (no content match, no other-schema match)`);
    console.log('[diag-4a]   headers found on fallback sheet (aliased):', JSON.stringify([...aliased]));
    console.log('[diag-4a]   required columns NOT found:', JSON.stringify(missing));
  }

  if (missing.length > 0) {
    throw new MissingHeadersError(fileName, missing);
  }
  return { sheetName: fallback.name };
}

/**
 * Exported so the HTTP layer can reject a bad upload immediately (400,
 * before a background job is even started) rather than waiting for a job
 * to spin up and fail. This is a convenience for fast feedback only — the
 * real, structural guarantee is resolveAndValidateSheet() running again
 * inside parseVendorOorFileWithValidation/parseCraOorFileWithValidation
 * regardless of what a caller already checked, so the safety property does
 * not depend on every caller remembering to pre-validate.
 */
export async function validateHeadersOnly(
  filePath: string,
  fileName: string,
  role: 'vendor' | 'cra',
): Promise<void> {
  await resolveAndValidateSheet(filePath, fileName, schemaForRole(role));
}

export interface VendorOorRowWithSource extends VendorOorRow {
  sourceFileName: string;
}

export interface CraOorRowWithSource extends CraOorRow {
  sourceFileName: string;
}

/**
 * Validates required headers are present (rejecting with a named-header
 * error if not) and resolves the real sheet by content — never a hardcoded
 * name — then calls the real, unchanged parseVendorOor against that
 * resolved sheet name (so the actual data parse reads the same sheet
 * validation just checked, instead of independently re-guessing a
 * hardcoded 'Vendor OOR' name and silently coming back with zero rows).
 * Each returned row is tagged with the source file name — needed for the
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
): Promise<VendorOorRowWithSource[]> {
  const { sheetName } = await resolveAndValidateSheet(filePath, fileName, VENDOR_OOR_SCHEMA);
  const rows = await parseVendorOor(filePath, sheetName);
  return rows.map((row) => ({ ...row, sourceFileName: fileName }));
}

export async function parseCraOorFileWithValidation(
  filePath: string,
  fileName: string,
): Promise<CraOorRowWithSource[]> {
  const { sheetName } = await resolveAndValidateSheet(filePath, fileName, CRA_OOR_SCHEMA);
  const rows = await parseCraOor(filePath, sheetName);
  return rows.map((row) => ({ ...row, sourceFileName: fileName }));
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
 * vendor pool. Throws immediately on the first file with a real problem —
 * never guesses a mapping or silently proceeds with a partially-wrong file.
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
