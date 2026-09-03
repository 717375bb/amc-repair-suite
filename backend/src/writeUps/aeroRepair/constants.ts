import { DEFAULT_VENDOR_FORM_DEFAULTS } from '../shared/vendorConfig.js';
export { NO_UNASSIGNED_TASKS_TEXT } from '../shared/unassignedTasks.js';

/**
 * Aero Repair write-up constants. Vendor-specific by design — this project
 * will get one module per vendor as more write-up flows are added; nothing
 * in here is meant to be reused by a future vendor's module.
 *
 * Every value below traces to either the real `discovery-writeOrder-recording.ts`
 * codegen recording against stage MXI, or an explicit user confirmation where
 * the recording conflicted with the original ask (see PURCHASING_CONTACT).
 */

/**
 * 12-station routing table: station code -> Aero Repair location. Values
 * are the REAL vendor name strings as shown in stage MXI's Vendors/Shops
 * list — not just descriptive labels — because this location string is
 * now also used to select the matching vendor radio (see
 * partDetails.ts's selectVendorRadioForRouting). Two of the four real
 * names don't follow the pattern you'd guess from the other two:
 * confirmed live, "AERO REPAIR GEORGIA" has NO hyphen (unlike "AERO REPAIR
 * - INDY" and "AERO REPAIR - NH"), and DFW's real vendor name includes
 * "CORP" ("AERO REPAIR CORP - DFW", not "AERO REPAIR - DFW"). All four
 * confirmed directly from real Vendors/Shops rows across multiple lines,
 * not assumed from the pattern of the other two.
 */
export const AERO_REPAIR_ROUTING: Readonly<Record<string, string>> = Object.freeze({
  CAK: 'AERO REPAIR - INDY',
  DAY: 'AERO REPAIR - INDY',
  CVG: 'AERO REPAIR - INDY',
  SAV: 'AERO REPAIR GEORGIA',
  PNS: 'AERO REPAIR GEORGIA',
  GSP: 'AERO REPAIR GEORGIA',
  CLT: 'AERO REPAIR GEORGIA',
  ORF: 'AERO REPAIR GEORGIA',
  TYS: 'AERO REPAIR GEORGIA',
  DCA: 'AERO REPAIR - NH',
  PHL: 'AERO REPAIR - NH',
  DFW: 'AERO REPAIR CORP - DFW',
});

/**
 * Recorded value: `#idEditFieldPurchasingContact` was filled with "717375" in
 * the real recording. The original task description said 717374 — user
 * confirmed via direct question that the recording (717375) is correct and
 * the written instruction was the typo. Per VENDOR_MODULE_REFACTOR_SPEC.md,
 * Purchasing Contact is a confirmed GLOBAL MXI default (not vendor-scoped)
 * — sourced from shared/vendorConfig.ts's DEFAULT_VENDOR_FORM_DEFAULTS,
 * same "717375" value, single source of truth now.
 */
export const PURCHASING_CONTACT = DEFAULT_VENDOR_FORM_DEFAULTS.purchasingContact;

/**
 * Confirmed via a live, read-only query of #idDropdownTermsConditions'
 * actual <option> elements (not selectOption, which would only reveal
 * success/failure against a guess) — the real visible label is "NET30"
 * (no space, all caps, no hyphen), not "Net 30". Other NET30-ish options
 * also exist (1-NET30, 2-NET30, 2-10N30, etc.) but plain "NET30" is the
 * closest verbatim match to the original ask. Confirmed GLOBAL MXI default
 * (not vendor-scoped) — sourced from shared/vendorConfig.ts's
 * DEFAULT_VENDOR_FORM_DEFAULTS, same "NET30" value.
 */
export const CONDITIONS_LABEL = DEFAULT_VENDOR_FORM_DEFAULTS.conditions;

/**
 * Confirmed via the same live query of #idDropdownTransportType — the
 * real visible label is "PICKUP" (no space, all caps), not "Pick Up".
 * Aero Repair is the sole vendor that overrides the shared global default
 * (FEDEX-2, per DEFAULT_VENDOR_FORM_DEFAULTS) — every future vendor
 * inherits FEDEX-2 unless it has its own real reason to override it too.
 */
export const TRANSPORTATION_LABEL = 'PICKUP';

/**
 * Confirmed via a live, read-only query of #idDropdownAuthFlows' actual
 * <option> elements — the real dropdown has exactly two options,
 * "REPAIR (Repair Authorization)" and "WARRANTY (Warranty Authorization)".
 * Bare "Repair" (the earlier assumed value) doesn't exist verbatim —
 * selectOption({label}) requires an exact match against the full visible
 * text, so this must be the complete string, not just the leading word.
 */
export const AUTH_FLOW = 'REPAIR (Repair Authorization)';

/** Charge-to-account: the fixed replacement text for the routine/non-routine phrase. */
export const CHARGE_TO_ACCOUNT_REPLACEMENT = 'WHEELSBRAKES';

/**
 * Real recorded permanent Notes-field header text, verbatim (all caps, no
 * trailing punctuation) — confirmed twice in the recording (a standalone
 * fill, then as the literal prefix of the final combined fill).
 */
export const NOTES_HEADER_TEXT = 'Inspect and service as required. Provide estimate for approval. Provide new 8130 with times and cycles and SFR. Provide new certificate and test data sheet.';

/**
 * Confirmed via a live .innerText() read of the real "Assigned Tasks" tab
 * — the DEFAULT view landed on immediately after clicking a part's repair
 * link, BEFORE any "Unassigned"/"Unassigned Tasks" navigation. This is the
 * originally-assumed text, and it turns out to be exactly right — it was
 * never wrong, it was being checked in the wrong PLACE.
 *
 * Real correction made this session, in both directions: the "Unassigned
 * Tasks" sub-tab shows a completely different message ("There are no open
 * tasks for this inventory item or any of its sub-inventory items.") which
 * is the NORMAL/expected state and must NOT block anything (per explicit
 * user clarification) — every real line checked shows it, including lines
 * with genuine assigned work. The actual blocking condition lives on the
 * default "Assigned Tasks" tab instead: confirmed empty for PN 14700AA /
 * BN 389428 (shows exactly this string), and confirmed NON-empty for
 * 90001200-1 / SN JUN14-2448 (shows a real task row, "REMOVED LH IB WHEEL
 * AND TIRE FOM", no such message) — both directions verified live.
 */
export const NO_TASKS_ASSIGNED_TEXT = 'There are no tasks assigned to this work package.';

// NO_UNASSIGNED_TASKS_TEXT re-exported at top of file (moved to
// shared/unassignedTasks.ts — confirmed vendor-agnostic by a second real
// vendor, 0T1Y4).

/** The 6 real Aero Repair part numbers this write-up flow applies to. */
export const AERO_REPAIR_PART_NUMBERS: readonly string[] = Object.freeze([
  '5013640',
  '5013641',
  '5013642-1',
  '90001200-1',
  '90001201-1',
  '90001201-2',
  '90001200-1WT',
]);
