import { AUTH_FLOW_REPAIR, buildWarrantyTerminalStateVendorConfig, type VendorConfig } from './vendorConfig.js';

/**
 * Every vendor using the "vendor-code search + BN-prefix override +
 * warranty terminal state" process — confirmed by explicit user direction
 * to be genuinely identical across every vendor in this family, save for
 * the vendor code itself. 0T1Y4 is the first, real, live-proven entry.
 *
 * Adding a new vendor here is the entire integration — no new orchestrator,
 * search, or notes code needed; shared/vendorCodeWriteUp.ts's
 * runVendorCodeWriteUp() is fully generic over whichever VendorConfig is
 * passed in. If a future vendor genuinely needs to differ from the
 * template (a different Transport Type, a different BN policy, etc.), pass
 * a third `overrides` argument to buildWarrantyTerminalStateVendorConfig —
 * don't silently assume identical.
 */
export const VENDOR_REGISTRY: Readonly<Record<string, VendorConfig>> = Object.freeze({
  '0T1Y4': buildWarrantyTerminalStateVendorConfig('0T1Y4', 'Vendor 0T1Y4'),
  VC01059: buildWarrantyTerminalStateVendorConfig('VC01059', 'Vendor VC01059'),
  '68184': buildWarrantyTerminalStateVendorConfig('68184', 'Vendor 68184'),
  '10933': buildWarrantyTerminalStateVendorConfig('10933', 'Vendor 10933'),
  // 30242 and 0GZF3: real, confirmed difference in the auth-request step —
  // both can surface a "vendor minimum purchase amount" confirmation
  // dialog (see discovery-noprice-recording.ts). Handled generically in
  // shared/authFlow.ts's confirmAuthorizationRequest() rather than a
  // per-vendor flag here, since the dialog is driven by real order-amount
  // data, not vendor identity — no override needed on these two configs
  // specifically, the shared engine already covers it. Not yet verified
  // against a real live occurrence (no real example line existed for
  // either vendor at the time this was added) — treat the first real hit
  // on either of these two with the same scrutiny as any other first-time
  // mechanism.
  '30242': buildWarrantyTerminalStateVendorConfig('30242', 'Vendor 30242'),
  '0GZF3': buildWarrantyTerminalStateVendorConfig('0GZF3', 'Vendor 0GZF3'),
  VC00564: buildWarrantyTerminalStateVendorConfig('VC00564', 'Vendor VC00564'),
  '21844': buildWarrantyTerminalStateVendorConfig('21844', 'Vendor 21844'),
  '6MXR1': buildWarrantyTerminalStateVendorConfig('6MXR1', 'Vendor 6MXR1'),
  // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case) — baseline behavior is
  // identical to every other vendor in this family (WARRANTY auth,
  // AUTHORIZATION_ONLY terminal state, FEDEX-2 transport, NET30/717375) —
  // no baseline overrides needed. The shipsetCase override is the entire
  // delta: an alternate case, gated on a home-page grid-row task-name
  // trigger (not a serial-number prefix), applied only when it matches —
  // see vendorConfig.ts's resolveShipsetCase() and
  // vendorCodeWriteUp.ts's runVendorCodeWriteUp() for where each field is
  // consumed.
  '7A9Y2': buildWarrantyTerminalStateVendorConfig('7A9Y2', 'Skypaxxx Repairs', {
    shipsetCase: {
      id: 'SEAT_REFRESH_SHIPSET',
      expectedUsstgTaskName: 'TO_25-079-005-22-JIC (SEAT REFRESH - REMOVE AND INSTALL SEATS)',
      // Delta 1 — leave Transportation Type untouched, never an empty string.
      transportationType: null,
      // Delta 2 — REPAIR, not WARRANTY. Confirmed by explicit user
      // direction: this is the same authorization process BN-prefix lines
      // already follow (AUTH_FLOW_REPAIR + the retry-for-APPROVED
      // discipline in runVendorCodeWriteUp() — see the `isBnFlow ||
      // shipset` branch there). The recording's own selectOption call for
      // #idDropdownAuthFlows only captured an opaque {AES}-encoded value
      // (codegen records the internal option value, not the visible label,
      // for a native <select>), so the plain-text label itself couldn't be
      // read from the recording directly — using the same AUTH_FLOW_REPAIR
      // constant BN lines already use is now confirmed correct, not a
      // standing guess.
      authFlow: AUTH_FLOW_REPAIR,
      // Delta 2 — "Issue the order as normal": ISSUE_AND_DOCK dispatch,
      // with Delta 5 separately gating the dock-move sub-step below.
      terminalState: 'ISSUE_AND_DOCK',
      // Delta 3 — fixed, exact literal. Never composed from usage/part data.
      notesText: 'INSPECT AND SERVICE AS REQUIRED',
      // Delta 5 — temporary safety measure for initial production runs;
      // flip to true to re-enable Move to Dock, no code change needed.
      moveToDockOnInitialRun: false,
      // Delta 6 — a missing assigned task is not a blocker for this case.
      allowMissingAssignedTask: true,
      // Delta 7 — always the literal value, never derived from autofill.
      // Corrected per explicit user instruction: CR7HMV, not CR7REPAIR.
      chargeToAccount: 'CR7HMV',
    },
  }),
});

/**
 * Looks up a vendor's config by code (case-insensitive). Throws rather than
 * guessing/defaulting if the code isn't registered — same "refuse to
 * guess" discipline used throughout this project.
 */
export function getVendorConfig(vendorCode: string): VendorConfig {
  const config = VENDOR_REGISTRY[vendorCode.trim().toUpperCase()];
  if (!config) {
    throw new Error(
      `No VendorConfig registered for vendor code "${vendorCode}" — known vendors: ${Object.keys(VENDOR_REGISTRY).join(', ') || '(none)'}.`,
    );
  }
  return config;
}
