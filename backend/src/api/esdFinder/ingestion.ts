import ExcelJS from 'exceljs';
import { CRA_OOR_HEADER_ALIASES, parseCraOor } from '../../parsers/craOorParser.js';
import { parseVendorOor } from '../../parsers/vendorOorParser.js';
import type { CraOorRow, VendorOorRow } from '../../types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('esd');

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

/**
 * CLAUDE_CODE_PROMPT (generalize open-order report parsing, 2026-09-09) —
 * per explicit user direction: not every vendor's export shares the same
 * column layout, but they largely carry the same underlying data, so a
 * file shouldn't be rejected outright just because it lacks a column this
 * project happens to also want. `Order Number` remains the one genuinely
 * CORE header — it's the literal join/skip key downstream (matchOrders.ts,
 * detectDuplicateOrderNumbers below, every parser's own row-skip check) —
 * every other header below is now RECOGNIZED but optional: still used to
 * (a) pick the right worksheet out of a multi-sheet workbook by content,
 * and (b) tell Vendor OOR apart from CRA OOR when a file could plausibly be
 * either, but a sheet missing some of them is now accepted with a
 * `missingHeaders` warning list instead of a hard MissingHeadersError.
 * Downstream, a field sourced from a header that wasn't on the sheet simply
 * comes back null from readSheetRows' get() — already-handled, nullable
 * behavior (see e.g. applyInferenceRules.ts treating a blank RO ESD as
 * "go to Step 2"), not new failure surface.
 */
export const CORE_REQUIRED_HEADER = 'Order Number';

