import type { Page } from 'playwright';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;
const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/partDetails.ts, aeroRepair/constants.ts, and
 * aeroRepair/gridWait.ts — confirmed vendor-agnostic by a second real
 * vendor (0T1Y4's own warranty-flow recording uses the identical
 * "Unassigned" -> "Unassigned Tasks" -> "Close" detour, and its live
 * production runs confirmed this empty-state text and content-aware wait
 * both work correctly there too). Pure relocation, no behavior change —
 * re-exported from aeroRepair's own files so every existing call site
 * keeps working unchanged.
 */

/**
 * The Unassigned Tasks sub-tab's own confirmed-real empty-state text —
 * distinct from the default Assigned Tasks tab's own no-tasks message. A
 * real unassigned task row replaces this text entirely.
 */
export const NO_UNASSIGNED_TASKS_TEXT =
  'There are no open tasks for this inventory item or any of its sub-inventory items.';

/**
 * After clicking a repair line, some vendors' flows detour through
 * "Unassigned" -> "Unassigned Tasks" -> "Close" first, confirming nothing
 * blocking before proceeding. NOT where the no-tasks-assigned exception is
 * checked — this sub-tab's own "no open tasks" message is a different,
 * normal/expected state, confirmed live to appear on every real line
 * checked, including ones with genuine assigned work.
 */
export async function navigateToUnassignedTasksView(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Unassigned' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Unassigned Tasks' }).click();
  await pace(page);
}

export async function closeUnassignedTasksView(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * Content-aware wait: "Assign Task to this Work Package" is a real,
 * confirmed-present marker of this sub-tab having actually rendered — once
 * it (or, redundantly, the empty-state text itself) appears, the section
 * is done loading. Throws rather than defaulting to "task present" on an
 * inconclusive read — an inconclusive read must never silently become a
 * blocking positive.
 */
export async function waitForUnassignedTasksSectionResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ emptyText }: { emptyText: string }) => {
        const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const normalizedEmptyText = emptyText.replace(/\s+/g, ' ').trim();
        return bodyText.includes('Assign Task to this Work Package') || bodyText.includes(normalizedEmptyText);
      },
      { emptyText: NO_UNASSIGNED_TASKS_TEXT },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Unassigned Tasks section did not resolve to a definitive state (no "Assign Task to this Work Package" ` +
        `marker AND no empty-state text) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a genuine ` +
        `"task present" or "task absent" result. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.debug({ durationMs: Date.now() - start }, '[grid-wait] unassigned-tasks section resolved');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * True if the Unassigned Tasks sub-tab shows something OTHER than its
 * confirmed-real empty-state text — i.e. a genuine unassigned task row is
 * present. Whitespace-normalized comparison, same rigor as elsewhere in
 * this project.
 */
export function isUnassignedTaskPresent(pageText: string): boolean {
  return !normalizeWhitespace(pageText).includes(normalizeWhitespace(NO_UNASSIGNED_TASKS_TEXT));
}

export type UnassignedTaskDetectionState = 'present' | 'absent' | 'inconclusive';

export interface UnassignedTaskDetectionResult {
  state: UnassignedTaskDetectionState;
  taskCheckboxCount: number;
  pageText: string;
}

/**
 * CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 4 — tri-state refinement
 * of isUnassignedTaskPresent above, for Aero Repair's own call site only.
 * isUnassignedTaskPresent infers "present" purely from "does not match the
 * known empty-state text" — absence-based inference producing a confident
 * answer, which standing discipline #2 forbids. This instead requires
 * POSITIVE evidence for each state: `present` needs a real assignable task
 * checkbox (`input[name="aTask"]`, the confirmed real mechanism from
 * discovery-UnassignedTaskAssignment-recording.ts) actually present in the
 * DOM; `absent` needs the confirmed empty-state text; anything matching
 * NEITHER is `inconclusive` — callers must raise a distinct exception for
 * that case rather than falling through to either branch.
 *
 * isUnassignedTaskPresent itself is left untouched — it's shared with
 * vendor 0T1Y4 (confirmed vendor-agnostic there), and this tri-state
 * refinement has not been verified against that vendor's own flow.
 */
