import { NO_TASKS_ASSIGNED_TEXT, NO_UNASSIGNED_TASKS_TEXT } from './constants.js';

/**
 * Exact string match, not a fuzzy contains-a-keyword check - per the task's
 * own rigor requirement. Checks the DEFAULT "Assigned Tasks" tab.
 */
export function isNoTasksAssignedException(pageText: string): boolean {
  return pageText.includes(NO_TASKS_ASSIGNED_TEXT);
}

/**
 * Collapses runs of whitespace (including non-breaking spaces, which
 * `.innerText()` can emit for rendered blank cells) to a single space and
 * trims. \s already matches U+00A0 (non-breaking space) per the JS regex
 * spec, so no separate NBSP clause is needed. Verified against a real
 * captured passing sample that the live page's empty-state text matches
 * NO_UNASSIGNED_TASKS_TEXT byte-for-byte with no such anomaly present -
 * but isUnassignedTaskPresent is normalized anyway, defensively, since a
 * plain substring check has no way to notice if that ever changes on a
 * future real page render.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * True if the Unassigned Tasks sub-tab shows something OTHER than its
 * confirmed-real empty-state text - i.e. a genuine unassigned task row is
 * present. Same exact-contrast rigor as isNoTasksAssignedException, against
 * a separately-confirmed string for this separate page. A real, distinct
 * exception ("Unassigned Task Present") from the Assigned-Tasks-tab check
 * above - the two are independent checks on two independent views.
 *
 * Whitespace-normalized comparison (see normalizeWhitespace) - a real
 * investigation into a wave of false positives here confirmed the text
 * itself matches exactly when the page has actually rendered (the bug was
 * a timing race, not a text mismatch - see gridWait.ts's
 * waitForUnassignedTasksSectionResolved, called before this by every
 * caller), but normalizing costs nothing and guards against exactly the
 * class of subtle whitespace divergence that caused this project's very
 * first real production incident (the ESD field's mojibake em dash).
 */
export function isUnassignedTaskPresent(pageText: string): boolean {
  return !normalizeWhitespace(pageText).includes(normalizeWhitespace(NO_UNASSIGNED_TASKS_TEXT));
}