export const VENDOR_OOR_RECOGNIZED_HEADERS = [
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

export const CRA_OOR_RECOGNIZED_HEADERS = [
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

// Back-compat aliases — kept exported under the old names too, since
// "recognized, mostly-optional" is a refinement of "required," not a
// different list, and nothing outside this module needs to know the name
// changed.
export const VENDOR_OOR_REQUIRED_HEADERS = VENDOR_OOR_RECOGNIZED_HEADERS;
export const CRA_OOR_REQUIRED_HEADERS = CRA_OOR_RECOGNIZED_HEADERS;

/**
 * Thrown only when a sheet has no usable `Order Number` column at all — the
 * one thing this pipeline genuinely cannot proceed without. `missingHeaders`
 * is kept as an array (rather than a single string) for API stability, but
 * today only ever contains `Order Number`; everything else missing is now a
 * warning, not a rejection — see `missingHeaders` on the parse results below.
 */
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
 * One known OOR shape — the recognized column list (used for sheet
 * disambiguation, not as a hard gate — see CORE_REQUIRED_HEADER) plus any
 * raw-header aliases that apply only to this shape (see
 * CRA_OOR_HEADER_ALIASES). headerAliases is intentionally empty for Vendor
 * OOR: its own "RO ESD" column is a different, legitimate field and must
 * never be aliased.
 */
interface OorSchema {
  role: 'vendor' | 'cra';
  recognizedHeaders: readonly string[];
  headerAliases: Readonly<Record<string, string>>;
}

const VENDOR_OOR_SCHEMA: OorSchema = {
  role: 'vendor',
  recognizedHeaders: VENDOR_OOR_RECOGNIZED_HEADERS,
  headerAliases: {},
};

const CRA_OOR_SCHEMA: OorSchema = {
  role: 'cra',
  recognizedHeaders: CRA_OOR_RECOGNIZED_HEADERS,
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
  return schema.recognizedHeaders.every((h) => aliased.has(h));
}

/** How many of a schema's recognized headers a sheet's (aliased) raw headers actually contain. */
function matchScore(rawHeaders: readonly string[], schema: OorSchema): number {
  const aliased = applyHeaderAliases(rawHeaders, schema.headerAliases);
  return schema.recognizedHeaders.filter((h) => aliased.has(h)).length;
}

function hasCoreHeader(rawHeaders: readonly string[], schema: OorSchema): boolean {
  const aliased = applyHeaderAliases(rawHeaders, schema.headerAliases);
  return aliased.has(CORE_REQUIRED_HEADER);
}

/**
 * Resolves which worksheet is the real data sheet for the given OOR schema,
 * and reports (never rejects on) whichever recognized headers it's missing
 * — replacing the old hardcoded getWorksheet('Vendor OOR') /
 * getWorksheet('CRA OOR') lookup, which failed silently (empty header set,
 * reported as "every column missing") the moment a real export used a
 * different sheet name. Real files have been seen using "VendorOrders"
 * instead of either nominal name (see #4a) — so sheet resolution is by
 * CONTENT, never by name, in three tiers:
 *
 * 1. A sheet whose (aliased) headers satisfy every recognized header for
 *    this schema — the old, exact-match behavior, unchanged, so an
 *    already-working file's resolution can never regress.
 * 2. Otherwise, among sheets that at least have CORE_REQUIRED_HEADER
 *    ("Order Number") and score at least as well against this schema as
 *    against the other known schema (so a CRA-shaped sheet is never
 *    silently accepted as Vendor OOR just because it happens to also have
 *    an Order Number column), the sheet with the highest recognized-header
 *    score wins — accepted, with its genuinely missing recognized headers
 *    returned as `missingHeaders` (a warning, not a throw; see the module
 *    docstring for why only Order Number is load-bearing here).
 * 3. If a sheet clearly matches the OTHER schema better (has Order Number,
 *    but scores higher there than here), that's reported as a specific
 *    "this looks like CRA OOR, not Vendor OOR" error rather than a flat
 *    wall of missing headers that reads like a totally malformed file.
 * 4. If literally no sheet has an Order Number column at all, throws
 *    MissingHeadersError — the one case this pipeline genuinely can't
 *    proceed without a human fixing the file first.
 */
async function resolveAndValidateSheet(
  filePath: string,
  fileName: string,
  schema: OorSchema,
): Promise<{ sheetName: string; missingHeaders: string[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheetsInfo = workbook.worksheets.map((sheet) => ({ name: sheet.name, rawHeaders: readRawHeaderRow(sheet) }));

  // TEMP DIAGNOSTIC — #4a, read-only, no behavior change. Always fires
  // before any resolution decision, so (unlike the old readRealHeaders(),
  // which returned early on a sheet-name miss) it never silently skips
  // printing just because nothing resolved.
  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    log.debug({ filePath, fileName, role: schema.role, recognizedHeaders: schema.recognizedHeaders }, '[diag-4a] resolveAndValidateSheet');
    for (const sheet of workbook.worksheets) {
      const rawHeaders = readRawHeaderRow(sheet);
      log.debug({ sheetName: sheet.name, rawHeaders }, '[diag-4a] sheet row 1 raw headers');
      for (let r = 2; r <= 3; r++) {
        const rowValues: unknown[] = [];
        sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => rowValues.push(cell.value));
        log.debug({ sheetName: sheet.name, row: r, rowValues }, '[diag-4a] row raw values');
      }
    }
  }

  if (sheetsInfo.length === 0) {
    throw new Error(
      `"${fileName}": could not resolve a header row — the workbook has no worksheets at all. ` +
        `Looking for (role "${schema.role}"): ${CORE_REQUIRED_HEADER} plus ideally ${schema.recognizedHeaders.join(', ')}.`,
    );
  }

  // Tier 1 — exact match against every recognized header, unchanged from
  // the original behavior so an already-working file's resolution can
  // never regress.
  const contentMatches = sheetsInfo.filter((s) => schemaMatches(s.rawHeaders, schema));

  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    if (contentMatches.length === 0) {
      log.debug({ role: schema.role }, '[diag-4a] no sheet matched role by full content');
    } else {
      log.debug(
        { role: schema.role, matchingSheetNames: contentMatches.map((s) => s.name) },
        '[diag-4a] sheet(s) fully matching role by content',
      );
      if (contentMatches.length > 1) {
        log.debug('[diag-4a] NOTE: more than one sheet matches — taking the first. Worth a closer look if this is unexpected.');
      }
    }
  }

  if (contentMatches.length > 0) {
    return { sheetName: contentMatches[0].name, missingHeaders: [] };
  }

  const otherSchema = KNOWN_OOR_SCHEMAS.find((s) => s.role !== schema.role)!;

  // Tier 2 — a sheet with Order Number, scoring at least as well against
  // THIS schema as against the other one, wins on its recognized-header
  // score even if it's missing some columns. Ties (including a 0-0 tie —
  // Order Number present, nothing else recognized either way) favor the
  // requested schema, since the caller explicitly asked to parse this file
  // in that role.
  const candidates = sheetsInfo
    .filter((s) => hasCoreHeader(s.rawHeaders, schema))
    .map((s) => ({ sheet: s, ownScore: matchScore(s.rawHeaders, schema), otherScore: matchScore(s.rawHeaders, otherSchema) }))
    .filter((c) => c.ownScore >= c.otherScore);

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.ownScore - a.ownScore);
    const best = candidates[0].sheet;
    const aliased = applyHeaderAliases(best.rawHeaders, schema.headerAliases);
    const missing = schema.recognizedHeaders.filter((h) => !aliased.has(h));
    if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
      log.debug(
        { role: schema.role, sheetName: best.name, missingHeaders: missing },
        '[diag-4a] accepted sheet missing some recognized (optional) headers',
      );
    }
    return { sheetName: best.name, missingHeaders: missing };
  }

  // Tier 3 — no sheet is a reasonable candidate for THIS schema. If some
  // sheet has Order Number and clearly matches the OTHER schema better,
  // say so specifically rather than reporting a flat wall of missing
  // headers that reads like a totally malformed file.
  const otherMatch = sheetsInfo
    .filter((s) => hasCoreHeader(s.rawHeaders, otherSchema))
    .map((s) => ({ sheet: s, otherScore: matchScore(s.rawHeaders, otherSchema), ownScore: matchScore(s.rawHeaders, schema) }))
    .filter((c) => c.otherScore > c.ownScore)
    .sort((a, b) => b.otherScore - a.otherScore)[0];

  if (otherMatch) {
    throw new Error(
      `"${fileName}": expected a ${schema.role.toUpperCase()} OOR file, but its headers match the ` +
        `${otherSchema.role.toUpperCase()} OOR schema instead (sheet "${otherMatch.sheet.name}"). ` +
        `Confirm this file was dropped in the correct spot.`,
    );
  }

  // Tier 4 — genuinely no sheet in the workbook has an Order Number column
  // for either role. This is the one thing this pipeline cannot proceed
  // without, so it's a real rejection, not a warning.
  if (process.env.ESD_FINDER_DEBUG_HEADERS === '1') {
    log.debug({ role: schema.role, sheetNames: sheetsInfo.map((s) => s.name) }, '[diag-4a] no sheet in the workbook has an Order Number column');
  }
  throw new MissingHeadersError(fileName, [CORE_REQUIRED_HEADER]);
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
): Promise<{ missingHeaders: string[] }> {
  const { missingHeaders } = await resolveAndValidateSheet(filePath, fileName, schemaForRole(role));
  return { missingHeaders };
}

