/**
 * Every function previously defined in this file has been moved to
 * backend/src/writeUps/shared/issueAndDock.ts per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.4 — 0T1Y4's own recording
 * confirmed byte-for-byte identical Issue Order / Move to Dock sequencing,
 * superseding this file's original vendor-isolation design. Re-exported
 * here so every existing call site (writeUp.ts, processLine.ts) keeps
 * working unchanged. No behavior change — same functions, same signatures,
 * new location only.
 */
export {
  clickIssueOrder,
  confirmIssueOrder,
  navigateToOrderByNumber,
  readOrderRealState,
  issueGeneratedOrder,
  readOutboundShipmentDockState,
  moveOutboundShipmentToDock,
} from '../shared/issueAndDock.js';
export type {
  OrderRealState,
  IssueOrderResult,
  MoveToDockResult,
  OutboundShipmentDockState,
} from '../shared/issueAndDock.js';
