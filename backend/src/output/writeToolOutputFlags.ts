import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { format } from 'date-fns';
import type { InferenceRecord } from '../types.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WriteOutcomeByOrder {
  [orderNumber: string]: {
    status: 'success' | 'failed' | 'partial' | 'not_found' | 'rejected';
    errorMessage?: string;
    /** Only meaningful when status is 'partial' — what specifically didn't land (e.g. "Notes to Receiver"). */
    partialDetail?: string;
  };
}

export interface WriteToolOutputFlagsResult {
  summary: string;
  backupPath: string;
  hasRealMacros: boolean;
  updated: number;
  notFound: string[];
}

interface FlagTemplate {
  automationFlag: string;
  flagNote: string;
  suggestedAction: string;
}

/**
 * The 7 fixed templates from the original spec, plus an 8th
 * ("Partially Updated") added after a real 40-order Part C run found a
 * genuine third outcome the original success/failure model had no room
 * for: `writeEsdAndNotes` can report failure while the ESD field silently
 * committed correctly anyway, with the Notes to Receiver append skipped
 * (the exception fires before that code runs) — confirmed live on
 * `P000AY70`/`P000B2YT`, not hypothetical. Calling that "Updated" hides
 * that the note never landed; calling it "Write Failed" hides that the
 * field that matters most is actually correct. Neither was honest, hence
 * the new category.
 */
function selectTemplate(
  record: InferenceRecord,
  outcome:
    | {
        status: 'success' | 'failed' | 'partial' | 'not_found' | 'rejected';
        errorMessage?: string;
        partialDetail?: string;
      }
    | undefined,
): FlagTemplate | null {
  // Orphaned rows never appear in the Output sheet at all — its own FILTER()
  // formula only includes Vendor OOR rows with a matching CRA OOR row — so
  // there's no row here to touch.
  if (record.flag === 'orphaned_vendor_row' || record.flag === 'orphaned_cra_row') {
    return null;
  }

  if (record.flag === 'ok') {
    if (!outcome) {
      return {
        automationFlag: 'Pending Review',
        flagNote: `ESD inferred as ${record.inferredEsd} (${record.classification}, confidence ${record.confidence}).`,
        suggestedAction: 'Review and approve for MXI update.',
      };
    }
    if (outcome.status === 'rejected') {
      // From the original Part C spec's "n" case — never reached until
      // now, since every human-reviewed order in the first real run was
      // approved. Never calls writeEsdAndNotes; recorded purely as a
      // decision.
      return {
        automationFlag: 'Rejected by CRA',
        flagNote: `Inferred ESD ${record.inferredEsd} not approved.`,
        suggestedAction: 'Manually review and update if needed.',
      };
    }
    if (outcome.status === 'success') {
      const today = format(new Date(), 'dd-MMM-yyyy').toUpperCase();
      return {
        automationFlag: 'Updated',
        flagNote: `ESD updated to ${record.inferredEsd} in MXI on ${today}.`,
        suggestedAction: '',
      };
    }
    if (outcome.status === 'partial') {
      const today = format(new Date(), 'dd-MMM-yyyy').toUpperCase();
      return {
        automationFlag: 'Partially Updated',
        flagNote: `ESD updated to ${record.inferredEsd} in MXI on ${today}, but ${outcome.partialDetail ?? 'part of the write'} did not complete.`,
        suggestedAction: 'Verify manually and complete the remaining update if needed.',
      };
    }
    if (outcome.status === 'not_found') {
      // Distinct from a genuine write failure — confirmed via a fresh,
      // isolated session that the order simply doesn't exist in stage MXI
      // (a known stage/production data mismatch, not a system problem).
      // Worded so it doesn't read as something to investigate/retry.
      return {
        automationFlag: 'Not Found in Stage',
        flagNote: 'Order does not exist in stage MXI (confirmed directly) — a known stage/production data gap, not a write failure.',
        suggestedAction: 'No action needed here — expected for some orders not present in the stage sandbox.',
      };
    }
    return {
      automationFlag: 'Write Failed',
      flagNote: `Attempted to write ESD ${record.inferredEsd} to MXI but failed: ${outcome.errorMessage ?? 'unknown error'}.`,
      suggestedAction: 'Retry manually or investigate before re-running.',
    };
  }

  if (record.flag === 'no_esd_found') {
    if (record.classification === 'not_esd_relevant') {
      return {
        automationFlag: 'No ESD Found',
        flagNote: 'Date found refers to a scrap or shipment event, not a future ESD.',
        suggestedAction: 'Review manually — order may need closure or reconciliation rather than an ESD update.',
      };
    }
    if (record.classification === 'quote_sent_reference') {
      return {
        automationFlag: 'No ESD Found',
        flagNote: 'Vendor referenced a quote having been sent; no ESD date available yet.',
        suggestedAction: 'Follow up on quote status.',
      };
    }
    // A date-bearing classification with an extracted date, but flag ended
    // up no_esd_found anyway — the only way that happens (see
    // applyInferenceRules.ts's finalizeRecord) is Step 4's stale-date
    // rejection.
    const isDateBearingClassification =
      record.classification === 'explicit_date' ||
      record.classification === 'vendor_quote_estimate' ||
      record.classification === 'parts_pending';
    if (isDateBearingClassification && record.extractedBaseDate !== null) {
      return {
        automationFlag: 'No ESD Found',
        flagNote: 'Inferred date was in the past and was rejected as stale.',
        suggestedAction: 'Manually verify current status with vendor.',
      };
    }
    return {
      automationFlag: 'No ESD Found',
      flagNote: 'No date information found in vendor notes or current status.',
      suggestedAction: 'Contact vendor for a status update.',
    };
  }

  return null;
}

