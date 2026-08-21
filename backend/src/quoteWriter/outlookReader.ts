import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';
import type { OutlookReadEnvelope, OutlookReadResult } from './types.js';

const execFileAsync = promisify(execFile);

const log = createLogger('quote');

/** Outlook COM on a 9k-item folder is not fast; generous but bounded. */
const READ_TIMEOUT_MS = 5 * 60 * 1000;
/** PowerShell writes one compact JSON line, but attachment lists can be long. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ReadOutlookQuotesOptions {
  /** Backslash path relative to the mailbox root, e.g. "psa_CRA\\Quotes". */
  folderPath: string;
  /** Where PDFs get staged. Defaults to data/quote-attachments. */
  outDir?: string;
  maxMessages?: number;
  /** 0 (default) = no date limit. */
  sinceDays?: number;
}

export class OutlookReadError extends Error {}

/**
 * Reads PDF attachments out of one Outlook folder by shelling out to
 * scripts/read-outlook-quotes.ps1.
 *
 * `execFile` with an argument ARRAY and no shell — deliberately, not
 * `exec` with an interpolated string. Folder names here legitimately
 * contain spaces ("OOR Replies") and this repo has already been bitten by
 * Windows shell quoting; passing argv directly removes the entire class of
 * problem. Same approach as output/writeToolOutputFlags.ts.
 *
 * Read-only: the underlying script contains no Move/Delete/Save/UnRead
 * assignment at all. Marking mail read is a separate script, called only
 * after a verified-successful MXI write.
 */
export async function readOutlookQuotes(
  options: ReadOutlookQuotesOptions,
): Promise<OutlookReadResult> {
  const outDir = options.outDir ?? path.join('data', 'quote-attachments');
  const scriptPath = path.join('scripts', 'read-outlook-quotes.ps1');

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-FolderPath',
    options.folderPath,
    '-OutDir',
    outDir,
    '-MaxMessages',
    String(options.maxMessages ?? 200),
    '-SinceDays',
    String(options.sinceDays ?? 0),
  ];

  log.info({ folderPath: options.folderPath, outDir }, '[outlook] reading quote folder');

  let stdout: string;
  try {
    const result = await execFileAsync('powershell.exe', args, {
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (err) {
    // The script deliberately still prints its {ok:false,error} envelope on
    // stdout before exiting non-zero, so prefer that real, specific message
    // (e.g. "folder 'Quotes' not found ... Available there: ...") over the
    // generic "Command failed" execFile throws.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const parsed = tryParseEnvelope(e.stdout ?? '');
    if (parsed && !parsed.ok) {
      throw new OutlookReadError(parsed.error);
    }
    throw new OutlookReadError(
      `Outlook read script failed: ${e.message ?? 'unknown error'}${e.stderr ? ` | stderr: ${e.stderr.trim()}` : ''}`,
    );
  }

  const envelope = tryParseEnvelope(stdout);
  if (!envelope) {
    throw new OutlookReadError(
      `Outlook read script produced no parseable JSON envelope. Raw stdout: ${stdout.slice(0, 500)}`,
    );
  }
  if (!envelope.ok) {
    throw new OutlookReadError(envelope.error);
  }

  log.info(
    {
      folderPath: envelope.folderPath,
      scannedCount: envelope.scannedCount,
      messagesWithPdf: envelope.messages.length,
    },
    '[outlook] read complete',
  );
  return envelope;
}

/**
 * The script reserves stdout for exactly one JSON line, but PowerShell
 * hosts have been known to prepend banner/progress noise — scan for the
 * last parseable JSON line rather than assuming stdout is pristine.
 */
function tryParseEnvelope(stdout: string): OutlookReadEnvelope | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as OutlookReadEnvelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return parsed;
    } catch {
      // keep scanning older lines
    }
  }
  return null;
}
