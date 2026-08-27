import { createLogger } from '../../logging/logger.js';
import { resolvePurchasingContactForVendorCode } from './craAssignments.js';

const log = createLogger('writeup');

/**
 * Shared vendor-config types, per VENDOR_MODULE_REFACTOR_SPEC.md section 3.1.
 * No Playwright/page logic here — pure types + the one resolution function
 * that reads them. See the spec doc for which vendor uses which shape.
 */

/**
 * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — a third
 * terminal state alongside the original two: the RO is created (Schedule
 * Work Package runs normally) but Request Authorization/Issue Order/Move
 * to Dock are never reached. Currently only ever entered via the single,
 * explicit zero-usage-on-a-USSTG-line allowlist (see
 * shared/createOrderOnly.ts) — never a normal per-vendor default the way
 * the other two states are (no VendorConfig field sets this as its
 * defaultTerminalState).
 */
export type TerminalState = 'ISSUE_AND_DOCK' | 'AUTHORIZATION_ONLY' | 'CREATE_ORDER_ONLY';
export type UsageTableExpectation = 'expectedPresent' | 'expectedAbsent';

export interface AuthFlowOverride {
  /** Human-readable id for logging/audit, e.g. "BN_SERIAL_REPAIR_FLOW". */
  id: string;
  when: { serialNumberPrefix: string };
  authFlow: string;
  terminalState: TerminalState;
  usageTable: UsageTableExpectation;
}

export interface AuthFlowPolicy {
  /** Auth Flow label used when no override matches. */
  default: string;
  overrides: AuthFlowOverride[];
}

export interface VendorFormConfig {
  purchasingContact: string;
  conditions: string;
  transportation: string;
  chargeToAccountSuffix: string;
  notesHeader: string;
}

/**
 * Documents each vendor's real line-discovery mechanism — genuinely
 * different UI flows per VENDOR_MODULE_REFACTOR_SPEC.md section 2's table
 * (Aero Repair: a fixed OEM part-number list + station routing; 0T1Y4: a
 * single Vendor/Shop code search, no routing at all). Not consumed by a
 * generic dispatcher — each vendor's own module implements its own search
 * using this as documentation/shape validation, same pattern as `form`.
 */
export type VendorSearchStrategy =
  | { kind: 'vendorCode'; vendorCode: string }
  | { kind: 'partNumberList'; partNumbers: readonly string[] };

/**
 * CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case) — a vendor-level case
 * triggered by a signal the existing AuthFlowOverride mechanism can't
 * express (a home-page grid-row TASK NAME, not a serial-number prefix), and
 * whose deltas span far more than authFlow/terminalState/usageTable (it
 * also touches transportation, notes, charge-to-account, and two guard
 * suppressions). Deliberately a SEPARATE mechanism from AuthFlowOverride
 * rather than shoehorned into it — the two triggers and their field sets
 * don't overlap enough to unify without forcing every non-7A9Y2 vendor to
 * carry irrelevant fields. See resolveShipsetCase() below for how this is
 * matched, and vendorCodeWriteUp.ts's runVendorCodeWriteUp() for where each
 * field is consumed.
 */
export interface ShipsetCaseConfig {
  /** Human-readable id for logging/audit, e.g. "SEAT_REFRESH_SHIPSET". */
  id: string;
  /** Exact text expected on the USSTG line's own Task column — matched character-for-character, read BEFORE the line is opened. */
  expectedUsstgTaskName: string;
  /** null = skip the Transportation Type step entirely (leave whatever MXI already shows untouched) — never an empty-string value that gets typed in. */
  transportationType: string | null;
  authFlow: string;
  terminalState: TerminalState;
  /** The exact, fixed Note to Vendor text for this case — never composed from usage/part data. */
  notesText: string;
  /** false = skip the Move to Dock step after Issue Order on this run (temporary safety measure — flip to re-enable, no code change needed). */
  moveToDockOnInitialRun: boolean;
  /** true = a missing assigned task is not a blocker for this case — log and continue, never attempt Ad-Hoc creation or return an exception for it. */
  allowMissingAssignedTask: boolean;
  /** Always written literally, regardless of what MXI autofills — never derived via buildChargeToAccountWithSuffix. */
  chargeToAccount: string;
}

