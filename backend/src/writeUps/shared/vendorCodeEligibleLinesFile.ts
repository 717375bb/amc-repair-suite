import fs from 'node:fs/promises';
import path from 'node:path';

export const VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH = path.join('data', 'vendor-code-eligible-lines.json');

export interface VendorCodeEligibleLineTarget {
  vendorCode: string;
  partNumber: string;
  serialNumber: string;
}

export interface VendorCodeEligibleLinesFile {
  generatedAt: string;
  env: string;
  lines: VendorCodeEligibleLineTarget[];
}

/**
 * Handoff file between vendorCodeBatchDiscoveryCli and
 * vendorCodeBatchExecuteCli — same pattern as Aero Repair's own
 * eligibleLinesFile.ts, extended with vendorCode per line since this
 * covers every vendor in shared/vendorRegistry.ts in one file, not just
 * one vendor. Written unconditionally, even when 0 lines are found across
 * every vendor — that's a real, valid result batch-execute needs to see.
 */
export async function saveVendorCodeEligibleLines(env: string, lines: VendorCodeEligibleLineTarget[]): Promise<void> {
  const contents: VendorCodeEligibleLinesFile = { generatedAt: new Date().toISOString(), env, lines };
  await fs.mkdir(path.dirname(VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH), { recursive: true });
  await fs.writeFile(VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH, JSON.stringify(contents, null, 2), 'utf-8');
}

export async function loadVendorCodeEligibleLines(): Promise<VendorCodeEligibleLinesFile | null> {
  try {
    const raw = await fs.readFile(VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH, 'utf-8');
    return JSON.parse(raw) as VendorCodeEligibleLinesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
