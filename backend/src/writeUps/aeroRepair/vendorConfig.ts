import { buildVendorFormConfig, type VendorConfig } from '../shared/vendorConfig.js';
import {
  AERO_REPAIR_PART_NUMBERS,
  AUTH_FLOW,
  CHARGE_TO_ACCOUNT_REPLACEMENT,
  NOTES_HEADER_TEXT,
  TRANSPORTATION_LABEL,
} from './constants.js';

/**
 * Aero Repair expressed as a VendorConfig, per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.5 — documentation + shape
 * validation only. Not currently read by writeUp.ts/processLine.ts (which
 * still use the raw constants directly, unchanged) — this object exists so
 * the VendorConfig shape is proven against a second real,
 * already-verified-in-production vendor before 0T1Y4 (a brand-new,
 * never-run vendor) becomes its only real consumer.
 *
 * `authFlowPolicy.overrides` is empty and `defaultTerminalState` is
 * 'ISSUE_AND_DOCK' because that's exactly what Aero Repair does today for
 * every real line, unconditionally — resolveAuthFlowPolicy() against this
 * config returns the same AUTH_FLOW value and the same always-issue-and-dock
 * behavior for every serial number, no matter its prefix. This restates
 * current behavior as config; it does not change it.
 *
 * `form` is built via buildVendorFormConfig(), inheriting Purchasing
 * Contact/Terms & Conditions from the shared global defaults and
 * overriding only `transportation` — the one field Aero Repair genuinely
 * needs different from every other vendor (PICKUP vs. the FEDEX-2 global
 * default).
 */
export const AERO_REPAIR_VENDOR_CONFIG: VendorConfig = {
  id: 'aeroRepair',
  displayName: 'Aero Repair',
  search: { kind: 'partNumberList', partNumbers: AERO_REPAIR_PART_NUMBERS },
  form: buildVendorFormConfig({
    transportation: TRANSPORTATION_LABEL,
    chargeToAccountSuffix: CHARGE_TO_ACCOUNT_REPLACEMENT,
    notesHeader: NOTES_HEADER_TEXT,
  }),
  authFlowPolicy: { default: AUTH_FLOW, overrides: [] },
  defaultTerminalState: 'ISSUE_AND_DOCK',
  warrantyEligible: false,
};
