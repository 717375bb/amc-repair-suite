/**
 * Every function previously defined in this file has been moved to
 * backend/src/writeUps/shared/ per VENDOR_MODULE_REFACTOR_SPEC.md section
 * 3.4 — confirmed vendor-agnostic (identical mechanics in 0T1Y4's real
 * recordings). Re-exported here so every existing call site in this module
 * (writeUp.ts, batchDiscovery.ts, partDetails.ts) keeps working unchanged.
 * No behavior change — same functions, same signatures, new location only.
 */
export {
  readAssignedTasksAreaText,
  readUnassignedTasksAreaText,
  openCreateNewTask,
  readTaskDefinitionCandidates,
  cancelCreateNewTask,
  extractWorkPackageCheckId,
  createAdHocTaskForCandidate,
  reopenRepairLineAfterTaskCreation,
} from '../shared/taskRecovery.js';
export type { TaskDefinitionCandidate } from '../shared/taskRecovery.js';

export {
  readCurrentLocationCode,
  clickScheduleWorkPackage,
  selectExternalVendorWorkPackage,
  readChargeToAccount,
  fillChargeToAccount,
  fillPurchasingContact,
  selectConditions,
  fillReturnToLocation,
  selectTransportation,
  fillNotesToVendor,
  confirmScheduleWorkPackage,
  openGeneratedOrder,
  findGeneratedOrderNumber,
} from '../shared/scheduleWorkPackageForm.js';

export {
  clickRequestAuthorization,
  selectAuthFlow,
  confirmAuthorizationRequest,
} from '../shared/authFlow.js';
