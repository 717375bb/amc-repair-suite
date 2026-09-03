/**
 * Deciding whether a part's note recommends scrapping it.
 *
 * Pure and separately tested. This decides which parts are put in front of
 * an analyst PRE-SELECTED for an irreversible, non-idempotent action, so it
 * is worth pinning in `npm test` rather than only ever observing live.
 */

export type ScrapRecommendation =
  /** The note says scrap. Offered pre-selected, with the note quoted as the reason. */
  | 'scrap_recommended'
  /**
   * The note mentions scrapping only to say NOT to. Listed with the
   * non-scrap parts, never pre-selected, but called out distinctly so the
   * analyst can see the note spoke to scrapping and said no.
   */
  | 'scrap_negated'
  /** A note may exist, but it does not say scrap. Listed separately, never pre-selected. */
  | 'no_scrap_note';

/**
 * TWO REAL FALSE POSITIVES THE PROBES CAUGHT (2026-08-27), before any of
 * this ran for real:
 *
 *  1. Every INVENTORY details page contains "scrap", because the action bar
 *     carries a "Scrap Inventory" button.
 *  2. Every PART details page contains "scrap", because the Reliability
 *     section states a "Scrap Rate: 100%".
 *
 * Either one would have marked the entire back-shop list scrap-recommended.
 * The fix is scope, not cleverness: only the part note cell (#idCellPartNote,
 * read by readPartScrapNote) is ever searched. The word test below is not
 * what makes this safe — the scoping is.
 *
 * DELIBERATELY NARROW, and it stays that way (2026-08-27). Broadening this
 * to conclusion-words that imply a scrap without saying it — BER, NREP,
 * NON-REP, non-repairable — was built and then REVERTED on the analyst's
 * instruction, because scrapping is permanent and those words appear on
 * parts that are not to be scrapped. Against the real live list that
 * broadening moved 5 more parts into the pre-selected set, including three
 * serials of WE3876352-1 whose note is about test-only handling and
 * pricing. Only an explicit "scrap" counts here; anything softer is a
 * judgement for the analyst reading the quoted note, not for this function.
 */
const SCRAP_WORD = /\bscrap\w*\b/i;

/** Collapses MXI's `&nbsp;`, `<br>`-derived newlines and layout whitespace. */
export function normaliseNote(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ScrapJudgement {
  recommendation: ScrapRecommendation;
  /**
   * The note, verbatim, so the analyst confirms against MXI's own words
   * rather than our summary of them. Null when nothing matched.
   */
  evidence: string | null;
}

/**
 * REAL FALSE POSITIVE CAUGHT ON LIVE DATA (2026-08-27), before this was
 * wired to anything: part GG436-2004-1MT's note reads "In review for bench
 * test with MeasureTech. Repairs do not scrap. 07/27" — it mentions
 * scrapping only to forbid it, and a bare word match pre-selected it for an
 * irreversible scrap.
 *
 * Negation is judged per occurrence and within a CLAUSE, not across the
 * whole note, because real notes routinely contain an unrelated "not"
 * nearby. Part DK120's note is the case that pins the window:
 *
 *   "...OEM DOES NOT WANT THIS SENT IN. SCRAP IN-HOUSE."
 *
 * That is a genuine scrap instruction. A whole-note or wide-window negation
 * check would suppress it and silently drop a part that should be scrapped.
 * So: look back only to the previous sentence boundary, and only a few words.
 */
const CLAUSE_BOUNDARY = /[.!?;*]/;
const NEGATORS = new Set(['not', 'dont', 'doesnt', 'didnt', 'never', 'no', 'nor', 'cannot', 'cant', 'wont']);
const NEGATION_LOOKBACK_WORDS = 3;

/** Whether this particular occurrence of the word is being forbidden. */
function occurrenceIsNegated(note: string, matchIndex: number): boolean {
  const before = note.slice(0, matchIndex);
  const boundary = before.split('').reverse().findIndex((ch) => CLAUSE_BOUNDARY.test(ch));
  const clause = boundary === -1 ? before : before.slice(before.length - boundary);
  const words = clause
    .toLowerCase()
    // Apostrophes are stripped rather than treated as separators, so
    // "don't" stays one word. Splitting on them first turned it into
    // "don" + "t" and let a real negation through.
    .replace(/['’]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean)
    .slice(-NEGATION_LOOKBACK_WORDS);
  return words.some((w) => NEGATORS.has(w));
}

/**
 * Whether a part's note recommends a scrap, and the words that say so.
 *
 * A note counts as recommending if ANY occurrence of the word is not
 * negated — a note that says both "do not scrap" and "scrap in-house" is
 * genuinely contradictory and belongs in front of a human as a candidate
 * with its full text quoted, rather than being resolved silently either way.
 */
export function judgeScrapNote(rawNote: string | null | undefined): ScrapJudgement {
  const note = normaliseNote(rawNote);

  let sawOccurrence = false;
  let sawAffirmative = false;
  const scan = new RegExp(SCRAP_WORD.source, 'gi');
  for (let m = scan.exec(note); m !== null; m = scan.exec(note)) {
    sawOccurrence = true;
    if (!occurrenceIsNegated(note, m.index)) sawAffirmative = true;
  }

  if (sawAffirmative) return { recommendation: 'scrap_recommended', evidence: note };
  if (sawOccurrence) return { recommendation: 'scrap_negated', evidence: note };
  return { recommendation: 'no_scrap_note', evidence: null };
}

/** What to show beside a part that was not recommended, in MXI's words. */
export function noScrapNoteReason(rawNote: string | null | undefined): string {
  const note = normaliseNote(rawNote);
  if (!note) return 'No part note in MXI at all.';
  if (judgeScrapNote(note).recommendation === 'scrap_negated') {
    return `Note says NOT to scrap: "${note.slice(0, 200)}"`;
  }
  return `Note present but does not mention scrap: "${note.slice(0, 200)}"`;
}
