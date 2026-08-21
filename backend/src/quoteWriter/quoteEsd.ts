import { addDays, formatISO, isBefore, startOfDay } from 'date-fns';
import { parseFlexibleDate } from '../inference/dateUtils.js';
import type { QuoteExtractionResult } from './extractionTypes.js';

/**
 * Days added to a quote's own stated Estimated Completion Date.
 *
 * Per explicit user direction (2026-08-21): quotes that carry an estimated
 * completion date get that date + 10. Confirmed against real mail — in the
 * live Quotes folder this is exactly the Barfield "Work Order Quote"
 * template sent by one rep (Brennan Rowland, 18 of the 20 most recent
 * quote emails); no other sender's quotes carry the field at all.
 */
export const QUOTE_COMPLETION_DATE_BUFFER_DAYS = 10;

/**
 * Days added to TODAY when a quote states no usable completion date at
 * all — the common case (per explicit user direction, 2026-08-21).
 *
 * Anchored on today rather than the quote's own date, deliberately and per
 * that same direction: a quote may sit in the folder for a while before
 * being processed, and anchoring on the quote date would silently produce
 * a shorter (or already-past) window the longer it waits.
 */
export const QUOTE_NO_DATE_BUFFER_DAYS = 14;

export type QuoteEsdBasis =
  /** Quote stated an estimated completion date; +10 applied. */
  | 'completion_date_plus_10'
  /** No usable date on the quote; today +14. */
  | 'today_plus_14'
  /** Quote stated a turnaround in DAYS rather than a date — never yet seen in real data. */
  | 'lead_time_days_from_today'
  /** Completion date present but still in the past even after +10; fell back to today +14. */
  | 'stale_completion_date_fallback';

export interface QuoteEsdResolution {
  /** ISO date (YYYY-MM-DD) to write into MXI. Never in the past. */
  esd: string;
  basis: QuoteEsdBasis;
  /**
   * True when a human should look before this is written, even though an
   * ESD was still computed. Never a silent auto-write on an odd case.
   */
  needsReview: boolean;
  /** Plain-English explanation, surfaced in the review UI. */
  explanation: string;
}

/**
 * Turns an extracted quote into the ESD that should actually be written.
 *
 * Deliberately keyed on the PRESENCE of a completion date rather than on
 * the sender's name or email address. That matches the user's stated rule
 * exactly (only Brennan Rowland's quotes carry the field), but is more
 * robust than matching on identity: it keeps working if he changes email
 * address, and it correctly does NOT fire for his colleague Ana Garcia at
 * the same @barfieldinc.com domain, whose quotes genuinely lack the field.
 * If a new sender ever starts including one, `needsReview` surfaces it
 * rather than silently absorbing a case nobody has validated.
 *
 * Guarantees the result is never in the past — the same Step 4 discipline
 * as applyInferenceRules.ts, where a stale ESD is treated as worse than
 * admitting we don't have one.
 */
export function resolveQuoteEsd(
  extraction: Pick<QuoteExtractionResult, 'promisedShipDate' | 'leadTimeDays'>,
  today: Date = new Date(),
): QuoteEsdResolution {
  const todayStart = startOfDay(today);
  const fallbackEsd = formatISO(addDays(todayStart, QUOTE_NO_DATE_BUFFER_DAYS), { representation: 'date' });

  const completion = parseFlexibleDate(extraction.promisedShipDate);
  if (completion) {
    const candidate = addDays(startOfDay(completion), QUOTE_COMPLETION_DATE_BUFFER_DAYS);
    if (isBefore(candidate, todayStart)) {
      return {
        esd: fallbackEsd,
        basis: 'stale_completion_date_fallback',
        needsReview: true,
        explanation:
          `Quote's estimated completion date (${extraction.promisedShipDate}) is old enough that even ` +
          `+${QUOTE_COMPLETION_DATE_BUFFER_DAYS} days is still in the past. Fell back to today ` +
          `+${QUOTE_NO_DATE_BUFFER_DAYS} days rather than writing a stale date.`,
      };
    }
    return {
      esd: formatISO(candidate, { representation: 'date' }),
      basis: 'completion_date_plus_10',
      needsReview: false,
      explanation:
        `Quote states estimated completion ${extraction.promisedShipDate}; ` +
        `+${QUOTE_COMPLETION_DATE_BUFFER_DAYS} days applied.`,
    };
  }

  // Unobserved in real data so far: a quote expressing turnaround in days
  // instead of a date. Uses the stated number rather than discarding real
  // information, but flags for review because no real example has ever
  // been validated end to end.
  if (typeof extraction.leadTimeDays === 'number' && extraction.leadTimeDays > 0) {
    return {
      esd: formatISO(addDays(todayStart, extraction.leadTimeDays), { representation: 'date' }),
      basis: 'lead_time_days_from_today',
      needsReview: true,
      explanation:
        `Quote states a ${extraction.leadTimeDays}-day turnaround rather than a completion date. ` +
        `Applied from today. No real quote has used this form before — worth a check.`,
    };
  }

  return {
    esd: fallbackEsd,
    basis: 'today_plus_14',
    needsReview: false,
    explanation: `Quote states no usable completion date; today +${QUOTE_NO_DATE_BUFFER_DAYS} days applied.`,
  };
}
