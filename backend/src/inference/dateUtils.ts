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
 * Best-effort date parser for the *structured* RO ESD field (Step 1) and for
 * ISO dates returned by the AI provider (Step 2/3). This is NOT used to
 * regex-extract dates out of free-text Notes fields — that's the AI's job.
 */
export function parseFlexibleDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const isoAttempt = parseISO(trimmed);
  if (isValid(isoAttempt)) return isoAttempt;

  for (const fmt of CANDIDATE_FORMATS) {
    const attempt = parse(trimmed, fmt, new Date());
    if (isValid(attempt)) return attempt;
  }

  const nativeAttempt = new Date(trimmed);
  if (!Number.isNaN(nativeAttempt.getTime())) return nativeAttempt;

  return null;
}
