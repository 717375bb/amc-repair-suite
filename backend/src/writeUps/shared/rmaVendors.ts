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
 * Activated 2026-08-14: exactly 3 vendors from the new 26-vendor batch need
 * RMA per explicit user instruction — DUCOMMUN TECHONOLGIES (8719),
 * LEACH - CA (58657), ROTRON INC. (75521). Two other codes the user
 * initially named (VC00664, 0DLY8) are real vendors but explicitly deferred
 * ("different processes... skip today") — not added here. None of
 * 76863/4X623/6FVE5/75818/1DH10/VC00399/7A9Y2 (the original family) are RMA
 * vendors. Codes are the real vendor codes, matching VENDOR_REGISTRY's own
 * keys (case-insensitive via getVendorConfig's existing normalization, but
 * stored upper-case here to match VENDOR_REGISTRY's own convention).
 */
export const RMA_VENDOR_IDS: ReadonlySet<string> = new Set<string>(['8719', '58657', '75521']);

export function isRmaVendor(config: VendorConfig): boolean {
  return config.search.kind === 'vendorCode' && RMA_VENDOR_IDS.has(config.search.vendorCode.toUpperCase());
}
