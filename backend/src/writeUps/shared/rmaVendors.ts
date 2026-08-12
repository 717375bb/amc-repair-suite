import type { VendorConfig } from './vendorConfig.js';

/**
 * CLAUDE_CODE_PROMPT (#1, RMA framework) — a pure vendor-MEMBERSHIP rule, no
 * notes/content scan involved (deliberately different mechanism from the
 * charge-to-account special-code check — those are independent concerns).
 * An RMA vendor's order gets written (Schedule Work Package runs normally —
 * same notes/charge-to-account/etc. as any other line) but is never
 * authorized, issued, or docked; shared/vendorCodeWriteUp.ts sets its Order
 * External Reference to indicate the order is awaiting RMA (via the same
 * order-level Details -> Edit PO Details -> aPOExternalReference path
 * shared/createOrderOnly.ts already uses for CREATE_ORDER_ONLY) and stops.
 *
 * Deliberately built now, dormant: the membership list is empty for this
 * batch (none of 76863/4X623/6FVE5/75818/1DH10/VC00399/7A9Y2 are RMA
 * vendors) — this is the hook a future vendor gets added to, not code to
 * exercise yet. Codes are the real vendor codes, matching VENDOR_REGISTRY's
 * own keys (case-insensitive via getVendorConfig's existing normalization,
 * but stored upper-case here to match VENDOR_REGISTRY's own convention).
 */
export const RMA_VENDOR_IDS: ReadonlySet<string> = new Set<string>([]);

export function isRmaVendor(config: VendorConfig): boolean {
  return config.search.kind === 'vendorCode' && RMA_VENDOR_IDS.has(config.search.vendorCode.toUpperCase());
}
