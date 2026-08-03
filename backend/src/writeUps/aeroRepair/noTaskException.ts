import { NO_TASKS_ASSIGNED_TEXT } from './constants.js';

/**
 * Exact string match, not a fuzzy contains-a-keyword check - per the task's
 * own rigor requirement. Checks the DEFAULT "Assigned Tasks" tab.
 */
export function isNoTasksAssignedException(pageText: string): boolean {
  return pageText.includes(NO_TASKS_ASSIGNED_TEXT);
}

/**
 * isUnassignedTaskPresent moved to backend/src/writeUps/shared/unassignedTasks.ts
 * — confirmed vendor-agnostic by a second real vendor (0T1Y4). Re-exported
 * here so the existing call site (writeUp.ts) keeps working unchanged.
 */
export { isUnassignedTaskPresent } from '../shared/unassignedTasks.js';
