import type { Page } from 'playwright';
import { readPartDetailsReceivingNotes } from '../writeUps/shared/partDetailsReceivingNotes.js';
import { PART_RECORD_URL_MARKER } from '../mxiWriter/openInventoryBySerial.js';

export type ReadNoteStatus =
  /** The part's Details tab was rendered and its note cell was read. Empty is a real answer. */
  | 'read'
  /** We were not on the part record at all. NOT an answer. */
  | 'unreadable';

export interface ReadPartNoteResult {
  status: ReadNoteStatus;
  /** The note text, or '' when the part genuinely has none. */
  note: string;
  error: string | null;
}

/**
 * Reads the part note off the PART record page the browser is already on
 * (openPartDetailsBySerial got us there).
 *
 * Reuses readPartDetailsReceivingNotes rather than re-implementing the
 * selector: `#idCellPartNote` is the same cell the vendor write-ups already
 * read, on the same PartDetails.jsp page, and it was corrected live once
 * already (2026-08-25). One definition, one place to fix.
 *
 * The status separates "read it, no note" from "could not read", on purpose:
 * an unreadable page returning an empty note would classify the part as
 * no-scrap-note and quietly drop it from the day's list — the silent-skip-
 * reported-as-a-clean-answer failure this project has hit repeatedly.
 */
export async function readPartScrapNote(page: Page): Promise<ReadPartNoteResult> {
  if (!page.url().includes(PART_RECORD_URL_MARKER)) {
    return {
      status: 'unreadable',
      note: '',
      error: `Not on a part details page (on "${page.url()}"), so no part note was read.`,
    };
  }

  // null means the note cell is genuinely absent for this part — a real
  // "no note", not a failure. Both collapse to '' for the judgement, which
  // treats absent and empty identically.
  const note = await readPartDetailsReceivingNotes(page);
  return { status: 'read', note: note ?? '', error: null };
}
