import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only tracking file for the batch discovery workflow — created
 * fresh if it doesn't exist, new rows appended on every run, existing rows
 * never overwritten or cleared. Verified empirically (not assumed) that
 * ExcelJS's read-existing -> re-apply worksheet.columns -> addRow ->
 * writeFile pattern genuinely preserves prior rows across separate runs —
 * worksheet.columns' key->column mapping isn't itself persisted in the
 * xlsx file, so it must be re-applied every run even when the sheet
 * already exists, but doing so is idempotent (just re-writes the same
 * header text) and does not touch existing data rows.
 */

export interface ExceptionRow {
  partNumber: string;
  serialNumber: string;
  station: string;
  dateFound: string;
  issueType:
    | 'No Task Assigned'
    | 'Multiple Candidate Tasks'
    | 'Ad-Hoc Task Created - Pending Manual Continuation'
    | 'Unrecognized Station'
    // 'No Work Package (Bad From Stock)' RETIRED — Addition 1 (Create Work
    // Package) replaces it: a line with no work package now gets one
    // created automatically rather than being reported as a terminal
    // exception. See 'Work Package Created - Pending Manual Continuation'
    // below for the one real remaining pause (the one-time proof gate).
    | 'Work Package Created - Pending Manual Continuation'
    | 'No Longer Eligible (claimed by another process)'
    | 'Zero Usage - Records Error'
    | 'Unassigned Task Present'
    | 'Multiple Unassigned Tasks'
    | 'Unassigned Task Detection Suspect'
    | 'No Removal Task Info Found'
    | 'Order Created - DO NOT SHIP'
    | 'Automation Error';
  details: string;
  suggestedAction: string;
}

export interface CompletedRow {
  orderNumber: string;
  partNumber: string;
  serialNumber: string;
  station: string;
  routingDestination: string;
  date: string;
}

const EXCEPTIONS_SHEET = 'Exceptions';
const COMPLETED_SHEET = 'Completed';

const EXCEPTIONS_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Part Number', key: 'partNumber', width: 16 },
  { header: 'Serial/Batch Number', key: 'serialNumber', width: 24 },
  { header: 'Station', key: 'station', width: 10 },
  { header: 'Date Found', key: 'dateFound', width: 22 },
  { header: 'Issue Type', key: 'issueType', width: 22 },
  { header: 'Details', key: 'details', width: 55 },
  { header: 'Suggested Action', key: 'suggestedAction', width: 65 },
];

const COMPLETED_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Order Number', key: 'orderNumber', width: 16 },
  { header: 'Part Number', key: 'partNumber', width: 16 },
  { header: 'Serial/Batch Number', key: 'serialNumber', width: 24 },
  { header: 'Station', key: 'station', width: 10 },
  { header: 'Routing Destination', key: 'routingDestination', width: 24 },
  { header: 'Date', key: 'date', width: 22 },
];

async function loadOrCreateWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) {
    await workbook.xlsx.readFile(filePath);
  }

  let exceptionsSheet = workbook.getWorksheet(EXCEPTIONS_SHEET);
  if (!exceptionsSheet) exceptionsSheet = workbook.addWorksheet(EXCEPTIONS_SHEET);
  exceptionsSheet.columns = EXCEPTIONS_COLUMNS;
  exceptionsSheet.getRow(1).font = { bold: true };

  let completedSheet = workbook.getWorksheet(COMPLETED_SHEET);
  if (!completedSheet) completedSheet = workbook.addWorksheet(COMPLETED_SHEET);
  completedSheet.columns = COMPLETED_COLUMNS;
  completedSheet.getRow(1).font = { bold: true };

  return workbook;
}

/**
 * Appends the given rows to the tracking file, creating it (with both
 * sheets and headers) if it doesn't exist yet. Never clears or rewrites
 * existing rows — always adds at the end. Either array may be empty (a
 * read-only discovery pass with zero exceptions, or zero completions, is
 * legitimate and still worth a run record via the caller's own logging).
 */
export async function appendDiscoveryLogRows(
  filePath: string,
  rows: { exceptions: ExceptionRow[]; completed: CompletedRow[] },
): Promise<{ exceptionsAdded: number; completedAdded: number }> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const workbook = await loadOrCreateWorkbook(filePath);

  const exceptionsSheet = workbook.getWorksheet(EXCEPTIONS_SHEET)!;
  for (const row of rows.exceptions) {
    exceptionsSheet.addRow(row);
  }

  const completedSheet = workbook.getWorksheet(COMPLETED_SHEET)!;
  for (const row of rows.completed) {
    completedSheet.addRow(row);
  }

  await workbook.xlsx.writeFile(filePath);
  return { exceptionsAdded: rows.exceptions.length, completedAdded: rows.completed.length };
}