/**
 * Checks the workbook's raw zip contents for xl/vbaProject.bin — the real
 * signal for macro-enabled content, not the filename. Report-only at this
 * point: since write-back goes through real Excel via COM automation (see
 * write-tool-output-flags.ps1's docstring for why — a bare ExcelJS
 * round-trip was confirmed to corrupt this workbook's dynamic-array
 * formula metadata), a real macro project would be preserved correctly by
 * Excel's own Save() regardless. Still worth knowing and reporting.
 */
async function hasVbaProject(filePath: string): Promise<boolean> {
  const script = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead('${filePath.replace(/'/g, "''")}')
    $found = $null -ne ($zip.Entries | Where-Object { $_.FullName -eq 'xl/vbaProject.bin' })
    $zip.Dispose()
    Write-Output $found
  `;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]);
  return stdout.trim().toLowerCase() === 'true';
}

/**
 * Non-negotiable: copies the current file to a timestamped backup before
 * any write-back attempt, regardless of what else happens.
 */
async function createTimestampedBackup(filePath: string): Promise<string> {
  const backupDir = path.join('data', 'tool-backups');
  await fs.mkdir(backupDir, { recursive: true });

  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${base}-${timestamp}${ext}`);

  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

/**
 * Writes Automation Flag / Flag Note / Suggested Action into the live
 * tool's Output sheet — backup first, real Excel via COM automation for
 * the actual write (see write-tool-output-flags.ps1), only touching rows
 * for order numbers present in `records`. Never calls writeEsdAndNotes or
 * touches MXI — `writeOutcomes` lets a future step pass real per-order
 * write results in; omitted entries are treated as 'not yet attempted'.
 */
export async function writeToolOutputFlags(
  filePathArg: string,
  records: InferenceRecord[],
  writeOutcomes: WriteOutcomeByOrder = {},
): Promise<WriteToolOutputFlagsResult> {
  // Excel COM automation's Workbooks.Open() doesn't reliably resolve
  // relative paths against the calling process's working directory —
  // confirmed live (a relative path here failed with a COM "couldn't find
  // the file" error even though the file existed). Resolve once, up front.
  const filePath = path.resolve(filePathArg);

  const hasRealMacros = await hasVbaProject(filePath);
  const backupPath = await createTimestampedBackup(filePath);

  const rows = records
    .map((r) => {
      const template = selectTemplate(r, writeOutcomes[r.orderNumber]);
      if (!template) return null;
      return {
        orderNumber: r.orderNumber,
        automationFlag: template.automationFlag,
        flagNote: template.flagNote,
        suggestedAction: template.suggestedAction,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const tempJsonPath = path.join(os.tmpdir(), `tool-output-flags-${Date.now()}.json`);
  await fs.writeFile(tempJsonPath, JSON.stringify(rows), 'utf-8');

  const scriptPath = path.join(__dirname, '../../scripts/write-tool-output-flags.ps1');

  let stdout: string;
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-FilePath',
      filePath,
      '-DataJsonPath',
      tempJsonPath,
    ]);
    stdout = result.stdout;
  } finally {
    await fs.unlink(tempJsonPath).catch(() => {});
  }

  const updatedMatch = stdout.match(/RESULT_UPDATED=(\d+)/);
  const notFoundMatch = stdout.match(/RESULT_NOTFOUND=(.*)/);
  const updated = updatedMatch ? Number(updatedMatch[1]) : 0;
  const notFound = notFoundMatch && notFoundMatch[1].trim() ? notFoundMatch[1].trim().split(',') : [];

  const summary = [
    `Backup created: ${backupPath}`,
    `Real macros (xl/vbaProject.bin) present: ${hasRealMacros}`,
    `Rows updated in Output sheet: ${updated} of ${rows.length} candidates`,
    notFound.length > 0
      ? `Order numbers not found in Output sheet (not written): ${notFound.join(', ')}`
      : 'All candidate order numbers were found and updated.',
  ].join('\n');

  return { summary, backupPath, hasRealMacros, updated, notFound };
}
