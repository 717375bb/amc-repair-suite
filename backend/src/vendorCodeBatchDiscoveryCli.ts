import 'dotenv/config';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { findCandidateLinesForVendorCode } from './writeUps/shared/vendorCodeWriteUp.js';
import { VENDOR_REGISTRY } from './writeUps/shared/vendorRegistry.js';
import {
  saveVendorCodeEligibleLines,
  VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH,
  type VendorCodeEligibleLineTarget,
} from './writeUps/shared/vendorCodeEligibleLinesFile.js';

/**
 * Read-only batch discovery across EVERY vendor registered in
 * shared/vendorRegistry.ts (0T1Y4 and onward — not Aero Repair, which has
 * its own separate two-command flow, aero-repair:batch-discovery /
 * aero-repair:batch-execute). Finds every real candidate line per vendor
 * via findCandidateLinesForVendorCode — pure grid reads, no clicking into
 * any individual line, no writes of any kind.
 *
 * Saves every candidate found (across all vendors) to
 * data/vendor-code-eligible-lines.json — the handoff file
 * vendor:batch-execute reads by default, same two-command pattern as Aero
 * Repair's own daily workflow.
 *
 * Usage: npm run vendor:batch-discovery -- [--env production]
 */
async function main(): Promise<void> {
  const { env } = parseEnvFlag(process.argv.slice(2));
  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  console.log('Read-only batch discovery across every registered vendor — no writes, no order creation.');

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const page = await client.getAuthenticatedPage();

    const allLines: VendorCodeEligibleLineTarget[] = [];
    const vendorCodes = Object.keys(VENDOR_REGISTRY);

    for (const vendorCode of vendorCodes) {
      const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);
      console.log(`  ${vendorCode}: ${candidates.length} real candidate line(s) found.`);
      for (const c of candidates) {
        allLines.push({ vendorCode, partNumber: c.partNumber, serialNumber: c.serialNumber });
      }
    }

    await saveVendorCodeEligibleLines(env, allLines);

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total real candidate lines across ${vendorCodes.length} vendor(s): ${allLines.length}`);
    for (const line of allLines) {
      console.log(`  [${line.vendorCode}] ${line.partNumber} / SN "${line.serialNumber}"`);
    }
    console.log(
      `\nSaved to ${VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH}. Run this next to process everything found:\n` +
        `  npm run vendor:batch-execute -- --env ${env}`,
    );
  } catch (err) {
    console.error('Vendor batch discovery failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
