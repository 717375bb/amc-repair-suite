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

/**
 * CLAUDE_CODE_PROMPT (Rockwell/Collins + Ham* repair-flow correction,
 * 2026-09-10) — per explicit user direction: "nothing out of Ham Sund,
 * Hamilton Sundstrand, Ham Care, or anything in the Rockwell family goes
 * through warranty flow. They just get sent through repair flow, and then
 * issued and NOT moved to dock." This is the exact authFlowPolicy/
 * defaultTerminalState shape 76863 (Rockwell - Seattle) already carries —
 * confirmed via explicit user direction that Collins - VT (89305, no
 * "Rockwell" in its name) counts as the same lineage too, alongside the
 * three "ROCKWELL COLLINS -" vendors and the two Ham Sund/Hamilton
 * Sundstrand/Ham Care entries. Applied ON TOP OF each vendor's own
 * skipMoveToDock/form overrides below (Object.assign spread order:
 * per-vendor overrides first, then this, so a future per-vendor deviation
 * would need to come after this instead — none exists today).
 */
const REPAIR_FLOW_ISSUED_NOT_DOCKED: Pick<VendorConfig, 'authFlowPolicy' | 'defaultTerminalState'> = {
  authFlowPolicy: { default: AUTH_FLOW_REPAIR, overrides: [] },
  defaultTerminalState: 'ISSUE_AND_DOCK',
};

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
  'VC00664': buildWarrantyTerminalStateVendorConfig('VC00664', 'HR SMITH GROUP', { hasPartDetailsStep: true }),
  '1JYM3': buildWarrantyTerminalStateVendorConfig('1JYM3', 'AVIATRON INC', { hasPartDetailsStep: true }),
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
    // CLAUDE_CODE_PROMPT (Andres Sabido vendor batch, 2026-09-10) — per
    // explicit user direction, "don't move to dock" applies to ALL of
    // Andres's vendors, this already-live one included: "he has a special
    // process that he wants to do himself." Issue Order still runs and is
    // still verified; only Move to Dock is skipped. A real, deliberate
    // change to this vendor's existing production behavior, not an
    // oversight — confirmed explicitly before changing an already-proven
    // live flow.
    skipMoveToDock: true,
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
      notesText: 'Inspect and service as required. Provide estimate for approval. Provide new 8130 with times and cycles and SFR. Provide new certificate and test data sheet.',
      // Delta 5 — originally a temporary safety measure for initial
      // production runs only. CLAUDE_CODE_PROMPT (Andres Sabido vendor
      // batch, 2026-09-10): superseded — per explicit user direction,
      // "don't move to dock" is now a PERMANENT rule for every one of
      // Andres's vendors, this shipset case included ("he has a special
      // process that he wants to do himself"). Leave this false; it is no
      // longer a flag to eventually flip back to true.
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
  '08719': buildWarrantyTerminalStateVendorConfig('08719', 'DUCOMMUN TECHONOLGIES', { hasPartDetailsStep: true }),
  '02750': buildWarrantyTerminalStateVendorConfig('02750', 'EATON CORPORATION', { hasPartDetailsStep: true }),
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
  '2N512': buildWarrantyTerminalStateVendorConfig('2N512', 'AEROTRON AIR POWER INC', { hasPartDetailsStep: true, needsRemovalDateInNotes: true }),
  '3H889': buildWarrantyTerminalStateVendorConfig('3H889', 'PARKER AERO - CA', { hasPartDetailsStep: true }),
  '26433': buildWarrantyTerminalStateVendorConfig('26433', 'PARKER AERO - OH', { hasPartDetailsStep: true }),
  '99321': buildWarrantyTerminalStateVendorConfig('99321', 'PARKER HANNIFIN - FL', { hasPartDetailsStep: true }),
  '93835': buildWarrantyTerminalStateVendorConfig('93835', 'PARKER HANNIFIN - MI', { hasPartDetailsStep: true }),
  '86329': buildWarrantyTerminalStateVendorConfig('86329', 'PARKER HANNIFIN-NICHOLS AIRBORNE', { hasPartDetailsStep: true }),

  // CLAUDE_CODE_PROMPT (Monica Gonzalez vendor batch, 2026-09-09) — 10 of
  // Monica Gonzalez's 11 assigned vendors (craAssignments.ts, craCode
  // 232134), added per explicit user direction confirming the same
  // vendor-code-search + BN-prefix-override + warranty-terminal-state
  // process every other vendor in this family uses. VC01187 is the one
  // vendor in this batch with a real recording
  // (discovery-VC01187-APAS-MG-recording.ts) — that recording shows the
  // standard flow end to end (Schedule Work Package, Purchasing Contact
  // 232134, Request Authorization), confirming this template is correct
  // for at least this vendor; the other 9 have no per-vendor recording and
  // are added on the same "let live testing confirm" basis the
  // 2026-08-14 batch above used, not a guess unique to this batch. The
  // The 11th assigned vendor, BAE SYSTEMS CONTROLS INC (63760), was
  // excluded in that batch ("skipped for now") and is now included below,
  // with the return-to rotation that was the reason it was held back.
  //
  // Purchasing Contact resolves automatically via craAssignments.ts for
  // every code below — not restated here.
  //
  // Not yet run live against real stage/production MXI for any of these
  // 10 codes. Per this project's own standing rule (vendorConfig.ts's own
  // docstring: "this does not remove the need for a first watched run per
  // vendor"), each one still needs its own first live, watched run before
  // being trusted for unattended use — this registry entry alone does not
  // constitute verification.
  VC00909: buildWarrantyTerminalStateVendorConfig('VC00909', 'AK-STRUCTURES, LLC'),
  VC00859: buildWarrantyTerminalStateVendorConfig('VC00859', 'ALLFLIGHT CORPORATION'),
  VC01187: buildWarrantyTerminalStateVendorConfig('VC01187', 'APAS - A PROFESSIONAL AVIATION SERVICES'),
  VC01208: buildWarrantyTerminalStateVendorConfig('VC01208', 'GLASS AERO, INC.'),
  '53117': buildWarrantyTerminalStateVendorConfig('53117', 'PPG INDUSTRIES INC'),
  VC01060: buildWarrantyTerminalStateVendorConfig('VC01060', 'PREFERRED COMPOSITE SERVICES, INC'),
  VC01224: buildWarrantyTerminalStateVendorConfig('VC01224', 'QT AEROSPACE'),
  '76725': buildWarrantyTerminalStateVendorConfig('76725', 'RATIER FIGEAC'),
  VC00529: buildWarrantyTerminalStateVendorConfig('VC00529', 'SUMMIT AEROSPACE INC'),
  VC00809: buildWarrantyTerminalStateVendorConfig('VC00809', 'WORTHINGTON MRO CENTER'),

  // CLAUDE_CODE_PROMPT (BAE Systems, 2026-09-10) — the 11th Monica
  // Gonzalez vendor, held back from the 2026-09-09 batch precisely because
  // of the exception below, now added per explicit user direction.
  //
  // THE EXCEPTION: its parts go back to exactly one of four docks, on a
  // fixed rotation in this order, rather than to the dock of whatever base
  // the part came out of. The rotation advances one step per successfully
  // written line and survives restarts — see
  // returnToLocationRotation.ts for where the pointer actually lives and
  // why it is derived from write-up history rather than a stored counter.
  //
  // Everything else about this vendor is the standard family template.
  // Like the other ten, it has not yet had a first live watched run.
  '63760': buildWarrantyTerminalStateVendorConfig('63760', 'BAE SYSTEMS CONTROLS INC', {
    returnToLocationRotation: {
      id: 'BAE_FOUR_DOCK_ROTATION',
      locations: ['PHL/DOCK', 'DCA/DOCK', 'CLT/DOCK', 'DAY/DOCK'],
    },
  }),

  // CLAUDE_CODE_PROMPT (Andres Sabido vendor batch, 2026-09-10) — the
  // remainder of Andres Sabido's vendors (craAssignments.ts, craCode
  // 232275), per explicit user direction: "follow the same process as
  // Rockwell - Seattle" — read as the standard family template (what
  // every other vendor below already uses), NOT a copy of 76863's own
  // Collins-specific overrides (COLLINSDISPATCH100/REPAIR-default), which
  // make sense for Rockwell/Collins entities but not for e.g. Northrop
  // Grumman or Hartwell Corporation — confirmed explicitly rather than
  // assumed.
  //
  // TWO of Andres's 18 assigned vendors are explicitly EXCLUDED (per
  // instruction: "follow a weird process"):
  //   - 1NQ67  INTELSAT INFLIGHT LLC
  //   - 3TAH8  "COLLINS - MONROE, NC" (vendor name literally carries
  //            surrounding quote characters in craAssignments.ts — not a
  //            typo introduced here)
  // 76863 (Rockwell - Seattle) and 7A9Y2 (SKYPAXXX) are already registered
  // above and are not repeated here.
  //
  // "DON'T MOVE TO DOCK", for every vendor in this batch: skipMoveToDock —
  // see VendorConfig's own docstring. Applies uniformly regardless of a
  // given vendor's own default terminal state; for the (typical)
  // AUTHORIZATION_ONLY default this has no effect (that path never
  // reaches Issue Order or Move to Dock at all), and only actually changes
  // behavior on the rarer ISSUE_AND_DOCK path (e.g. a BN-prefixed serial).
  // Harmless to set on every vendor either way, which is simpler and safer
  // than conditioning it on which terminal state a given vendor happens to
  // resolve to.
  //
  // CR<7|9>FLIGHTSENSE charge-to-account — per explicit user direction,
  // keyed on VENDOR identity (these three vendor names literally state
  // "coming out of" them), not a base-station rule like the HMV account
  // codes (chargeToAccount.ts) — genuinely different shape, so no shared
  // mechanism, just each vendor's own chargeToAccountSuffix.
  //
  // None of these 14 have had a first live watched run yet — same
  // standing rule as every other vendor batch here.
  '7WVJ2': buildWarrantyTerminalStateVendorConfig('7WVJ2', 'AERO HYDRAULIC INC', { skipMoveToDock: true }),
  VC00800: buildWarrantyTerminalStateVendorConfig('VC00800', 'AIRBORNE MX & ENG SVC (AMES)', { skipMoveToDock: true }),
  '89305': buildWarrantyTerminalStateVendorConfig('89305', 'COLLINS - VT', { skipMoveToDock: true, ...REPAIR_FLOW_ISSUED_NOT_DOCKED }),
  '0CAM5': buildWarrantyTerminalStateVendorConfig('0CAM5', 'HAM CARE - AZ', {
    skipMoveToDock: true,
    form: buildVendorFormConfig({ chargeToAccountSuffix: 'FLIGHTSENSE', notesHeader: WARRANTY_TERMINAL_STATE_NOTES_HEADER }),
    ...REPAIR_FLOW_ISSUED_NOT_DOCKED,
  }),
  '75818': buildWarrantyTerminalStateVendorConfig('75818', 'HAM SUND - FL', {
    skipMoveToDock: true,
    form: buildVendorFormConfig({ chargeToAccountSuffix: 'FLIGHTSENSE', notesHeader: WARRANTY_TERMINAL_STATE_NOTES_HEADER }),
    ...REPAIR_FLOW_ISSUED_NOT_DOCKED,
  }),
  '99167': buildWarrantyTerminalStateVendorConfig('99167', 'HAMILTON SUNDSTRAND AEROSPACE - IL', {
    skipMoveToDock: true,
    form: buildVendorFormConfig({ chargeToAccountSuffix: 'FLIGHTSENSE', notesHeader: WARRANTY_TERMINAL_STATE_NOTES_HEADER }),
    ...REPAIR_FLOW_ISSUED_NOT_DOCKED,
  }),
  '83014': buildWarrantyTerminalStateVendorConfig('83014', 'HARTWELL CORPORATION', { skipMoveToDock: true }),
  VC00462: buildWarrantyTerminalStateVendorConfig('VC00462', 'HYDRO-AIRE AEROSPACE CORP', { skipMoveToDock: true }),
  VC00730: buildWarrantyTerminalStateVendorConfig('VC00730', 'NORTHROP GRUMMAN SYSTEMS CORPORATION', { skipMoveToDock: true }),
  VC00679: buildWarrantyTerminalStateVendorConfig('VC00679', 'PERFORM AIR INTERNATIONAL INC', { skipMoveToDock: true }),
  VC00201: buildWarrantyTerminalStateVendorConfig('VC00201', 'REGIONAL AVIONICS REPAIR LLC', { skipMoveToDock: true }),
  '1SMU4': buildWarrantyTerminalStateVendorConfig('1SMU4', 'ROCKWELL COLLINS - ATLANTA', { skipMoveToDock: true, ...REPAIR_FLOW_ISSUED_NOT_DOCKED }),
  '6FVE5': buildWarrantyTerminalStateVendorConfig('6FVE5', 'ROCKWELL COLLINS - CALEXICO', { skipMoveToDock: true, ...REPAIR_FLOW_ISSUED_NOT_DOCKED }),
  '4X623': buildWarrantyTerminalStateVendorConfig('4X623', 'ROCKWELL COLLINS - WICHITA', { skipMoveToDock: true, ...REPAIR_FLOW_ISSUED_NOT_DOCKED }),

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
