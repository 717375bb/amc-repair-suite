import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logging/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('quote');

const MARK_READ_TIMEOUT_MS = 60 * 1000;

export interface MarkReadResult {
  ok: boolean;
  alreadyRead: boolean;
  error: string | null;
}

/**
 * Marks ONE Outlook message read, by EntryID — the only mailbox mutation
 * in the Vendor Quote Writer.
 *
 * **Call this only after a genuinely verified-successful MXI write.** A
 * failed or skipped write must leave the message unread, so the
 * unread-only queue never silently loses work that still needs doing.
 * That ordering is enforced at the call site in quoteWriteRunner.ts.
 *
 * Never throws: a mailbox bookkeeping failure must not turn a real,
 * already-committed MXI write into a reported failure. The two outcomes
 * are recorded separately (`quote_writes.write_status` vs
 * `quote_writes.marked_read`) precisely so "the price landed but the email
 * didn't get flagged" stays visible as exactly that, rather than being
 * collapsed into a misleading overall failure.
 */
export async function markOutlookMailRead(entryId: string): Promise<MarkReadResult> {
  const scriptPath = path.join('scripts', 'mark-outlook-mail-read.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-EntryId', entryId];

  try {
    const { stdout } = await execFileAsync('powershell.exe', args, {
      timeout: MARK_READ_TIMEOUT_MS,
      windowsHide: true,
    });
    const parsed = parseEnvelope(stdout);
    if (!parsed) {
      return { ok: false, alreadyRead: false, error: `Unparseable response from mark-read script: ${stdout.slice(0, 300)}` };
    }
    if (!parsed.ok) {
      return { ok: false, alreadyRead: false, error: parsed.error ?? 'Unknown mark-read failure.' };
    }
    return { ok: true, alreadyRead: !!parsed.alreadyRead, error: null };
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    const parsed = parseEnvelope(e.stdout ?? '');
    const error = parsed?.error ?? e.message ?? 'Unknown error invoking the mark-read script.';
    log.warn({ entryId, error }, '[outlook] could not mark message read');
    return { ok: false, alreadyRead: false, error };
  }
}

interface MarkReadEnvelope {
  ok: boolean;
  alreadyRead?: boolean;
  error?: string;
  subject?: string;
}

function parseEnvelope(stdout: string): MarkReadEnvelope | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as MarkReadEnvelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}
