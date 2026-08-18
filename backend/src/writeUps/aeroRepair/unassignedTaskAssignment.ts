/// <reference lib="dom" />
import type { Page } from 'playwright';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

export interface UnassignedTaskRow {
  /** 0-based index into the page's `input[name="aTask"]` NodeList — used to target the right checkbox. */
  index: number;
  /** The row's own "Class" cell, if one exists in the same shape as the Task-Definition panel's own Class column. */
  taskClass: string;
  rowText: string;
}

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 3 — mirrors
 * readTaskDefinitionCandidates' (shared/taskRecovery.ts) confirmed PC
 * (Parts Card — administrative, never itself the repair task) exclusion.
 * That exclusion was confirmed against the Task Selection / "Blocks and
 * Requirements" panel specifically; the Unassigned Tasks table's own row
 * shape has not yet been confirmed to carry an equivalent standalone "PC"
 * Class cell. Read defensively: a row is only excluded when one of its own
 * `<td>` cells is EXACTLY "PC" (same shape already confirmed elsewhere in
 * this project) — never a fuzzy substring match, so a genuinely different
 * row is never accidentally excluded. Logs both the raw and post-filter
 * lists (per the explicit requirement), so the difference is auditable the
 * first time this actually filters something for real.
 */
export async function readUnassignedTaskCandidates(
  page: Page,
): Promise<{ raw: UnassignedTaskRow[]; filtered: UnassignedTaskRow[] }> {
  const raw = await page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('input[name="aTask"]')) as HTMLInputElement[];
    return checkboxes.map((cb, i) => {
      const tr = cb.closest('tr');
      const cellTexts = tr
        ? Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
        : [];
      const taskClass = cellTexts.find((c) => c === 'PC') ?? '';
      const rowText = (tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return { index: i, taskClass, rowText };
    });
  });

  const filtered = raw.filter((row) => row.taskClass !== 'PC');
  log.info({ candidateCount: raw.length, candidates: raw }, '[unassigned-task-assignment] raw candidates');
  log.info({ candidateCount: filtered.length, candidates: filtered }, '[unassigned-task-assignment] post-PC-filter candidates');
  return { raw, filtered };
}

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 1 — the confirmed real
 * mechanism from discovery-UnassignedTaskAssignment-recording.ts: check the
 * row's own checkbox, click "Assign Task to this Work". Caller is
 * responsible for closing the view afterward (closeUnassignedTasksView,
 * shared/unassignedTasks.ts) and for independently re-verifying the
 * assignment actually took (standing discipline #3) — this function only
 * performs the click sequence itself.
 */
export async function assignUnassignedTask(page: Page, rowIndex: number): Promise<void> {
  await page.locator('input[name="aTask"]').nth(rowIndex).check();
  await pace(page);
  await page.getByRole('link', { name: 'Assign Task to this Work' }).click();
  await pace(page);
}