export interface VendorConfig {
  id: string;
  displayName: string;
  search: VendorSearchStrategy;
  form: VendorFormConfig;
  authFlowPolicy: AuthFlowPolicy;
  defaultTerminalState: TerminalState;
  warrantyEligible: boolean;
  /** Optional — only vendors with a genuine alternate-case trigger (today: just 7A9Y2) set this. */
  shipsetCase?: ShipsetCaseConfig;
  /**
   * CLAUDE_CODE_PROMPT (#1, new vendors) — optional. True for vendors whose
   * real recording shows (or, for the 2026-08-14 batch, are expected by
   * explicit user instruction to show) a part-level "Details" step (a
   * receiving-notes box that may carry a special charge-to-account code)
   * before Schedule Work Package. Originally confirmed present only for
   * 76863 and 1DH10 (confirmed ABSENT for 4X623/6FVE5/75818/VC00399) — the
   * 2026-08-14 batch enables it for all 26 new vendors regardless, per
   * explicit instruction to let live testing confirm rather than guess
   * per-vendor. Undefined/false means the step is skipped entirely. Live:
   * shared/vendorCodeWriteUp.ts reads the receiving-notes text and flags
   * (returns 'receiving_notes_flagged_account', no write) any line whose
   * notes mention "account" (case-insensitive) — not just logged anymore.
   */
  hasPartDetailsStep?: boolean;
  /**
   * Read the part's removal date from Historical > Additional and put
   * "Removal date: DD-MMM-YYYY" in the Note To Vendor, directly above the
   * times and cycles table.
   *
   * Aerotron (2N512) only today, per explicit user direction. A per-vendor
   * opt-in rather than engine-wide: every other vendor's note stays
   * byte-for-byte identical, and turning it on for another vendor later is
   * one flag, not a code change.
   */
  needsRemovalDateInNotes?: boolean;
  /**
   * Preferred-vendor check (all vendors except Aero Repair, which never
   * consumes VendorConfig at all). Broad by explicit user instruction for
   * now ("all non-Aero-Repair parts", not narrowed to multi-vendor-bid
   * lines specifically) — this flag exists so narrowing later is a config
   * change, not a rewrite. Undefined/true = checked (the default, broad
   * behavior); explicit false = skipped for that vendor.
   */
  checkPreferredVendor?: boolean;
}

/**
 * Resolves whether the shipset case applies, from the USSTG line's own
 * home-page task name (read BEFORE the line is opened — the task name
 * inside the work package can be blank and reading from there causes false
 * negatives, per explicit instruction). Logs which branch was taken and the
 * exact text read, win or lose, so a mis-detection is diagnosable from the
 * run log alone. Returns null for any vendor with no shipsetCase configured
 * at all (the overwhelming majority) — a single cheap check, not a
 * meaningful branch, for those vendors.
 */
export function resolveShipsetCase(usstgTaskName: string | null, config: VendorConfig): ShipsetCaseConfig | null {
  if (!config.shipsetCase) return null;

  const matched = usstgTaskName !== null && usstgTaskName.trim() === config.shipsetCase.expectedUsstgTaskName.trim();
  log.info(
    {
      vendorConfigId: config.id,
      usstgTaskName,
      expectedUsstgTaskName: config.shipsetCase.expectedUsstgTaskName,
      matched,
      shipsetCaseId: matched ? config.shipsetCase.id : null,
    },
    '[vendor-config] USSTG line task name read',
  );
  return matched ? config.shipsetCase : null;
}

