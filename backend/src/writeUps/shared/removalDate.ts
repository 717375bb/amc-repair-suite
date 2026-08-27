/**
 * Picking a part's removal date out of its event history.
 *
 * WHY THIS EXISTS (2026-08-27, explicit user direction): Aerotron requires
 * the Note To Vendor to carry "Removal date: DD-MMM-YYYY" above the times
 * and cycles table.
 *
 * THE RULE THAT MATTERS: "the 'event date' being parsed is not necessarily
 * the most recent, but rather the most recent one with 'removal' in its
 * name." A part's history holds installations, inspections and transfers
 * too, and the newest of those is frequently NOT the removal. Sorting by
 * date alone would pick confidently and wrongly.
 *
 * Pure and separately tested — this text goes to a vendor on a real order.
 */

/** The literal wording, per the user. */
export const REMOVAL_DATE_LABEL = 'Removal date:';

/**
 * Written when the history was read successfully but genuinely holds no
 * removal event, per explicit user choice ("write it with a placeholder").
 *
 * This is ONLY correct for a confirmed-empty history. A failure to READ the
 * history is a different thing entirely and must never land here — see
 * readRemovalDate's caller, which fails the line instead. Otherwise a
 * broken selector would quietly put "(not found)" on every note.
 */
export const REMOVAL_DATE_NOT_FOUND = '(not found)';

export interface HistoryEvent {
  /** The event's name cell, e.g. "Removal of BATTERY, APU (...)". */
  name: string;
  /** The event's date cell, e.g. "27-AUG-2026 00:37 EDT". */
  rawDate: string;
}

export interface PickedRemovalEvent {
  event: HistoryEvent;
  /** Just the DD-MMM-YYYY portion, which is what the note carries. */
  formatted: string;
  /** Parsed date, used for ordering. */
  at: Date;
}

/**
 * MXI renders event dates as "27-AUG-2026 00:37 EDT" — already in the
 * DD-MMM-YYYY shape the note wants, so the date portion is taken verbatim
 * rather than reformatted through a date library. That avoids a timezone
 * round-trip changing the calendar day, which is a real risk with a
 * 00:37 EDT timestamp.
 */
const DATE_TOKEN = /\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/;

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
});

/**
 * The DD-MMM-YYYY portion of an MXI date cell, uppercased, or null if the
 * cell carries no such token.
 *
 * Zero-pads the day: MXI has been seen to render both "7-AUG-2026" and
 * "07-AUG-2026", and the note should be consistent.
 */
export function formatRemovalDate(rawDate: string | null | undefined): string | null {
  if (!rawDate) return null;
  const match = rawDate.match(DATE_TOKEN);
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  return `${day}-${match[2].toUpperCase()}-${match[3]}`;
}

/** Parses an MXI date cell to a Date for ordering, or null. */
function parseEventDate(rawDate: string): Date | null {
  const match = rawDate.match(DATE_TOKEN);
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  if (month === undefined) return null;
  // Local midnight. Only used for ORDERING between events, never rendered —
  // the rendered value comes from formatRemovalDate, straight off the page.
  return new Date(Number(match[3]), month, Number(match[1]));
}

/** Whole-word "removal", case-insensitive, anywhere in the event name. */
function isRemovalEvent(name: string): boolean {
  return /\bremoval\b/i.test(name);
}

/**
 * The most recent event whose NAME contains "removal", or null if the
 * history holds none.
 *
 * Ties (two removals on the same calendar day) resolve to the one that
 * appears FIRST in the supplied order. MXI renders this table newest-first,
 * so first-wins keeps the newer of two same-day events — and the caller
 * passes rows in page order for exactly that reason.
 */
export function pickMostRecentRemovalEvent(events: readonly HistoryEvent[]): PickedRemovalEvent | null {
  let best: PickedRemovalEvent | null = null;

  for (const event of events) {
    if (!isRemovalEvent(event.name)) continue;
    const at = parseEventDate(event.rawDate);
    const formatted = formatRemovalDate(event.rawDate);
    if (!at || !formatted) continue; // a removal row with no readable date tells us nothing
    if (best === null || at.getTime() > best.at.getTime()) {
      best = { event, formatted, at };
    }
  }

  return best;
}

/**
 * The line the note carries, given whatever the history yielded.
 *
 * Takes the already-picked value rather than the events, so the caller can
 * distinguish "read the history, found no removal" (placeholder) from
 * "could not read the history at all" (a fault it must not paper over).
 */
export function composeRemovalDateLine(formattedDate: string | null): string {
  return `${REMOVAL_DATE_LABEL} ${formattedDate ?? REMOVAL_DATE_NOT_FOUND}`;
}
