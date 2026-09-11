import { isValid, parse, parseISO } from 'date-fns';

const CANDIDATE_FORMATS = [
  'yyyy-MM-dd',
  'M/d/yyyy',
  'MM/dd/yyyy',
  'M.d.yyyy',
  'MM.dd.yyyy',
  'M-d-yyyy',
  'MMMM d, yyyy',
  'MMM d, yyyy',
];

/**
 * REAL BUG FOUND AND FIXED (2026-09-10) — cleanCell() (parsers/cellUtils.ts)
 * converts a Date-typed Excel cell via `.toISOString()`, which ExcelJS
 * always builds at UTC MIDNIGHT for that calendar date (Excel dates carry
 * no timezone of their own) — e.g. a cell showing "September 2" becomes
 * the string "2026-09-02T00:00:00.000Z". parseISO() correctly treats that
 * "Z" as a genuine UTC instant, and every later date-fns call in this
 * pipeline (addDays, formatISO, differenceInCalendarDays) works in LOCAL
 * time — so in any timezone behind UTC (every US timezone), that instant
 * falls on the PREVIOUS calendar day locally. Reproduced directly:
 * parseISO("2026-09-02T00:00:00.000Z") in America/New_York returns Sept 1
 * at 20:00 local, and formatISO(..., {representation:'date'}) on that
 * then reads "2026-09-01" — the vendor's own stated RO ESD, silently
 * shifted one day earlier, on every single run (not intermittent, since
 * the offset is always negative for a US server). This is what an analyst
 * reported as "the ESD finder is setting ESDs to one day earlier than
 * what the vendor is giving."
 *
 * This exact synthetic shape (midnight UTC) never carries real timezone
 * meaning — it is purely a serialization artifact of a date-only Excel
 * cell — so it's stripped to a bare date before parsing, which parseISO
 * already correctly treats as LOCAL midnight (the same safe handling a
 * bare "2026-09-02" from the AI provider already gets). Deliberately
 * narrow: only an EXACT "T00:00:00[.0+]Z" suffix is stripped, so a string
 * that genuinely carries a non-midnight time is left untouched.
 */
const EXCEL_MIDNIGHT_UTC_PATTERN = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/;

/**
 * Best-effort date parser for the *structured* RO ESD field (Step 1) and for
 * ISO dates returned by the AI provider (Step 2/3). This is NOT used to
 * regex-extract dates out of free-text Notes fields — that's the AI's job.
 */
export function parseFlexibleDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const excelMidnightUtcMatch = trimmed.match(EXCEL_MIDNIGHT_UTC_PATTERN);
  const isoAttempt = parseISO(excelMidnightUtcMatch ? excelMidnightUtcMatch[1] : trimmed);
  if (isValid(isoAttempt)) return isoAttempt;

  for (const fmt of CANDIDATE_FORMATS) {
    const attempt = parse(trimmed, fmt, new Date());
    if (isValid(attempt)) return attempt;
  }

  const nativeAttempt = new Date(trimmed);
  if (!Number.isNaN(nativeAttempt.getTime())) return nativeAttempt;

  return null;
}
