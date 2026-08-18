import { format, parseISO } from 'date-fns';

/**
 * esd_inferences.inferred_esd is stored as ISO (YYYY-MM-DD, see
 * applyInferenceRules.ts). Every verified MXI write, though, goes into a
 * field that expects DD-MMM-YYYY (e.g. "10-JUN-2026" — confirmed against
 * real stage MXI throughout Phase 2c). Passing the raw ISO string straight
 * through would silently write a wrongly-formatted value; convert here,
 * once, shared by every call site that reads the DB value directly (the
 * CLI smoke tests already take their date argument pre-formatted).
 */
export function toMxiDateFormat(isoDate: string): string {
  return format(parseISO(isoDate), 'dd-MMM-yyyy').toUpperCase();
}

/**
 * Builds the ONE NEW entry to append to Notes to Receiver — never the full
 * field value (see EsdAndNotesUpdate's noteText docstring; updateNoteToReceiver
 * combines this with whatever's already there).
 *
 * Base format is "M.D.YY - Vendor Notes", confirmed against real examples
 * found on real stage orders during Part B research (not the original
 * "text then date" assumption, which was wrong) — e.g. real entries like
 * "2.16.26 - BER APPROVED..." and "5.21.2026 - Parts shortage...". Some
 * real examples used a 4-digit year or slashes instead of dots, but
 * M.D.YY-with-dots was the clearer, more common pattern across the
 * multi-word examples found, so that's what's used here.
 *
 * CLAUDE_CODE_PROMPT (ESD writer changes, A1) — per explicit user
 * direction, when `pushedEsd` is supplied the note states it inline:
 * "M.D.YY - ESD: DD-MMM-YYYY, Vendor Notes". `pushedEsd` must be the
 * already-pushed ISO date (InferenceRecord.inferredEsd /
 * esd_inferences.inferred_esd — extracted date + buffer, computed once in
 * applyInferenceRules.ts) — never the raw/unpushed date, and never
 * re-derived here. Formatted with the same toMxiDateFormat() used for the
 * ESD field write itself, so the note and the field always read the same
 * date in the same shape. Omit pushedEsd (or pass null/undefined) for the
 * note-only path (A4) — the ESD field was never touched, so the note never
 * mentions one: "M.D.YY - Vendor Notes", unchanged from before.
 *
 * If Vendor Notes is blank/empty, returns null so the caller skips the
 * Notes to Receiver write entirely — a date-only entry with no actual
 * content isn't worth adding to the log.
 */
export function assembleNoteText(vendorNotes: string | null, pushedEsd?: string | null): string | null {
  if (!vendorNotes || !vendorNotes.trim()) return null;
  const today = format(new Date(), 'M.d.yy');
  const esdSegment = pushedEsd ? `ESD: ${toMxiDateFormat(pushedEsd)}, ` : '';
  return `${today} - ${esdSegment}${vendorNotes}`;
}
