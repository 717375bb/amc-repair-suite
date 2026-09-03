/**
 * Verifying that a Notes to Receiver write actually landed.
 *
 * REAL BUG THIS EXISTS TO FIX (found 2026-08-28). The verification in
 * writeEsdAndNotes compared the re-read field to an exact string:
 *
 *   expected = `${previousNote}\n\n${newEntry}`      // history, then new
 *
 * But updateNoteToReceiver writes the opposite order:
 *
 *   combined = `${newEntry}\n\n${previousNote}`      // new, then history
 *
 * The write order was changed on 2026-08-24 (commit 752d764) so the newest
 * entry sits at the top; the verification was never updated to match. From
 * that day on, every note write against an order that already had a note
 * compared against a string that could not occur, so:
 *
 *   1. every such order was reported FAILED even though the write worked;
 *   2. the "ESD ok, note missing" self-heal then fired and appended the
 *      SAME entry a second time, putting a real duplicate into a real
 *      order, before failing anyway.
 *
 * The deeper mistake was byte-exact comparison of an accumulating log.
 * Even with the order corrected it would stay fragile: the field is read
 * back with innerText (which reflows whitespace), the log grows over time,
 * and any prior entry's formatting differing by a single space would fail
 * the whole check.
 *
 * So this verifies the two things that are actually true of a correct
 * write, in either order and whatever the surrounding formatting:
 *   - the new entry is present;
 *   - everything that was there before is still there.
 *
 * Pure and unit-tested, because it is the failsafe that decides whether a
 * real order is reported as written.
 */

export interface NoteVerification {
  /** The new entry is present in the re-read field. */
  entryPresent: boolean;
  /** Everything that was in the field beforehand is still there. */
  historyPreserved: boolean;
  /**
   * How many times the new entry appears. More than one means a duplicate
   * was written — worth reporting, but it does NOT mean the write failed.
   */
  occurrences: number;
  /** Analyst-facing reasons, empty when everything checks out. */
  problems: string[];
}

/**
 * Collapses the differences that carry no meaning here: MXI renders the
 * field with `&nbsp;` and reflows line breaks, so a value written with
 * "\n\n" comes back read differently without anything having changed.
 */
export function normaliseNoteText(text: string | null | undefined): string {
  return (text ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Judges a Notes to Receiver write from what is actually on the page.
 *
 * `previousNote` is the value read immediately before writing (null/empty
 * when the field was blank), `newEntry` is the single entry that was added,
 * and `confirmedNote` is what the field reads afterwards.
 */
export function verifyNoteWrite(
  previousNote: string | null,
  newEntry: string,
  confirmedNote: string | null,
): NoteVerification {
  const confirmed = normaliseNoteText(confirmedNote);
  const entry = normaliseNoteText(newEntry);
  const previous = normaliseNoteText(previousNote);

  const problems: string[] = [];

  const entryPresent = entry.length > 0 && confirmed.includes(entry);
  if (!entryPresent) {
    problems.push(
      `The new note entry is not in the field after writing. Expected to find ${JSON.stringify(entry.slice(0, 120))}, ` +
        `field reads ${JSON.stringify(confirmed.slice(0, 200)) || '(blank)'}`,
    );
  }

  // A field that was blank before has no history to preserve, so this is
  // trivially true rather than vacuously suspicious.
  const historyPreserved = previous.length === 0 || confirmed.includes(previous);
  if (!historyPreserved) {
    problems.push(
      `Prior note history is missing after writing — the field no longer contains what it held before. ` +
        `Previous content began ${JSON.stringify(previous.slice(0, 120))}`,
    );
  }

  const occurrences = countOccurrences(confirmed, entry);

  return { entryPresent, historyPreserved, occurrences, problems };
}
