import { AERO_REPAIR_PART_NUMBERS } from '../writeUps/aeroRepair/constants.js';
import { VENDOR_REGISTRY } from '../writeUps/shared/vendorRegistry.js';

/**
 * "vendor" in this API is a broader concept than shared/vendorRegistry.ts's
 * own VENDOR_REGISTRY — that registry is specifically the "vendor-code
 * search + BN-prefix override + warranty terminal state" family (0T1Y4 and
 * its siblings). Aero Repair is a structurally different module (fixed
 * OEM part-number list + station routing, its own discovery/write-up code)
 * with no entry in that registry at all. Both are real, independently
 * selectable write-up workflows from the UI's point of view, so this
 * module composes one list from both real sources — never a hardcoded
 * vendor name or count on either side.
 */
export type VendorSearchKind = 'partNumber' | 'vendorCode';

export interface VendorListEntry {
  id: string;
  /** The vendor code itself (e.g. "0T1Y4") — only present for searchKind: 'vendorCode' entries. */
  code?: string;
  displayName: string;
  searchKind: VendorSearchKind;
}

export const AERO_REPAIR_VENDOR_ID = 'aeroRepair';

export function listVendors(): VendorListEntry[] {
  const aeroRepair: VendorListEntry = {
    id: AERO_REPAIR_VENDOR_ID,
    displayName: 'Aero Repair',
    searchKind: 'partNumber',
  };

  const vendorCodeVendors: VendorListEntry[] = Object.values(VENDOR_REGISTRY).map((config) => ({
    id: config.id,
    code: config.search.kind === 'vendorCode' ? config.search.vendorCode : undefined,
    displayName: config.displayName,
    searchKind: 'vendorCode' as const,
  }));

  return [aeroRepair, ...vendorCodeVendors];
}

/** True count sourced from the real constant, not a hardcoded "6" anywhere in the API layer. */
export function aeroRepairPartNumberCount(): number {
  return AERO_REPAIR_PART_NUMBERS.length;
}

export function isKnownVendorId(vendorId: string): boolean {
  if (vendorId === AERO_REPAIR_VENDOR_ID) return true;
  return Object.values(VENDOR_REGISTRY).some((c) => c.id === vendorId);
}
