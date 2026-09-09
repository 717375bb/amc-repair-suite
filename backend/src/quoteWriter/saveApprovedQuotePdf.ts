import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';

const log = createLogger('quote');

/**
 * CLAUDE_CODE_PROMPT (approved-quote PDF archive, 2026-09-09; extended
 * 2026-09-10) - per explicit user direction: "upload each PDF quote when it
 * is approved and written into the new folder in amc-repair-suite\backend
 * called 'Quotes'", then: name it `<order number>.pdf`, never overwrite an
 * existing file (fall back to `(1)`, `(2)` ...), and file it into a
 * per-vendor subfolder.
 *
 * Relative to the backend process's own working directory, the same base
 * every other relative path in this runner uses (e.g. `path.join('data',
 * 'audit.db')`) - resolves to the real `backend/Quotes/`, not a nested one.
 */
export const APPROVED_QUOTES_DIR = 'Quotes';

/**
 * Where a quote with no extractable vendor name goes. This is not an edge
 * case: roughly a fifth of the real extractions in the live audit DB have
 * a null vendor_name, so these need a real home rather than being dropped
 * loose or, worse, filed under a folder literally named "null".
 */
export const UNSORTED_FOLDER = '_Unsorted';

/**
 * Windows-illegal filename characters, plus both path separators and the
 * ASCII control range.
 *
 * Deliberately does NOT include `-` or the space: real vendor names
 * contain both ("AK-STRUCTURES, LLC"), and stripping them would mangle the
 * folder name for no safety benefit.
 */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/g;

/** Reserved device names on Windows - a folder or file called any of these is not creatable. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Makes an arbitrary string safe to use as ONE path segment.
 *
 * This matters more than usual here: `vendor_name` is model-extracted free
 * text straight out of a vendor's PDF, so it is genuinely untrusted input
 * being turned into a filesystem path. Stripping separators and `..`
 * outright means a crafted or garbled value cannot escape the Quotes
 * folder, rather than relying on the caller to notice.
 *
 * Returns '' when nothing usable survives, so callers can fall back.
 */
export function sanitizePathSegment(raw: string | null | undefined): string {
  if (!raw) return '';
  // Control characters are illegal in Windows filenames. Filtered by code
  // point rather than a regex escape range, so this source file never
  // needs to contain a literal control character of its own.
  const printable = [...raw].filter((c) => c.charCodeAt(0) >= 32).join('');
  const cleaned = printable
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots and spaces on directory names,
    // which would make the folder we create and the folder we look for
    // disagree. "AeroRepair Corp." is a real vendor value that hits this.
    .replace(/[. ]+$/, '')
    // Leading dot-runs are what's left of a traversal attempt once the
    // separators above have been neutralized ("../../etc" -> ".. .. etc").
    // The traversal is already dead at that point — no separator survives,
    // so it is one segment and cannot climb — but a folder called
    // ".. .. etc" is a poor thing to create, so the residue goes too.
    .replace(/^[. ]+/, '')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  if (RESERVED_NAMES.has(cleaned.toUpperCase())) return `${cleaned}_`;
  // Leave room for the filename inside it; no real vendor name is close.
  return cleaned.slice(0, 100);
}

/**
 * Equivalence key for matching a vendor name against folders that already
 * exist. Case, punctuation and spacing are all discarded, because the real
 * extracted values differ in exactly those ways - the live DB holds
 * "Measure Tech", "MeasureTech" and "Measure Tech Inc." for one vendor.
 *
 * This does NOT try to unify genuinely different names (it won't merge
 * "AeroRepair Corp." into "AeroRepair South, LLC", and shouldn't - those
 * may be separate entities). It only stops the same name in different
 * dress from creating a second folder beside the first.
 */
export function vendorFolderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Picks the folder for this vendor: an existing one whose name is
 * equivalent, or a new one named after the vendor.
 *
 * Reusing an equivalent existing folder is what keeps the auto-create
 * behavior from fragmenting one vendor across three spellings. Whichever
 * folder already exists wins, including one the analyst created or renamed
 * by hand - the folder on disk is treated as the canonical spelling.
 */
