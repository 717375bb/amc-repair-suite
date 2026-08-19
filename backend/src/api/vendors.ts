import { AERO_REPAIR_PART_NUMBERS } from '../writeUps/aeroRepair/constants.js';
import { VENDOR_REGISTRY } from '../writeUps/shared/vendorRegistry.js';
import { AERO_REPAIR_CRA_CODE, listCraGroups } from '../writeUps/shared/craAssignments.js';

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

export interface CraGroupEntry {
  craCode: string;
  craName: string;
  /** VendorListEntry ids (never raw vendor codes) — ready to feed straight into the existing selection Set. */
  vendorIds: string[];
}

/**
 * CLAUDE_CODE_PROMPT (CRA/vendor grouping, 2026-08-19) — the real CRA ->
 * vendor-code assignment table (craAssignments.ts) retains every vendor,
 * registered or not, per explicit user instruction. This function is what
 * actually narrows that down to "registered vendors only" for the live UI:
 * a CRA's group here only ever contains ids that are real, selectable
 * VendorListEntry ids (registry entries + Aero Repair), and a CRA with zero
 * registered vendors is dropped entirely rather than shown as an empty,
 * useless option in the dropdown.
 */
export function listCraGroupsForKnownVendors(): CraGroupEntry[] {
  return listCraGroups()
    .map((group) => {
      const vendorIds = new Set<string>();
      for (const vendorCode of group.vendorCodes) {
        const config = VENDOR_REGISTRY[vendorCode.trim().toUpperCase()];
        if (config) vendorIds.add(config.id);
      }
      // Aero Repair has no per-vendor-code registry entry of its own (see
      // craAssignments.ts's AERO_REPAIR_CRA_CODE doc comment) — included
      // once, on the one CRA group it's confirmed to belong to.
      if (group.craCode === AERO_REPAIR_CRA_CODE) {
        vendorIds.add(AERO_REPAIR_VENDOR_ID);
      }
      return { craCode: group.craCode, craName: group.craName, vendorIds: [...vendorIds] };
    })
    .filter((group) => group.vendorIds.length > 0);
}