/**
 * Purchasing Contact / Terms & Conditions / Transport Type, per explicit
 * user instruction: these are confirmed GLOBAL MXI dropdowns/fields, not
 * vendor-scoped (Aero Repair's own NET30/717375 values, and 0T1Y4's
 * FEDEX-2, were confirmed via a single live read-only query against an
 * EXISTING Aero Repair production form — see
 * discovery-confirmGlobalDropdownLabels.ts). Every vendor's
 * VendorFormConfig inherits these via buildVendorFormConfig() unless it
 * explicitly overrides one. Aero Repair is the sole current exception
 * (overrides transportation to 'PICKUP' — see aeroRepair/vendorConfig.ts).
 * Every future vendor (0T1Y4 onward) inherits the default rather than
 * restating these three values.
 */
export const DEFAULT_VENDOR_FORM_DEFAULTS: {
  purchasingContact: string;
  conditions: string;
  transportation: string;
} = {
  purchasingContact: '717375',
  conditions: 'NET30',
  transportation: 'FEDEX-2',
};

/**
 * Merges a vendor's own required fields (chargeToAccountSuffix, notesHeader
 * — always genuinely vendor-specific) with DEFAULT_VENDOR_FORM_DEFAULTS,
 * letting the vendor override any of the three global defaults it
 * genuinely needs to (Aero Repair overrides transportation only).
 */
export function buildVendorFormConfig(
  vendorSpecific: Pick<VendorFormConfig, 'chargeToAccountSuffix' | 'notesHeader'> &
    Partial<Pick<VendorFormConfig, 'purchasingContact' | 'conditions' | 'transportation'>>,
): VendorFormConfig {
  return { ...DEFAULT_VENDOR_FORM_DEFAULTS, ...vendorSpecific };
}

export interface ResolvedAuthFlowPolicy {
  authFlow: string;
  terminalState: TerminalState;
  usageTableExpectation: UsageTableExpectation;
  matchedOverrideId: string | null;
}

/**
 * Resolves the real Auth Flow / terminal-state / usage-table-expectation for
 * one specific serial number against a vendor's policy — a real dispatch
 * decision for a real production write, so it logs which branch fired rather
 * than resolving silently. Normalizes the serial (trim + uppercase) before
 * prefix-matching, same discipline as noTaskException.ts's whitespace
 * normalization elsewhere in this project. First matching override wins;
 * falls back to the vendor's own default + defaultTerminalState +
 * 'expectedPresent' if nothing matches.
 *
 * Applied to Aero Repair (see aeroRepair/vendorConfig.ts): zero overrides
 * ever match, so every real line resolves to the same
 * authFlow/terminalState it already gets today from the AUTH_FLOW constant
 * and the always-issue-and-dock flow — this function documents that
 * behavior as config, it does not change it.
 */
/**
 * Global MXI Auth Flow dropdown's two real, confirmed labels (same
 * dropdown Aero Repair's own AUTH_FLOW constant uses for the REPAIR side).
 */
export const AUTH_FLOW_WARRANTY = 'WARRANTY (Warranty Authorization)';
export const AUTH_FLOW_REPAIR = 'REPAIR (Repair Authorization)';

/**
 * Confirmed real BN-prefix serial-number shape: always "BN" + one space +
 * digits (e.g. "BN 394368"). Includes the trailing space deliberately — a
 * plain "BN" prefix match (no space) would also match any hypothetical
 * serial merely starting with the letters "BN" with no space, which isn't
 * the confirmed real format.
 */
export const BN_SERIAL_PREFIX = 'BN ';

/** Real recorded permanent Notes-field header text for this vendor family. */
export const WARRANTY_TERMINAL_STATE_NOTES_HEADER = 'Inspect and service as required. Provide estimate for approval. Provide new 8130 with times and cycles and SFR. Provide new certificate and test data sheet.';

/** Charge-to-account suffix confirmed in both real recordings for this vendor family. */
export const WARRANTY_TERMINAL_STATE_CHARGE_TO_ACCOUNT_SUFFIX = 'REPAIR';

