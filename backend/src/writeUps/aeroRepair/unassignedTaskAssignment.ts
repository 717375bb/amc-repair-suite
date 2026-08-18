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
  /** The row's own "Class"/"Type" cell, if one exists in the same shape as the Task-Definition panel's own Class column. */
  taskClass: string;
  rowText: string;
}

/**
 * Configurable ignore-list for the Unassigned Tasks section's own task
 * TYPE cell — rows whose type exactly matches one of these are never
 * assignable, administrative/non-repair task types. Originally just 'PC'
 * (Parts Card — CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 3);
 * extended with 'FORECAST', 'REPL', 'PC-PC' per the confirmed rule from
 * discovery-unassigned-recording.ts + explicit user confirmation. Centralized
 * here (not hardcoded literals scattered through the filter logic below) so
 * a future addition/removal is a one-line change to this array.
 */
export const UNASSIGNED_TASK_IGNORED_TYPES: readonly string[] = Object.freeze(['PC', 'FORECAST', 'REPL', 'PC-PC']);

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 3 — mirrors
 * readTaskDefinitionCandidates' (shared/taskRecovery.ts) confirmed PC
 * (Parts Card — administrative, never itself the repair task) exclusion.
 * That exclusion was confirmed against the Task Selection / "Blocks and
 * Requirements" panel specifically; the Unassigned Tasks table's own row
 * shape has not yet been confirmed to carry an equivalent standalone "PC"
 * Class cell. Read defensively: a row is only excluded when one of its own
 * `<td>` cells is EXACTLY one of UNASSIGNED_TASK_IGNORED_TYPES (same shape
 * already confirmed elsewhere in this project) — never a fuzzy substring
 * match, so a genuinely different row (or a longer string merely containing
 * e.g. "REPL") is never accidentally excluded. Logs both the raw and
 * post-filter lists (per the explicit requirement), so the difference is
 * auditable the first time this actually filters something for real.
 */
export async function readUnassignedTaskCandidates(
  page: Page,
): Promise<{ raw: UnassignedTaskRow[]; filtered: UnassignedTaskRow[] }> {
  const raw = await page.evaluate(
    ({ ignoredTypes }: { ignoredTypes: readonly string[] }) => {
      const checkboxes = Array.from(document.querySelectorAll('input[name="aTask"]')) as HTMLInputElement[];
      return checkboxes.map((cb, i) => {
        const tr = cb.closest('tr');
        const cellTexts = tr
          ? Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
          : [];
        const taskClass = cellTexts.find((c) => ignoredTypes.includes(c)) ?? '';
        const rowText = (tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { index: i, taskClass, rowText };
      });
    },
    { ignoredTypes: UNASSIGNED_TASK_IGNORED_TYPES },
  );

  // Exact, normalized match against the same ignore-list — never a
  // substring match (a row whose taskClass merely CONTAINS "REPL" as part
  // of a longer string must not be excluded).
  const filtered = raw.filter((row) => !UNASSIGNED_TASK_IGNORED_TYPES.includes(row.taskClass));
  log.info({ candidateCount: raw.length, candidates: raw }, '[unassigned-task-assignment] raw candidates');
  log.info(
    { candidateCount: filtered.length, candidates: filtered, ignoredTypes: UNASSIGNED_TASK_IGNORED_TYPES },
    '[unassigned-task-assignment] post-ignore-list-filter candidates',
  );
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
