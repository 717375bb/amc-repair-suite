import type { Page } from 'playwright';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;
const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/selectors.ts and aeroRepair/gridWait.ts per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.4 — confirmed vendor-agnostic:
 * discovery-0t1y4-bn-recording.ts's Create New Task -> Ad-Hoc Task sequence
 * (lines 12-18) is byte-for-byte the same real mechanism Aero Repair's own
 * no-task recovery path already used, just with a different task-name
 * string. Nothing below has been changed from its original aeroRepair
 * implementation — this is a pure relocation, re-exported from
 * aeroRepair/selectors.ts so every existing call site keeps working
 * unchanged.
 */

export async function waitForBodyTextIncludes(page: Page, markerText: string, contextLabel: string): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      ({ marker }: { marker: string }) => (document.body?.innerText ?? '').includes(marker),
      { marker: markerText },
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `${contextLabel} did not resolve to a definitive state (marker text "${markerText}" never appeared) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this read as complete. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.debug({ contextLabel, durationMs: Date.now() - start }, '[grid-wait] resolved');
}

export async function waitForWorkPackageDetailsResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => (document.body?.innerText ?? '').includes('Schedule Work Package'),
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Work Package Details did not resolve to a definitive state (no "Schedule Work Package" marker) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to proceed on an inconclusive read. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.debug({ durationMs: Date.now() - start }, '[grid-wait] work-package-details resolved');
}

export async function waitForTaskDefinitionCandidatesResolved(page: Page): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('input[name="aTaskDefinition"]').length > 0,
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Task Selection panel did not resolve to a definitive state (no aTaskDefinition radios rendered) within ` +
        `${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this as a genuine 0-candidate result. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.debug({ durationMs: Date.now() - start }, '[grid-wait] task-definition candidates resolved');
}

/**
 * Reads the DEFAULT "Assigned Tasks" tab of the Work Package Details page —
 * landed on immediately after clicking a part's repair link, before any
 * further navigation. Call this BEFORE navigateToUnassignedTasksView —
 * that view's own "no open tasks" message is a different, unrelated, normal/
 * expected state.
 */
export async function readAssignedTasksAreaText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/**
 * Reads the Unassigned Tasks sub-tab's body text — call this AFTER
 * navigating to that view, BEFORE closing it (once closed, this content is
 * gone). Distinct from readAssignedTasksAreaText above.
 */
export async function readUnassignedTasksAreaText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

export interface TaskDefinitionCandidate {
  /** Visible text of the row's own `<a class="navigable">` link in the "Block / Requirement" column. */
  name: string;
  /** Real value of the row's "Class" column, e.g. "REPL", "MOD", "PC". */
  taskClass: string;
}

/**
 * Clicks "Create New Task" — a link present on the SAME default "Assigned
 * Tasks" tab landed on immediately after a part's repair link is clicked.
 * Opens the real "Task Selection" panel that readTaskDefinitionCandidates
 * reads from.
 */
export async function openCreateNewTask(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Create New Task' }).click();
  await pace(page);
}

/**
 * Reads the real candidate task definitions from the "Task Selection"
 * panel's "Blocks and Requirements" table. Dedupes `aTaskDefinition` radios
 * by their `value` (a real, confirmed rendering quirk duplicates the same
 * value multiple times per row). Each candidate's real "Name" is the
 * visible text of the row's own `<a class="navigable">` link; `taskClass`
 * is the row's plain-text "Class" cell (the first `td.shortString` WITHOUT
 * a nested link).
 *
 * This table is NOT scoped to the specific serial number in front of it —
 * it's a fixed catalog of task-definition TEMPLATES offered identically
 * regardless of which serial you arrived from. One of the templates is
 * consistently `taskClass: 'PC'` (Parts Card — administrative, never itself
 * the repair task) — callers should exclude it before counting real
 * candidates.
 */
export async function readTaskDefinitionCandidates(page: Page): Promise<TaskDefinitionCandidate[]> {
  await waitForTaskDefinitionCandidatesResolved(page);
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name="aTaskDefinition"]')) as HTMLInputElement[];
    const seen = new Map<string, { name: string; taskClass: string }>();
    for (const radio of radios) {
      if (seen.has(radio.value)) continue;
      const tr = radio.closest('tr');
      const nameLink = tr?.querySelector('a.navigable');
      const name = (nameLink?.textContent ?? tr?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const shortStringCells = tr ? Array.from(tr.querySelectorAll('td.shortString')) : [];
      const classCell = shortStringCells.find((td) => !td.querySelector('a'));
      const taskClass = (classCell?.textContent ?? '').trim();
      seen.set(radio.value, { name, taskClass });
    }
    return Array.from(seen.values());
  });
}

/**
 * Cancels out of the "Task Selection" panel without creating anything —
 * used both for the 0-candidate case and the 2+ (ambiguous) case.
 */
export async function cancelCreateNewTask(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Cancel' }).click();
  await pace(page);
}

/**
 * Extracts the real Work Package/Check ID from the default Assigned Tasks
 * tab's own title line, e.g. `"Work Package Details  Repair MAIN WHEEL ASSY
 * 700 (PN: 5013641, SN: JUN10-2295/JAN10-0014) [TRFKE00GXV7S]"` ->
 * `"TRFKE00GXV7S"`. Only scans the first line (the page title) to avoid
 * matching an unrelated bracketed token elsewhere on the page. Returns null
 * if the expected trailing `[...]` isn't found, rather than guessing.
 */
export function extractWorkPackageCheckId(assignedTasksPageText: string): string | null {
  const titleLine = assignedTasksPageText.split('\n')[0] ?? '';
  const match = titleLine.match(/\[([A-Z0-9]+)\]\s*$/);
  return match ? match[1] : null;
}

/**
 * Creates a real Ad-Hoc task named after the candidate's own real `name`
 * text, with the real Work Package/Check ID appended directly after it.
 * Sequence: `#idRadioAdHoc` -> fill `#idInput12` (`aTaskName`) -> OK ->
 * "Close" cell -> "Close" link. Confirmed identical across both Aero
 * Repair's own recovery path and 0T1Y4's BN recording.
 *
 * `checkId` must be read from the Assigned Tasks tab
 * (extractWorkPackageCheckId) BEFORE calling openCreateNewTask — the Task
 * Selection panel this function operates on does not itself display that
 * ID anywhere.
 */
export async function createAdHocTaskForCandidate(
  page: Page,
  candidate: TaskDefinitionCandidate,
  checkId: string,
): Promise<void> {
  const taskName = `${candidate.name} ${checkId}`;
  await page.locator('#idRadioAdHoc').check();
  await pace(page);
  await page.locator('#idInput12').click();
  await page.locator('#idInput12').fill(taskName);
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await page.getByRole('cell', { name: 'Close' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * After createAdHocTaskForCandidate's final "Close" click, the page lands
 * back on the filtered To Do List grid, not Work Package Details. Re-clicks
 * the same still-visible repair line (`linkText`) to get back there.
 */
export async function reopenRepairLineAfterTaskCreation(page: Page, linkText: string): Promise<void> {
  await page.getByRole('link', { name: linkText, exact: true }).click();
  await pace(page);
}