/**
 * Builds a complete VendorConfig for the "vendor-code search + BN-prefix
 * override + warranty terminal state" process — the exact process 0T1Y4
 * uses, confirmed by explicit user direction to be genuinely identical for
 * every vendor using this same mechanism. Adding a new vendor to this
 * family is a single call: `buildWarrantyTerminalStateVendorConfig('XXXXX',
 * 'Vendor XXXXX')` — see shared/vendorRegistry.ts. `overrides` lets a
 * future vendor deviate from any specific piece of this template without
 * requiring another refactor, same escape-hatch pattern as
 * buildVendorFormConfig's own per-field overrides.
 */
export function buildWarrantyTerminalStateVendorConfig(
  vendorCode: string,
  displayName: string,
  overrides?: Partial<
    Pick<VendorConfig, 'form' | 'authFlowPolicy' | 'defaultTerminalState' | 'warrantyEligible' | 'shipsetCase' | 'hasPartDetailsStep' | 'needsRemovalDateInNotes'>
  >,
): VendorConfig {
  // CLAUDE_CODE_PROMPT (CRA/vendor grouping, 2026-08-19) — every vendor in
  // this family gets its Purchasing Contact from the real CRA assignment
  // table (craAssignments.ts), keyed by this vendor's own real MXI vendor
  // code, applied AFTER `overrides` below rather than merged into the base
  // `form` — a vendor-specific override that replaces `form` wholesale
  // (e.g. 76863's COLLINSDISPATCH100 charge-to-account) would otherwise
  // silently lose this and fall back to the stale global default.
  const purchasingContact = resolvePurchasingContactForVendorCode(vendorCode);
  const merged: VendorConfig = {
    id: vendorCode.toLowerCase(),
    displayName,
    search: { kind: 'vendorCode', vendorCode },
    form: buildVendorFormConfig({
      chargeToAccountSuffix: WARRANTY_TERMINAL_STATE_CHARGE_TO_ACCOUNT_SUFFIX,
      notesHeader: WARRANTY_TERMINAL_STATE_NOTES_HEADER,
    }),
    authFlowPolicy: {
      default: AUTH_FLOW_WARRANTY,
      overrides: [
        {
          id: 'BN_SERIAL_REPAIR_FLOW',
          when: { serialNumberPrefix: BN_SERIAL_PREFIX },
          authFlow: AUTH_FLOW_REPAIR,
          terminalState: 'ISSUE_AND_DOCK',
          usageTable: 'expectedAbsent',
        },
      ],
    },
    defaultTerminalState: 'AUTHORIZATION_ONLY',
    warrantyEligible: true,
    ...overrides,
  };
  merged.form = { ...merged.form, purchasingContact };
  return merged;
}

export function resolveAuthFlowPolicy(serialNumber: string, config: VendorConfig): ResolvedAuthFlowPolicy {
  const normalized = serialNumber.trim().toUpperCase();

  for (const override of config.authFlowPolicy.overrides) {
    const prefix = override.when.serialNumberPrefix.trim().toUpperCase();
    if (normalized.startsWith(prefix)) {
      log.info(
        {
          vendorConfigId: config.id,
          serialNumber,
          overrideId: override.id,
          prefix,
          authFlow: override.authFlow,
          terminalState: override.terminalState,
          usageTable: override.usageTable,
        },
        '[vendor-config] serial matched override',
      );
      return {
        authFlow: override.authFlow,
        terminalState: override.terminalState,
        usageTableExpectation: override.usageTable,
        matchedOverrideId: override.id,
      };
    }
  }

  log.info(
    {
      vendorConfigId: config.id,
      serialNumber,
      defaultAuthFlow: config.authFlowPolicy.default,
      terminalState: config.defaultTerminalState,
    },
    '[vendor-config] serial matched no override — using default',
  );
  return {
    authFlow: config.authFlowPolicy.default,
    terminalState: config.defaultTerminalState,
    usageTableExpectation: 'expectedPresent',
    matchedOverrideId: null,
  };
}
