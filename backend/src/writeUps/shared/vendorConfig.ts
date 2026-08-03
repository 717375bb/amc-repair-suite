/**
 * Shared vendor-config types, per VENDOR_MODULE_REFACTOR_SPEC.md section 3.1.
 * No Playwright/page logic here — pure types + the one resolution function
 * that reads them. See the spec doc for which vendor uses which shape.
 */

export type TerminalState = 'ISSUE_AND_DOCK' | 'AUTHORIZATION_ONLY';
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

export interface VendorConfig {
  id: string;
  displayName: string;
  search: VendorSearchStrategy;
  form: VendorFormConfig;
  authFlowPolicy: AuthFlowPolicy;
  defaultTerminalState: TerminalState;
  warrantyEligible: boolean;
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
export const WARRANTY_TERMINAL_STATE_NOTES_HEADER = 'INSPECT AND SERVICE AS REQUIRED';

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
  overrides?: Partial<Pick<VendorConfig, 'form' | 'authFlowPolicy' | 'defaultTerminalState' | 'warrantyEligible'>>,
): VendorConfig {
  return {
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
}

export function resolveAuthFlowPolicy(serialNumber: string, config: VendorConfig): ResolvedAuthFlowPolicy {
  const normalized = serialNumber.trim().toUpperCase();

  for (const override of config.authFlowPolicy.overrides) {
    const prefix = override.when.serialNumberPrefix.trim().toUpperCase();
    if (normalized.startsWith(prefix)) {
      console.log(
        `[vendor-config] ${config.id}: serial "${serialNumber}" matched override "${override.id}" ` +
          `(prefix "${prefix}") -> authFlow="${override.authFlow}", terminalState="${override.terminalState}", ` +
          `usageTable="${override.usageTable}".`,
      );
      return {
        authFlow: override.authFlow,
        terminalState: override.terminalState,
        usageTableExpectation: override.usageTable,
        matchedOverrideId: override.id,
      };
    }
  }

  console.log(
    `[vendor-config] ${config.id}: serial "${serialNumber}" matched no override -> default authFlow=` +
      `"${config.authFlowPolicy.default}", terminalState="${config.defaultTerminalState}".`,
  );
  return {
    authFlow: config.authFlowPolicy.default,
    terminalState: config.defaultTerminalState,
    usageTableExpectation: 'expectedPresent',
    matchedOverrideId: null,
  };
}