async function resolveVendorFolder(vendorName: string | null): Promise<string> {
  const sanitized = sanitizePathSegment(vendorName);
  if (!sanitized) return UNSORTED_FOLDER;

  let existing: string[] = [];
  try {
    const entries = await fs.readdir(APPROVED_QUOTES_DIR, { withFileTypes: true });
    existing = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // Quotes/ not created yet - nothing to match against; the mkdir in the
    // caller creates the whole path.
  }

  const wanted = vendorFolderKey(sanitized);
  const match = existing.find((dir) => vendorFolderKey(dir) === wanted);
  return match ?? sanitized;
}

/**
 * `<base>.pdf`, or `<base> (1).pdf`, `<base> (2).pdf` ... if taken.
 *
 * Uses COPYFILE_EXCL rather than checking existence first: the check-then-
 * copy version has a real race (two quotes for the same order number
 * finishing at once would both see "free" and one would silently overwrite
 * the other), and EXCL makes the filesystem itself arbitrate. That is not
 * hypothetical here - the same order number legitimately appears on more
 * than one quote in the live data, which is exactly why the user asked for
 * the `(1)` behavior in the first place.
 */
async function copyWithoutOverwriting(sourcePath: string, dir: string, baseName: string): Promise<string> {
  const MAX_ATTEMPTS = 500;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = path.join(dir, i === 0 ? `${baseName}.pdf` : `${baseName} (${i}).pdf`);
    try {
      await fs.copyFile(sourcePath, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`Could not find a free filename for "${baseName}.pdf" in ${dir} after ${MAX_ATTEMPTS} attempts.`);
}

export interface SaveApprovedQuotePdfResult {
  ok: boolean;
  destPath: string | null;
  error: string | null;
}

/**
 * Copies the quote's already-saved source PDF (staged at ingest time under
 * `data/quote-attachments/`, path recorded in `quote_extractions.saved_path`)
 * into `backend/Quotes/<vendor>/<order number>.pdf` - called ONLY after a
 * real, verified-successful MXI write (see quoteWriteRunner.ts's own
 * `result.status === 'success'` gate), mirroring this project's standing
 * rule that mail is marked read, and a vendor reply sent, only after the
 * same condition. An approval that never actually wrote must not leave a
 * PDF sitting in the approved folder implying otherwise.
 *
 * Never throws: a copy failure is a real problem worth logging and
 * surfacing, but it must not be reported as an MXI write failure - the
 * write itself already succeeded by the time this runs, and that is the
 * fact that matters for the audit trail.
 */
export async function saveApprovedQuotePdf(
  sourcePath: string | null,
  orderNumber: string,
  vendorName: string | null = null,
): Promise<SaveApprovedQuotePdfResult> {
  if (!sourcePath) {
    return { ok: false, destPath: null, error: 'No source PDF path recorded for this quote.' };
  }

  // Order numbers in the live data are plain alphanumerics, but this is a
  // free-text column filled by an AI extraction, not a constrained one -
  // sanitizing costs nothing and keeps a garbled value from producing a
  // path instead of a filename.
  const baseName = sanitizePathSegment(orderNumber);
  if (!baseName) {
    return { ok: false, destPath: null, error: `Order number "${orderNumber}" left nothing usable as a filename.` };
  }

  try {
    const vendorFolder = await resolveVendorFolder(vendorName);
    const destDir = path.join(APPROVED_QUOTES_DIR, vendorFolder);
    await fs.mkdir(destDir, { recursive: true });
    const destPath = await copyWithoutOverwriting(sourcePath, destDir, baseName);
    log.info({ orderNumber, vendorName, sourcePath, destPath }, '[quote] approved quote PDF filed');
    return { ok: true, destPath, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(
      { orderNumber, vendorName, sourcePath, error },
      '[quote] could not file the approved quote PDF - the MXI write itself still succeeded',
    );
    return { ok: false, destPath: null, error };
  }
}
