/**
 * Moved to ../shared/unassignedTasks.ts (2026-08-20) — now shared with the
 * vendor-code engine's own Unassigned Tasks check (both flows must ignore
 * the same task types on the same MXI page). Re-exported here so
 * aeroRepair/writeUp.ts's existing import path keeps compiling unchanged.
 */
export {
  UNASSIGNED_TASK_IGNORED_TYPES,
  readUnassignedTaskCandidates,
  assignUnassignedTask,
  type UnassignedTaskRow,
} from '../shared/unassignedTasks.js';
