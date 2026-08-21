import { format, parseISO } from 'date-fns';
import { parseFlexibleDate } from '../inference/dateUtils.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('esd');

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
 * When `assumedEsd` is supplied the note states it inline:
 * "M.D.YY - ESD: DD-MMM-YYYY, Vendor Notes". Omit it (or pass
 * null/undefined) for the note-only path (A4) — no ESD was inferred at all,
 * so the note never mentions one: "M.D.YY - Vendor Notes".
 *
 * **CORRECTED 2026-08-20, per explicit user direction — this parameter's
 * MEANING changed, not just its formatting.** It used to be the *pushed*
 * ESD (`inferred_esd` — the buffered promised-by date actually written into
 * the MXI ESD field). That was built exactly as originally instructed, but
 * the instruction itself was a misunderstanding: the note is read by humans
 * who want the vendor's own **assumed/stated ESD**, not PSA's internal
 * padded ship date. So this is now `extracted_base_date` — the date the
 * vendor actually gave (or the AI extracted), BEFORE any buffer.
 *
 * Concretely, for a vendor-stated 8/24 the ESD field still gets 8/31
 * (+SHIPPING_BUFFER_DAYS = 7) exactly as before — only the note text
 * changes, and now reads "ESD: 24-AUG-2026". The relationship the user
 * described ("promised-by minus 7, or minus 14 for a quote date") holds by
 * construction for those two classifications, but this deliberately reads
 * the stored base date rather than subtracting a constant: `parts_pending`
 * rows use an AI-chosen 20-30 day offset (`bufferDaysApplied`), so
 * subtracting a fixed 7 or 14 would silently produce a wrong date on those.
 * The stored base date is correct for every classification.
 *
 * Parsed with `parseFlexibleDate`, NOT `toMxiDateFormat`'s strict
 * `parseISO`: unlike `inferred_esd` (always normalized via `formatISO` in
 * applyInferenceRules.ts), `extracted_base_date` on Step 2/3 rows is stored
 * as the raw string the AI returned, so it is not guaranteed to be strict
 * ISO on rows written before this change. Degrades gracefully — an
 * unparseable value logs a warning and writes the note without the ESD
 * segment, rather than throwing and losing the vendor commentary too.
 *
 * REAL BUG FOUND AND FIXED (2026-08-19): this used to return null whenever
 * Vendor Notes was blank/empty, REGARDLESS of the ESD argument — so an
 * order with a genuine ESD but no vendor commentary got no Notes to
 * Receiver entry at all, silently. The note must still be written whenever
 * an ESD exists, vendor commentary or not. Only returns null when there's
 * truly nothing to say (no notes AND no usable ESD).
 */
export function assembleNoteText(vendorNotes: string | null, assumedEsd?: string | null): string | null {
  const trimmedNotes = vendorNotes?.trim() || null;

  let esdSegment: string | null = null;
  if (assumedEsd) {
    const parsed = parseFlexibleDate(assumedEsd);
    if (parsed) {
      esdSegment = `ESD: ${format(parsed, 'dd-MMM-yyyy').toUpperCase()}`;
    } else {
      log.warn(
        { assumedEsd },
        '[esd-note] assumed ESD could not be parsed — writing the note without an ESD segment rather than failing the whole write',
      );
    }
  }

  if (!trimmedNotes && !esdSegment) return null;
  const today = format(new Date(), 'M.d.yy');
  const body = esdSegment && trimmedNotes ? `${esdSegment}, ${trimmedNotes}` : (esdSegment ?? trimmedNotes);
  return `${today} - ${body}`;
}
