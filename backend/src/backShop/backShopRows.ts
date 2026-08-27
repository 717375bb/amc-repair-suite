/**
 * The daily back-shop listing: which rows are candidates for an in-house
 * scrap run, and which have already been handled.
 *
 * Pure and separately tested. Scrapping is irreversible and NOT idempotent
 * (see writeInHouseScrap), so the decision to put a row in front of an
 * analyst as selectable is worth verifying in `npm test` rather than only
 * ever observing on a live sheet.
 */

export interface BackShopRow {
  /** Column C. */
  partNumber: string;
  /** Column D. Includes BN-prefixed values, e.g. "BN 397172". */
  serialNumber: string;
  /** Column B — for display only. */
  partName: string | null;
  /** Column E — who it's assigned to, used by the CRA filter. */
  cra: string | null;
  /** Column F — free text, verbatim. Never normalised away: it is the evidence a human reads. */
  status: string | null;
  /** Column L, e.g. "QRO/USSTG". */
  location: string | null;
  /** Column N. */
  workPackageNo: string | null;
  /** 1-based row in the sheet, so a problem row can be pointed at directly. */
  sheetRow: number;
}

export type BackShopEligibility =
  /** Nothing in Status suggests it has been handled — goes on to the MXI check. */
  | 'open'
  /** Status already refers to scrapping or sending for scrap. Never auto-selected. */
  | 'already_handled';

/**
 * Status values that mean "this row's scrap has already been dealt with".
 *
 * Deliberately broad, and deliberately NOT limited to the word "SCRAPPED".
 * Real values on the live sheet include:
 *   "SCRAPPED"                  — done
 *   "Sent to QRO for scrap"     — gone elsewhere to be scrapped
 *   "transfer qro scrap 8/1"    — a transfer for scrap, already arranged
 * All three mean the same thing for our purposes: scrapping it again here
 * would be a second, irreversible action on a part someone has already
 * dispositioned. Over-excluding costs a part not being scrapped today, which
 * the analyst can see and act on; under-excluding costs a double scrap.
 * Those are not symmetric, so this errs toward excluding.
 */
const HANDLED_STATUS = /\bscrap(p(ed|ing))?\b/i;

/** Whether a row's Status marks it as already dealt with. */
export function eligibilityOf(row: Pick<BackShopRow, 'status'>): BackShopEligibility {
  if (!row.status) return 'open';
  return HANDLED_STATUS.test(row.status) ? 'already_handled' : 'open';
}

/**
 * Why a row was excluded, in the analyst's words rather than ours — the
 * verbatim Status is the whole justification, so it is quoted rather than
 * summarised.
 */
export function exclusionReason(row: Pick<BackShopRow, 'status'>): string {
  return `Sheet Status already reads "${(row.status ?? '').trim()}" — not offered again.`;
}

export interface SplitRows {
  open: BackShopRow[];
  alreadyHandled: BackShopRow[];
}

/** Splits a parsed sheet into what to check in MXI and what to leave alone. */
export function splitByEligibility(rows: readonly BackShopRow[]): SplitRows {
  const open: BackShopRow[] = [];
  const alreadyHandled: BackShopRow[] = [];
  for (const row of rows) {
    (eligibilityOf(row) === 'open' ? open : alreadyHandled).push(row);
  }
  return { open, alreadyHandled };
}

/** Every distinct CRA on the sheet, sorted, for the filter control. */
export function craOptions(rows: readonly BackShopRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const cra = row.cra?.trim();
    if (cra) seen.add(cra);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface SheetFreshness {
  /** The date in A1, as written. Null when it holds no readable date. */
  sheetDate: Date | null;
  isToday: boolean;
  /** Analyst-facing warning, null when the sheet is today's. */
  warning: string | null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** DD-MMM-YYYY, the shape every other date in this suite is rendered in. */
function formatDay(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Judges whether the "Today" sheet is actually today's.
 *
 * Per explicit user choice this WARNS rather than blocks: a sheet updated
 * late in the day is a normal thing, and refusing to run would be worse
 * than saying so plainly. But running yesterday's list would scrap the
 * wrong parts, so it can never pass silently — an unreadable date is
 * treated as a warning too, not as "probably fine".
 */
export function judgeFreshness(sheetDate: Date | null, now: Date = new Date()): SheetFreshness {
  if (!sheetDate || Number.isNaN(sheetDate.getTime())) {
    return {
      sheetDate: null,
      isToday: false,
      warning: 'Could not read a date from cell A1, so it is unknown whether this is today\'s list. Check before running.',
    };
  }
  if (sameCalendarDay(sheetDate, now)) return { sheetDate, isToday: true, warning: null };
  return {
    sheetDate,
    isToday: false,
    warning:
      `This sheet is dated ${formatDay(sheetDate)}, not today ` +
      `(${formatDay(now)}). Confirm it is the list you mean before running.`,
  };
}
