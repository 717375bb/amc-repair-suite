import { buildWarrantyTerminalStateVendorConfig, type VendorConfig } from './vendorConfig.js';

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
