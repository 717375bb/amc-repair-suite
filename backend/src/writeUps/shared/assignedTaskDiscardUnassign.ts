import type { Page } from 'playwright';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * The assigned-task type this rule applies to — distinct from
 * UNASSIGNED_TASK_IGNORED_TYPES' own 'DISCARD - DS/DIS' entry
 * (unassignedTasks.ts), which governs a task of this same type sitting on
 * the UNASSIGNED Tasks sub-tab (always skipped, no conditions). This
 * module is for the same task type when it's already ASSIGNED — there, per
 * explicit user direction, it's conditionally unassigned based on Usage
 * Remaining.
 */
export const ASSIGNED_TASK_DISCARD_TYPE = 'DISCARD - DS/DIS';

/** Per explicit user direction: unassign only when Usage Remaining is OVER this many cycles. */
export const USAGE_REMAINING_UNASSIGN_THRESHOLD_CYCLES = 1000;

export interface AssignedDiscardTaskRow {
  /** 0-based index into the page's own `input[name="aTask"]` NodeList on this (Assigned Tasks) area. */
  rowIndex: number;
  rowText: string;
  /** null when the row's own text doesn't match the confirmed "<number> CYCLES" shape — never a guessed number. */
  usageRemainingCycles: number | null;
}

/**
 * Confirmed from discovery-task-unassigning-recording.ts: a real assigned
 * DISCARD - DS/DIS row's own rendered text reads
 * "...DISCARD - DS/DIS SL   LOW 39286 CYCLES N/A N/A" — the Usage
 * Remaining cycles value sits immediately before the literal word
 * "CYCLES". Deliberately narrow (only this exact "<number> CYCLES" shape)
 * rather than "first number in the row" — only confirmed against this one
 * example, and a wrong number here decides a real MXI unassign.
 */
