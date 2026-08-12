import type { Page } from 'playwright';

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
  console.log(`[grid-wait] unassigned-tasks section resolved in ${Date.now() - start}ms`);
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