export interface VendorOorRowWithSource extends VendorOorRow {
  sourceFileName: string;
}

export interface CraOorRowWithSource extends CraOorRow {
  sourceFileName: string;
}

/**
 * Validates that at least Order Number is present (rejecting with a
 * named-header error if not) and resolves the real sheet by content — never
 * a hardcoded name — then calls the real, unchanged parseVendorOor against
 * that resolved sheet name (so the actual data parse reads the same sheet
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
 *
 * `missingHeaders` on the return is the file's other recognized-but-optional
 * columns that weren't found — surfaced so a caller can warn the analyst
 * ("this file has no Vendor Notes column, so that field will be blank for
 * every row") rather than silently proceeding with no signal at all.
 */
export async function parseVendorOorFileWithValidation(
  filePath: string,
  fileName: string,
): Promise<{ rows: VendorOorRowWithSource[]; missingHeaders: string[] }> {
  const { sheetName, missingHeaders } = await resolveAndValidateSheet(filePath, fileName, VENDOR_OOR_SCHEMA);
  const rows = await parseVendorOor(filePath, sheetName);
  return { rows: rows.map((row) => ({ ...row, sourceFileName: fileName })), missingHeaders };
}

export async function parseCraOorFileWithValidation(
  filePath: string,
  fileName: string,
): Promise<{ rows: CraOorRowWithSource[]; missingHeaders: string[] }> {
  const { sheetName, missingHeaders } = await resolveAndValidateSheet(filePath, fileName, CRA_OOR_SCHEMA);
  const rows = await parseCraOor(filePath, sheetName);
  return { rows: rows.map((row) => ({ ...row, sourceFileName: fileName })), missingHeaders };
}

