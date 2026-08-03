/**
 * transformReturnToLocation moved to
 * backend/src/writeUps/shared/scheduleWorkPackageForm.ts per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.4 — confirmed identical
 * "STATION/USSTG -> STATION/DOCK" transform in 0T1Y4's real recordings
 * (both BN and warranty lines). Re-exported here so the existing call site
 * (writeUp.ts) keeps working unchanged.
 */
export { transformReturnToLocation } from '../shared/scheduleWorkPackageForm.js';
