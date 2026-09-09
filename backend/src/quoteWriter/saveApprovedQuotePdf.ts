import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';

const log = createLogger('quote');

/**
 * CLAUDE_CODE_PROMPT (approved-quote PDF archive, 2026-09-09) — per
 * explicit user direction: "upload each PDF quote when it is approved and
 * written into the new folder in amc-repair-suite\backend called 'Quotes'."
 *
 * Relative to the backend process's own working directory (same base every
 * other relative path in this runner uses, e.g. `path.join('data',
 * 'audit.db')`) — resolves to the real `backend/Quotes/` folder, not a
 * second nested one.
 */
export const APPROVED_QUOTES_DIR = 'Quotes';

/**
 * Copies the quote's already-saved source PDF (staged at ingest time under
 * `data/quote-attachments/`, path recorded in `quote_extractions.saved_path`)
 * into `backend/Quotes/` — called ONLY after a real, verified-successful
 * MXI write (see quoteWriteRunner.ts's own `result.status === 'success'`
 * gate), mirroring this project's standing rule that mail is marked read
 * (and a vendor reply sent) only after the same condition. An approval
 * that never actually wrote must not leave a PDF sitting in the approved
 * folder implying otherwise.
 *
 * Keeps the source file's own basename (already unique — the EntryID
 * prefix baked in at ingest time, see read-outlook-quotes.ps1) rather than
 * inventing a new naming scheme. Never throws: a copy failure is a real
 * problem worth logging and surfacing, but it must not be reported as an
 * MXI write failure — the write itself already succeeded by the time this
 * runs, and that's the fact that actually matters for the audit trail.
 */
export async function saveApprovedQuotePdf(sourcePath: string | null, orderNumber: string): Promise<{ ok: boolean; destPath: string | null; error: string | null }> {
  if (!sourcePath) {
    return { ok: false, destPath: null, error: 'No source PDF path recorded for this quote.' };
  }

  const destPath = path.join(APPROVED_QUOTES_DIR, path.basename(sourcePath));
  try {
    await fs.mkdir(APPROVED_QUOTES_DIR, { recursive: true });
    await fs.copyFile(sourcePath, destPath);
    log.info({ orderNumber, sourcePath, destPath }, '[quote] approved quote PDF copied to Quotes/');
    return { ok: true, destPath, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ orderNumber, sourcePath, destPath, error }, '[quote] could not copy approved quote PDF into Quotes/ — the MXI write itself still succeeded');
    return { ok: false, destPath: null, error };
  }
}
