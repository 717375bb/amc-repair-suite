import type { Page } from 'playwright';
import type { MxiClient } from './mxiClient.js';
import {
  attemptCancelEdit,
  confirmEsdLineEdit,
  findOrderByNumber,
  navigateToOrder,
  readEsdField,
  readNoteToReceiver,
  reissueOrder,
  updateEsdField,
  updateNoteToReceiver,
} from './selectors.js';

export interface EsdAndNotesUpdate {
  esd?: string;
  /**
   * Just the ONE NEW entry to add (e.g. "7.9.26 - some vendor note"), not
   * the full field value. Notes to Receiver is an accumulating log on real
   * orders (confirmed from real examples, see selectors.ts's
   * updateNoteToReceiver) — this is appended to whatever's already there,
   * never overwrites it.
   */
  noteText?: string;
}

export interface WriteEsdAndNotesResult {
  status: 'success' | 'failed';
  errorMessage: string | null;
}

interface VerifyResult {
  esdOk: boolean;
  noteOk: boolean;
  problems: string[];
}

/**
 * Combined write: within one edit session, updates the ESD field if a new
 * value is pending, updates Notes to Receiver if text is pending, then
 * reissues once — a single Issue Order + confirmation covers both, since
 * "Issue Order" is a top-level RO Details action shared by both edit paths
 * (see selectors.ts's architecture note above confirmEsdLineEdit/
 * reissueOrder). If only one of the two is pending, this still goes
 * through this same single function rather than the caller branching into
 * two separate paths — the branching lives in here, once.
 *
 * Supersedes writeEsd.ts's writeEsd(): calling this with only `esd` set is
 * behaviorally identical (same selectors, same order of operations), so
 * there's no separate "ESD-only" orchestration function anymore — one
 * combined function, two optional fields.
 *
 * Same call-site discipline as before: only called from an explicit,
 * human-specified-order-number action (server.ts's /approve handler, and
 * the `npm run mxi:write-esd` CLI smoke test). Never automatic/unattended.
 *
 * **Always independently re-verifies the real outcome, regardless of
 * whether the attempt itself threw.** This was originally only true on
 * the success path — a real, since-fixed gap. A real 40-order batch run
 * found that the `confirmEsdLineEdit` "YES" step can time out and throw
 * (reported as failure) while the ESD field had actually already
 * committed correctly server-side, with the Notes to Receiver step never
 * reached at all (the exception fires before that code runs). A caller
 * trusting the thrown exception alone would wrongly conclude nothing
 * happened. Now: verification always runs against the real page state
 * after any attempt (success or exception), and if it finds exactly that
 * pattern — ESD correct, note missing — it makes ONE follow-up attempt at
 * just the notes step before giving up, so a genuine `success` result
 * means both parts you asked for are actually correct, not "no exception
 * was thrown."
 */
export async function writeEsdAndNotes(
  client: MxiClient,
  orderNumber: string,
  update: EsdAndNotesUpdate,
): Promise<WriteEsdAndNotesResult> {
  if (!update.esd && !update.noteText) {
    return { status: 'success', errorMessage: null };
  }

  let page: Page | undefined;
  let previousNote: string | null = null;
  let caughtError: string | null = null;

  try {
    page = await client.getAuthenticatedPage();

    if (update.esd) {
      await findOrderByNumber(page, orderNumber, client.todoListUrl);
      await updateEsdField(page, update.esd);
      await confirmEsdLineEdit(page);
    } else {
      await navigateToOrder(page, orderNumber, client.todoListUrl);
    }

    if (update.noteText) {
      const result = await updateNoteToReceiver(page, update.noteText);
      previousNote = result.previousNote;
    }

    await reissueOrder(page);
  } catch (err) {
    caughtError = err instanceof Error ? err.message : String(err);
    if (page) {
      await attemptCancelEdit(page);
    }
    // Deliberately don't return here — verify what actually happened
    // before concluding anything, per the discipline above.
  }

  if (!page) {
    return { status: 'failed', errorMessage: caughtError ?? 'MXI client was never initialized.' };
  }

  const verify = async (): Promise<VerifyResult> => {
    let esdOk = true;
    let noteOk = true;
    const problems: string[] = [];

    if (update.esd) {
      try {
        await findOrderByNumber(page!, orderNumber, client.todoListUrl);
        const confirmedEsd = await readEsdField(page!);
        esdOk = confirmedEsd === update.esd;
        if (!esdOk) {
          problems.push(`ESD re-read as "${confirmedEsd ?? '(blank)'}", expected "${update.esd}"`);
        }
      } catch (verifyErr) {
        esdOk = false;
        problems.push(`ESD verification itself failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
      }
    }

    if (update.noteText) {
      try {
        await navigateToOrder(page!, orderNumber, client.todoListUrl);
        const confirmedNote = await readNoteToReceiver(page!);
        const expectedNote = previousNote ? `${previousNote}\n\n${update.noteText}` : update.noteText;
        noteOk = confirmedNote === expectedNote;
        if (!noteOk) {
          problems.push(`Note re-read as "${confirmedNote ?? '(blank)'}", expected "${expectedNote}"`);
        }
      } catch (verifyErr) {
        noteOk = false;
        problems.push(`Note verification itself failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
      }
    }

    return { esdOk, noteOk, problems };
  };

  let { esdOk, noteOk, problems } = await verify();

  // The exact pattern confirmed at real scale: ESD silently committed,
  // Notes to Receiver never ran. Self-heal with one notes-only follow-up
  // (esd omitted, so it can't touch the already-correct field) rather than
  // handing the caller a "failure" that actually just needs the note
  // appended.
  if (esdOk && !noteOk && update.noteText) {
    try {
      await updateNoteToReceiver(page, update.noteText);
      await reissueOrder(page);
      const recheck = await verify();
      esdOk = recheck.esdOk;
      noteOk = recheck.noteOk;
      problems = recheck.noteOk ? [] : [...problems, 'Follow-up notes-only attempt also did not land', ...recheck.problems];
    } catch (followUpErr) {
      problems.push(
        `Follow-up notes-only attempt threw: ${followUpErr instanceof Error ? followUpErr.message : String(followUpErr)}`,
      );
      if (page) {
        await attemptCancelEdit(page);
      }
    }
  }

  if (esdOk && noteOk) {
    return { status: 'success', errorMessage: null };
  }

  const prefix = caughtError ? `Attempt threw: ${caughtError}. ` : '';
  return { status: 'failed', errorMessage: `${prefix}${problems.join('; ')}` };
}
