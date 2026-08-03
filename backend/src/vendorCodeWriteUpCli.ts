import 'dotenv/config';
import path from 'node:path';
import { openDb } from './db/db.js';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { runVendorCodeWriteUp } from './writeUps/shared/vendorCodeWriteUp.js';
import { getVendorConfig } from './writeUps/shared/vendorRegistry.js';
import { logVendorCodeOutcome } from './writeUps/shared/vendorCodeOutcomeLogging.js';

/**
 * Generic, single-line, manually-invoked CLI for any vendor in
 * shared/vendorRegistry.ts's "vendor-code search + BN-prefix override +
 * warranty terminal state" family. For running every registered vendor at
 * once, see vendorCodeBatchDiscoveryCli.ts / vendorCodeBatchExecuteCli.ts —
 * this one is for targeting a single vendor/line directly (e.g. a first
 * watched proof run for a brand-new vendor, or retrying one specific line).
 *
 * Does NOT stop before Issue Order — VENDOR_MODULE_REFACTOR_SPEC.md
 * section 3.2's structural terminal-state dispatch means a BN-prefix
 * line's ISSUE_AND_DOCK path genuinely issues and docks for real inside
 * runVendorCodeWriteUp() itself. A normal (non-BN) line's
 * AUTHORIZATION_ONLY path never reaches Issue Order at all, by the same
 * structural guarantee.
 *
 * Usage: npm run vendor:write-up -- <vendorCode> [serialNumber] [--env production]
 *   serialNumber optional — omit to process whichever candidate line for
 *   this vendor code is matched first.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const vendorCode = rest[0];
  const preferredSerialNumber = rest[1];

  if (!vendorCode) {
    console.error('Usage: npm run vendor:write-up -- <vendorCode> [serialNumber] [--env production]');
    process.exitCode = 1;
    return;
  }

  const config = getVendorConfig(vendorCode);

  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  console.log(`Vendor ${config.displayName} (${config.id}) — single-line, manually-invoked write-up.`);

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);
    const outcome = await runVendorCodeWriteUp(client, config, preferredSerialNumber);
    const { success } = logVendorCodeOutcome(db, config, env, outcome);
    if (!success) process.exitCode = 1;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`Vendor ${config.id} write-up CLI failed:`, errorMessage);
    logVendorCodeOutcome(db, config, env, { status: 'error', partNumber: null, serialNumber: null, errorMessage });
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
