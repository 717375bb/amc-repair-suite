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
 * REAL BUG FOUND AND FIXED (2026-08-19): this used to return null whenever
 * Vendor Notes was blank/empty, REGARDLESS of pushedEsd — so an order with
 * a genuine pushed ESD but no vendor commentary got no Notes to Receiver
 * entry at all, silently. Per explicit user direction: the note must still
 * be written whenever an ESD is being pushed, vendor commentary or not —
 * "ESD: DD-MMM-YYYY" alone is a real, useful log entry on its own. Only
 * returns null when there's truly nothing to say (no notes AND no pushed
 * ESD) — the original one-empty-write's-not-worth-it rationale still holds
 * for that case, just not for "blank notes but a real ESD".
 */
export function assembleNoteText(vendorNotes: string | null, pushedEsd?: string | null): string | null {
  const trimmedNotes = vendorNotes?.trim() || null;
  if (!trimmedNotes && !pushedEsd) return null;
  const today = format(new Date(), 'M.d.yy');
  const esdSegment = pushedEsd ? `ESD: ${toMxiDateFormat(pushedEsd)}` : null;
  const body = esdSegment && trimmedNotes ? `${esdSegment}, ${trimmedNotes}` : (esdSegment ?? trimmedNotes);
  return `${today} - ${body}`;
}