/**
 * State A's per-file preview: validates headers (rejecting immediately
 * with the same clear, named-header message as the full ingestion path if
 * the file has no usable Order Number column) and reports a row count and
 * any other recognized headers this file is missing, without running the
 * full comparison. Calls the same validated parsers as
 * ingestEsdFinderFiles — this is not a separate, lighter-weight parse path
 * that could disagree with the real one, just an early, single-file
 * preview of it.
 */
export async function peekEsdFinderFile(
  filePath: string,
  fileName: string,
  role: 'vendor' | 'cra',
): Promise<{ fileName: string; rowCount: number; missingHeaders: string[] }> {
  const { rows, missingHeaders } =
    role === 'vendor'
      ? await parseVendorOorFileWithValidation(filePath, fileName)
      : await parseCraOorFileWithValidation(filePath, fileName);
  return { fileName, rowCount: rows.length, missingHeaders };
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

export interface FileHeaderWarning {
  fileName: string;
  missingHeaders: string[];
}

export interface IngestedEsdFinderInput {
  vendorRows: VendorOorRowWithSource[];
  duplicates: DuplicateOrderNumber[];
  /**
   * CRA rows, present only when at least one CRA OOR file was uploaded —
   * see the CRA OPTIONAL RE-ADD note below. Empty when no CRA file was
   * given, which downstream (esdCompareRunner.ts) is what selects the
   * vendor-only path, unchanged from before this file was reintroduced.
   */
  craRows: CraOorRowWithSource[];
  /**
   * Per-file recognized-but-missing headers (task #6, 2026-09-09) — never
   * blocks ingestion, just tells the caller which fields will come back
   * null for that file's rows so it isn't a silent surprise.
   */
  headerWarnings: FileHeaderWarning[];
}

/**
 * Full ingestion: validates + parses every vendor file (concatenating their
 * rows into one pool, per the confirmed rule) and runs duplicate-order
 * detection over that pool. Throws immediately on the first file with a
 * real problem — never guesses a mapping or silently proceeds with a
 * partially-wrong file.
 *
 * CRA FILE REMOVED, THEN RE-ADDED AS OPTIONAL: originally required (so
 * vendor rows could be joined to it), then dropped entirely on 2026-08-26
 * since every field the inference actually read at the time (`roEsd`,
 * `currentStatus`, `vendorNotes`) came off the VENDOR row alone. Re-added
 * 2026-09-09, per explicit user direction, as an OPTIONAL upload: the
 * inference pipeline still needs nothing from it to function (vendor-only
 * behavior is byte-for-byte unchanged when `craFiles` is empty), but a CRA
 * file, when given, is now the source for a real current-MXI-ESD
 * comparison the ESD Finder review table can show (`MXI RO ESD` — see
 * esdCompareRunner.ts) without requiring a live per-row MXI read.
 */
export async function ingestEsdFinderFiles(
  vendorFiles: Array<{ filePath: string; fileName: string }>,
  craFiles: Array<{ filePath: string; fileName: string }> = [],
): Promise<IngestedEsdFinderInput> {
  const vendorResults = await Promise.all(vendorFiles.map((f) => parseVendorOorFileWithValidation(f.filePath, f.fileName)));
  const craResults = await Promise.all(craFiles.map((f) => parseCraOorFileWithValidation(f.filePath, f.fileName)));

  const vendorRows = vendorResults.flatMap((r) => r.rows);
  const craRows = craResults.flatMap((r) => r.rows);
  const duplicates = detectDuplicateOrderNumbers(vendorRows);

  const headerWarnings: FileHeaderWarning[] = [
    ...vendorResults.map((r, i) => ({ fileName: vendorFiles[i].fileName, missingHeaders: r.missingHeaders })),
    ...craResults.map((r, i) => ({ fileName: craFiles[i].fileName, missingHeaders: r.missingHeaders })),
  ].filter((w) => w.missingHeaders.length > 0);

  return { vendorRows, duplicates, craRows, headerWarnings };
}