export async function detectUnassignedTaskState(page: Page): Promise<UnassignedTaskDetectionResult> {
  const pageText = await page.locator('body').innerText();
  const taskCheckboxCount = await page.locator('input[name="aTask"]').count();

  if (taskCheckboxCount > 0) {
    return { state: 'present', taskCheckboxCount, pageText };
  }
  if (!isUnassignedTaskPresent(pageText)) {
    return { state: 'absent', taskCheckboxCount, pageText };
  }
  return { state: 'inconclusive', taskCheckboxCount, pageText };
}

export interface UnassignedTaskRow {
  /** 0-based index into the page's `input[name="aTask"]` NodeList — used to target the right checkbox. */
  index: number;
  /** The row's own task-type cell text, if one exists. */
  taskClass: string;
  rowText: string;
}

/**
 * Configurable ignore-list for the Unassigned Tasks section's own task
 * TYPE cell — rows whose type exactly matches one of these are never
 * assignable, administrative/non-repair task types. Originally just 'PC'
 * (Parts Card); extended with 'FORECAST', 'REPL', 'PC-PC' per explicit user
 * confirmation. Centralized here so a future addition/removal is a
 * one-line change to this array.
 *
 * Moved here from aeroRepair/unassignedTaskAssignment.ts (2026-08-20) —
 * originally Aero Repair-only, now shared with the vendor-code engine's own
 * Unassigned Tasks check per explicit user direction: both flows must
 * ignore these same task types on this same MXI page and let the write-up
 * continue, not just Aero Repair's own recovery path.
 */
export const UNASSIGNED_TASK_IGNORED_TYPES: readonly string[] = Object.freeze(['PC', 'FORECAST', 'REPL', 'PC-PC']);

/**
 * Reads every checkbox-selectable row on the Unassigned Tasks sub-tab and
 * its own task-type cell, then filters out anything matching
 * UNASSIGNED_TASK_IGNORED_TYPES.
 *
 * Real DOM evidence supplied directly by the user (a live row's outer
 * HTML): `<td id="<random-per-row-id>" nowrap="" class="shortString">FORECAST</td>`
 * — the per-row `id` is confirmed NOT stable (different on every line, per
 * the user), so it can never be used as a locator; `class="shortString"`
 * is the real, confirmed-stable marker for the task-type cell. Scoped the
 * read to `td.shortString` specifically (rather than the previous
 * "scan every `<td>` in the row" approach) for that reason — still an
 * EXACT, case-sensitive match against the ignore list, never a fuzzy
 * substring match, so a row that merely contains "REPL" as part of a
 * longer string is never accidentally excluded. Logs both the raw and
 * post-filter lists, so the difference is auditable every time this
 * actually filters something for real.
 */
export async function readUnassignedTaskCandidates(
  page: Page,
): Promise<{ raw: UnassignedTaskRow[]; filtered: UnassignedTaskRow[] }> {
  const raw = await page.evaluate(
    ({ ignoredTypes }: { ignoredTypes: readonly string[] }) => {
      const checkboxes = Array.from(document.querySelectorAll('input[name="aTask"]')) as HTMLInputElement[];
      return checkboxes.map((cb, i) => {
        const tr = cb.closest('tr');
        const typeCellTexts = tr
          ? Array.from(tr.querySelectorAll('td.shortString')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
          : [];
        const taskClass = typeCellTexts.find((c) => ignoredTypes.includes(c)) ?? '';
        const rowText = (tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { index: i, taskClass, rowText };
      });
    },
    { ignoredTypes: UNASSIGNED_TASK_IGNORED_TYPES },
  );

  const filtered = raw.filter((row) => !UNASSIGNED_TASK_IGNORED_TYPES.includes(row.taskClass));
  log.info({ candidateCount: raw.length, candidates: raw }, '[unassigned-task-assignment] raw candidates');
  log.info(
    { candidateCount: filtered.length, candidates: filtered, ignoredTypes: UNASSIGNED_TASK_IGNORED_TYPES },
    '[unassigned-task-assignment] post-ignore-list-filter candidates',
  );
  return { raw, filtered };
}

/**
 * Checks the row's own checkbox, clicks "Assign Task to this Work" — the
 * confirmed real mechanism (Aero Repair's own recovery path). Caller is
 * responsible for closing the view afterward (closeUnassignedTasksView)
 * and for independently re-verifying the assignment actually took.
 */
export async function assignUnassignedTask(page: Page, rowIndex: number): Promise<void> {
  await page.locator('input[name="aTask"]').nth(rowIndex).check();
  await pace(page);
  await page.getByRole('link', { name: 'Assign Task to this Work' }).click();
  await pace(page);
}
