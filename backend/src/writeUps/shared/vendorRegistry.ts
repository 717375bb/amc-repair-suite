import {
  AUTH_FLOW_REPAIR,
  buildVendorFormConfig,
  buildWarrantyTerminalStateVendorConfig,
  WARRANTY_TERMINAL_STATE_NOTES_HEADER,
  type VendorConfig,
} from './vendorConfig.js';

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
  '0T1Y4': buildWarrantyTerminalStateVendorConfig('0T1Y4', 'BARFIELD PRECISION ELECTRONICS LLC'),
  VC01059: buildWarrantyTerminalStateVendorConfig('VC01059', 'ARC - ACTION RESEARCH CORPORATION'),
  '68184': buildWarrantyTerminalStateVendorConfig('68184', 'ARKWIN INDUSTRIES INC'),
  '10933': buildWarrantyTerminalStateVendorConfig('10933', 'AVIONIC INSTRUMENTS LLC'),
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
  '30242': buildWarrantyTerminalStateVendorConfig('30242', 'AVTECHTYEE INC'),
  '0GZF3': buildWarrantyTerminalStateVendorConfig('0GZF3', 'HEADS UP TECHNOLOGIES INC'),
  VC00564: buildWarrantyTerminalStateVendorConfig('VC00564', 'LUMINATOR HOLDING LP'),
  '21844': buildWarrantyTerminalStateVendorConfig('21844', 'BARFIELD INSTRUMENT CORP'),
  '6MXR1': buildWarrantyTerminalStateVendorConfig('6MXR1', 'MEASURETECH INC'),
  // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case) — baseline behavior is
  // identical to every other vendor in this family (WARRANTY auth,
  // AUTHORIZATION_ONLY terminal state, FEDEX-2 transport, NET30/717375) —
  // no baseline overrides needed. The shipsetCase override is the entire
  // delta: an alternate case, gated on a home-page grid-row task-name
  // trigger (not a serial-number prefix), applied only when it matches —
  // see vendorConfig.ts's resolveShipsetCase() and
  // vendorCodeWriteUp.ts's runVendorCodeWriteUp() for where each field is
  // consumed.
  // CLAUDE_CODE_PROMPT (#1, new vendors — pilot). Repair-default family:
  // genuinely different baseline from every vendor above — REPAIR is the
  // DEFAULT authFlow (no BN override needed/present), always full flow
  // (ISSUE_AND_DOCK unconditionally), warrantyEligible: false. Confirmed
  // against the real recording (discovery-76863-AJS-sn-recording.ts):
  // Issue Order + Move to Dock both ran even though the line's own serial
  // isn't BN-prefixed — this vendor simply never uses the warranty path at
  // all, not a BN-detection edge case. Charge To Account is flat
  // COLLINSDISPATCH100 (Collins vendors only) regardless of the part-level
  // receiving notes — hasPartDetailsStep: true still runs that navigation
  // step for real (confirmed present in the recording), it's just dormant
  // for this vendor's own account decision (see
  // shared/partDetailsReceivingNotes.ts). Purchasing Contact/Conditions/
  // Transportation all inherit the shared family defaults
  // (717375/NET30/FEDEX-2) — the recording's own 232275 was the operator's
  // personal ID, not a real vendor-specific value, per explicit user
  // correction.
  '76863': buildWarrantyTerminalStateVendorConfig('76863', 'Rockwell - Seattle', {
    form: buildVendorFormConfig({
      chargeToAccountSuffix: 'COLLINSDISPATCH100',
      notesHeader: WARRANTY_TERMINAL_STATE_NOTES_HEADER,
    }),
    authFlowPolicy: { default: AUTH_FLOW_REPAIR, overrides: [] },
    defaultTerminalState: 'ISSUE_AND_DOCK',
    warrantyEligible: false,
    hasPartDetailsStep: true,
  }),
  '7A9Y2': buildWarrantyTerminalStateVendorConfig('7A9Y2', 'SKYPAXXX INTERIOR REPAIRS', {
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
  // CLAUDE_CODE_PROMPT (new vendor batch, 2026-08-14) — 26 vendors added at
  // once, all confirmed by explicit user direction to be the SAME real
  // process as the family above (vendor-code search + BN-prefix override +
  // warranty terminal state) — no per-vendor Playwright recording exists
  // for this batch (a deliberate departure from this project's usual
  // practice, at explicit user direction: "let live testing confirm"). All
  // 26 get hasPartDetailsStep: true per explicit instruction, even though
  // only two vendors in the whole family (76863, 1DH10) have ever had this
  // step confirmed present in a real recording — a vendor that genuinely
  // lacks it will surface as a real, visible failure the first time it
  // runs, not a silent guess. Real receiving notes are now checked for the
  // word "account" (case-insensitive) and flagged for manual review rather
  // than risking a wrong Charge To Account — see vendorCodeWriteUp.ts's
  // 'receiving_notes_flagged_account' outcome.
  //
  // 3 of these 26 are RMA vendors (see shared/rmaVendors.ts's
  // RMA_VENDOR_IDS) — a separate, pure vendor-code-membership rule, not
  // anything set on the VendorConfig itself here.
  //
  // DCM GROUP INC's code: an earlier one-off correction from the user gave
  // "VC005241", but that correction was applied to a vendor list later
  // found to be entirely wrong (certificate numbers, not vendor codes).
  // The FINAL corrected list (the one the user explicitly called "the
  // correct list") gives "VC00524" (no trailing "1") — using that value
  // here since it's the later, more authoritative, and most thoroughly
  // reconciled source. Flagged to the user rather than silently picking
  // one, per this project's "never guess on vendor codes" discipline.
  VC00814: buildWarrantyTerminalStateVendorConfig('VC00814', 'AIRGROUP DYNAMICS INC', { hasPartDetailsStep: true }),
  VC00584: buildWarrantyTerminalStateVendorConfig('VC00584', 'AIRLINE COMPONENT PARTS LLC', { hasPartDetailsStep: true }),
  '5YRM0': buildWarrantyTerminalStateVendorConfig('5YRM0', 'CAMTRONICS LLC', { hasPartDetailsStep: true }),
  VC00569: buildWarrantyTerminalStateVendorConfig('VC00569', 'CHAMPION AEROSPACE LLC', { hasPartDetailsStep: true }),
  VC00870: buildWarrantyTerminalStateVendorConfig('VC00870', 'CIRCOR AEROSPACE INC', { hasPartDetailsStep: true }),
  '1BAY3': buildWarrantyTerminalStateVendorConfig('1BAY3', 'CSI AEROSPACE INC', { hasPartDetailsStep: true }),
  VC00524: buildWarrantyTerminalStateVendorConfig('VC00524', 'DCM GROUP INC', { hasPartDetailsStep: true }),
  // RMA vendor — see shared/rmaVendors.ts's RMA_VENDOR_IDS.
  '8719': buildWarrantyTerminalStateVendorConfig('8719', 'DUCOMMUN TECHONOLGIES', { hasPartDetailsStep: true }),
  '2750': buildWarrantyTerminalStateVendorConfig('2750', 'EATON CORPORATION', { hasPartDetailsStep: true }),
  '59875': buildWarrantyTerminalStateVendorConfig('59875', 'EATON INDUSTRIAL CORPORATION', { hasPartDetailsStep: true }),
  VC00879: buildWarrantyTerminalStateVendorConfig('VC00879', 'FIRSTMARK AEROSPACE CORPORATION', { hasPartDetailsStep: true }),
  // Real recording evidence exists for this vendor
  // (discovery-7A9Y2-AJS--recording (5).ts, reviewed during the Skypaxxx
  // investigation): real order P000BDWB, direct-fill Charge To Account
  // "CR7REPAIR" — matches this family's own default suffix exactly, no
  // override needed. hasPartDetailsStep independently confirmed present
  // for this vendor too, not just applied via the batch-wide default.
  '1DH10': buildWarrantyTerminalStateVendorConfig('1DH10', 'HRD AERO SYSTEMS INC', { hasPartDetailsStep: true }),
  // RMA vendor — see shared/rmaVendors.ts's RMA_VENDOR_IDS.
  '58657': buildWarrantyTerminalStateVendorConfig('58657', 'LEACH - CA', { hasPartDetailsStep: true }),
  VC01014: buildWarrantyTerminalStateVendorConfig('VC01014', 'LEADING EDGE AEROSPACE', { hasPartDetailsStep: true }),
  // Two distinct real vendors, per explicit user correction — NOT a
  // duplicate/merge (an earlier working assumption, made obsolete once the
  // corrected code list gave each its own real code).
  VC01197: buildWarrantyTerminalStateVendorConfig('VC01197', 'LIEBHERR AEROSPACE - NORTH MAPLE RD', { hasPartDetailsStep: true }),
  '8S625': buildWarrantyTerminalStateVendorConfig('8S625', 'LIEBHERR AEROSPACE SALINE INC', { hasPartDetailsStep: true }),
  '76227': buildWarrantyTerminalStateVendorConfig('76227', 'LIEBHERR-AEROSPACE LINDENBERG GMBH', { hasPartDetailsStep: true }),
  '0B9R9': buildWarrantyTerminalStateVendorConfig('0B9R9', 'MEGGITT AIRCRAFT BRAKING SYSTEMS', { hasPartDetailsStep: true }),
  '0VXA1': buildWarrantyTerminalStateVendorConfig('0VXA1', 'MIDWEST AERO SUPPORT LLC', { hasPartDetailsStep: true }),
  VC00445: buildWarrantyTerminalStateVendorConfig('VC00445', 'REXNORD INDUSTRIES LLC', { hasPartDetailsStep: true }),
  // RMA vendor — see shared/rmaVendors.ts's RMA_VENDOR_IDS.
  '75521': buildWarrantyTerminalStateVendorConfig('75521', 'ROTRON INC.', { hasPartDetailsStep: true }),
  '16630': buildWarrantyTerminalStateVendorConfig('16630', 'TAT-LIMCO', { hasPartDetailsStep: true }),
  // Real recording evidence exists for this vendor
  // (discovery-7A9Y2-AJS--recording (4).ts): real order P000BDV4,
  // direct-fill Charge To Account "CR7REPAIR" — matches this family's own
  // default suffix exactly, no override needed.
  VC00399: buildWarrantyTerminalStateVendorConfig('VC00399', 'THALES AVIONICS, INC.', { hasPartDetailsStep: true }),
  '67107': buildWarrantyTerminalStateVendorConfig('67107', 'TRIUMPH CONTROLS INC', { hasPartDetailsStep: true }),
  '67365': buildWarrantyTerminalStateVendorConfig('67365', 'WOODWARD INC', { hasPartDetailsStep: true }),
  '19710': buildWarrantyTerminalStateVendorConfig('19710', 'WOODWARD MPC', { hasPartDetailsStep: true }),
  '67KR8': buildWarrantyTerminalStateVendorConfig('67KR8', 'VANGUARD AEROSPACE LLC', { hasPartDetailsStep: true }),
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
