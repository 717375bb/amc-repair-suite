import { differenceInCalendarDays, formatISO, parseISO, startOfDay } from 'date-fns';

/**
 * Deciding the YEAR for a vendor date that never stated one.
 *
 * REAL BUG THIS EXISTS TO FIX (found 2026-08-28). Real vendor notes write
 * EQDs as bare month/day — "EQD 8/26", "EQD 9/2", "EQD 8/28". The AI is
 * asked for an ISO date, so it has to supply a year, and it guessed: run 19
 * turned "EQD 7/21" into 2024-07-21 and "EQD 7/28" into 2024-07-28 — two
 * years in the past. The quote buffer was then applied correctly to a wrong
 * date, the result landed in the past, and Step 4 rejected it as stale. The
 * analyst saw "No ESD Found" on every EQD order and had no way to tell that
 * a year had been invented three layers down.
 *
 * The year is not a language-understanding problem, it is arithmetic, so it
 * belongs in code — the same rule that keeps the buffer constants out of
 * the prompt (see applyInferenceRules Step 3). The model reports what the
 * text says; this decides what it means.
 *
 * RULE (confirmed with the analyst, 2026-08-28): resolve a yearless date to
 * the NEAREST occurrence of that month/day — which may be slightly in the
 * past. An EQD from last week reads as last week, not as next year. A date
 * genuinely months old stays months old, and Step 4 will still reject the
 * stale result; that is correct, because a months-old EQD is not evidence
 * of a future ship date.
 */

/**
 * Whether the note itself states a year anywhere.
 *
 * Deliberately generous about what counts, because the cost of being wrong
 * is asymmetric: treating a year-bearing note as yearless could MOVE a date
 * the vendor actually gave, whereas leaving a yearless note alone just
 * preserves today's (already broken) behaviour for that one note.
 *
 * Counts as an explicit year:
 *   - a four-digit year anywhere      "EQD 8/26/2026", "due in 2026"
 *   - a numeric date with a 2-digit year   "8/26/26", "8-26-26"
 */
export function noteStatesAYear(noteText: string | null | undefined): boolean {
  const text = noteText ?? '';
  if (/\b(?:19|20)\d{2}\b/.test(text)) return true;
  // d/d/dd — the third group is what makes it a year rather than a bare M/D.
  if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2}\b/.test(text)) return true;
  return false;
}

/**
 * Re-anchors an ISO date's year to the nearest occurrence of its month/day.
 *
 * Considers last year, this year and next year and takes whichever falls
 * closest to today, so the answer is "nearest" in both directions rather
 * than "next upcoming" — that is what keeps a date from a few days ago
 * reading as a few days ago.
 */
export function resolveNearestYear(isoDate: string, today: Date): string {
  const parsed = parseISO(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;

  const todayStart = startOfDay(today);
  const month = parsed.getMonth();
  const day = parsed.getDate();

  let best: Date | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const year of [todayStart.getFullYear() - 1, todayStart.getFullYear(), todayStart.getFullYear() + 1]) {
    const candidate = new Date(year, month, day);
    // A Feb-29 month/day in a non-leap year rolls to Mar 1; skip it rather
    // than silently shifting the vendor's date by a day.
    if (candidate.getMonth() !== month || candidate.getDate() !== day) continue;
    const distance = Math.abs(differenceInCalendarDays(candidate, todayStart));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best ? formatISO(best, { representation: 'date' }) : isoDate;
}

export interface ResolvedDateYear {
  /** The ISO date to actually use. */
  iso: string;
  /** True when the year was replaced because the note never stated one. */
  reanchored: boolean;
  /** The year the model had supplied, when it was overridden. */
  originalIso: string | null;
}

/**
 * Applies the rule: trust the model's year when the note states one, decide
 * it here when the note does not.
 */
export function resolveExtractedDateYear(
  noteText: string | null | undefined,
  extractedIso: string | null,
  today: Date,
): ResolvedDateYear {
  if (!extractedIso) return { iso: '', reanchored: false, originalIso: null };
  if (noteStatesAYear(noteText)) return { iso: extractedIso, reanchored: false, originalIso: null };

  const resolved = resolveNearestYear(extractedIso, today);
  return {
    iso: resolved,
    reanchored: resolved !== extractedIso,
    originalIso: resolved !== extractedIso ? extractedIso : null,
  };
}