function parseUsageRemainingCycles(rowText: string): number | null {
  const match = rowText.match(/(\d+)\s+CYCLES\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Scans the Assigned Tasks area (landed on immediately after opening a
 * part's repair link — see readAssignedTasksAreaText's own docblock,
 * taskRecovery.ts) for rows whose task type is DISCARD - DS/DIS, after
 * clicking "Collapse All" so every row is present in one flat read.
 *
 * Reuses the same td.shortString task-type-cell convention as
 * readUnassignedTaskCandidates (unassignedTasks.ts) — not independently
 * reconfirmed against this specific (assigned, not unassigned) grid, so an
 * unexpected cell class here returns 0 rows rather than a wrong match.
 *
 * Deliberately does NOT replicate the recording's own "click the row's
 * CYCLES N/A link, read a cell inside the resulting dialog, Close" detour
 * — that dialog's own clicked cell value (39286) is the exact same number
 * already present in the row's own text (see parseUsageRemainingCycles
 * above), so this reads it directly from the row instead of opening a
 * dialog whose link name ("CYCLES N/A") is only confirmed for one N/A-
 * placeholder case and isn't confirmed to generalize to other rows.
 */
export async function readAssignedDiscardTaskRows(page: Page): Promise<AssignedDiscardTaskRow[]> {
  await page.getByRole('link', { name: 'Collapse All' }).click();
  await pace(page);

  const rawRows = await page.evaluate((discardType: string) => {
    const checkboxes = Array.from(document.querySelectorAll('input[name="aTask"]')) as HTMLInputElement[];
    return checkboxes
      .map((cb, i) => {
        const tr = cb.closest('tr');
        const typeCellTexts = tr
          ? Array.from(tr.querySelectorAll('td.shortString')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
          : [];
        const rowText = (tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { rowIndex: i, rowText, isDiscard: typeCellTexts.includes(discardType) };
      })
      .filter((r) => r.isDiscard);
  }, ASSIGNED_TASK_DISCARD_TYPE);

  const rows: AssignedDiscardTaskRow[] = rawRows.map((r) => ({
    rowIndex: r.rowIndex,
    rowText: r.rowText,
    usageRemainingCycles: parseUsageRemainingCycles(r.rowText),
  }));

  log.info(
    { discardRowCount: rows.length, rows },
    '[assigned-task-discard] scanned Assigned Tasks area for DISCARD - DS/DIS rows',
  );
  return rows;
}

/** True only when a real, parsed Usage Remaining value exceeds the threshold — never on a null (unparsed) read. */
export function shouldUnassignForUsageRemaining(usageRemainingCycles: number | null): boolean {
  return usageRemainingCycles !== null && usageRemainingCycles > USAGE_REMAINING_UNASSIGN_THRESHOLD_CYCLES;
}

/**
 * Checks the row's own aTask checkbox, clicks "Unassign Tasks and Faults",
 * then dismisses the resulting "Close" link — the confirmed real mechanism
 * from discovery-task-unassigning-recording.ts. Caller must have already
 * decided (via shouldUnassignForUsageRemaining) that this specific row
 * should be unassigned, and is responsible for independently
 * re-verifying afterward — same discipline as assignUnassignedTask's own
 * callers (unassignedTasks.ts).
 */
export async function unassignDiscardTaskRow(page: Page, rowIndex: number): Promise<void> {
  await page.locator('input[name="aTask"]').nth(rowIndex).check();
  await pace(page);
  await page.getByRole('link', { name: 'Unassign Tasks and Faults' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * Full per-line step: scan the Assigned Tasks area for DISCARD - DS/DIS
 * rows and unassign every one whose Usage Remaining exceeds the threshold.
 * Rows with an unparsed (null) Usage Remaining are logged and left
 * assigned — never unassigned on an inconclusive read. Returns what it did
 * for audit purposes; callers decide whether/how to surface this.
 */
export interface AssignedDiscardUnassignResult {
  discardRowsFound: number;
  rowsUnassigned: AssignedDiscardTaskRow[];
  rowsSkippedInconclusive: AssignedDiscardTaskRow[];
  rowsUnderThreshold: AssignedDiscardTaskRow[];
}

export async function processAssignedDiscardTasks(page: Page): Promise<AssignedDiscardUnassignResult> {
  const rows = await readAssignedDiscardTaskRows(page);
  const result: AssignedDiscardUnassignResult = {
    discardRowsFound: rows.length,
    rowsUnassigned: [],
    rowsSkippedInconclusive: [],
    rowsUnderThreshold: [],
  };

  if (rows.length === 0) {
    return result;
  }

  // Unassigning a row shifts every later aTask checkbox index on the page,
  // so rows are processed highest rowIndex first and each unassign is
  // followed by a fresh scan rather than trusting stale indices.
  const sortedDescending = [...rows].sort((a, b) => b.rowIndex - a.rowIndex);
  for (const row of sortedDescending) {
    if (row.usageRemainingCycles === null) {
      log.warn(
        { rowText: row.rowText },
        '[assigned-task-discard] DISCARD - DS/DIS row found but Usage Remaining could not be parsed — leaving assigned rather than guessing',
      );
      result.rowsSkippedInconclusive.push(row);
      continue;
    }
    if (!shouldUnassignForUsageRemaining(row.usageRemainingCycles)) {
      result.rowsUnderThreshold.push(row);
      continue;
    }

    // Re-locate this row by content rather than trusting rowIndex, since a
    // prior iteration's unassign in this same loop can have changed the
    // checkbox ordering.
    const freshRows = await readAssignedDiscardTaskRows(page);
    const fresh = freshRows.find((r) => r.rowText === row.rowText && r.usageRemainingCycles === row.usageRemainingCycles);
    if (!fresh) {
      log.warn(
        { rowText: row.rowText },
        '[assigned-task-discard] row no longer found after a prior unassign in this pass — skipping rather than guessing an index',
      );
      result.rowsSkippedInconclusive.push(row);
      continue;
    }

    log.info(
      { rowText: fresh.rowText, usageRemainingCycles: fresh.usageRemainingCycles },
      '[assigned-task-discard] unassigning DISCARD - DS/DIS row (Usage Remaining over threshold)',
    );
    await unassignDiscardTaskRow(page, fresh.rowIndex);
    result.rowsUnassigned.push(fresh);
  }

  return result;
}
