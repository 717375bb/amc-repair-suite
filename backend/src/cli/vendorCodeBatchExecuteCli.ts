import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { runVendorCodeWriteUp } from '../writeUps/shared/vendorCodeWriteUp.js';
import { getVendorConfig } from '../writeUps/shared/vendorRegistry.js';
import { logVendorCodeOutcome } from '../writeUps/shared/vendorCodeOutcomeLogging.js';
import { loadVendorCodeEligibleLines, type VendorCodeEligibleLineTarget } from '../writeUps/shared/vendorCodeEligibleLinesFile.js';

/**
 * Processes every line saved by vendor:batch-discovery (or explicit
 * targets), across every vendor, one at a time — same two-command daily
 * pattern as Aero Repair's own aero-repair:batch-discovery /
 * aero-repair:batch-execute.
 *
 * Does NOT stop before Issue Order — a BN-prefix line's ISSUE_AND_DOCK
 * path genuinely issues and docks for real inside runVendorCodeWriteUp()
 * itself (VENDOR_MODULE_REFACTOR_SPEC.md section 3.2's structural
 * dispatch). A normal (non-BN) line's AUTHORIZATION_ONLY path never
 * reaches Issue Order at all, by the same structural guarantee.
 *
 * On any unexpected failure partway through a line, logs it and moves on
 * to the next — never halts the whole batch over one line's exception.
 * Session/login loss is the one exception that halts entirely.
 *
 * Usage:
 *   npm run vendor:batch-execute -- --env production
 *     No targets given -> reads data/vendor-code-eligible-lines.json
 *     (written by the last vendor:batch-discovery run for this same env)
 *     and processes every line in it.
 *   npm run vendor:batch-execute -- <vendorCode>:<serialNumber> [more...] [--env production]
 *     Explicit targets override the file entirely.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const explicitTargets: VendorCodeEligibleLineTarget[] = rest
    .filter((arg) => arg.includes(':'))
    .map((arg) => {
      const idx = arg.indexOf(':');
      return { vendorCode: arg.slice(0, idx), serialNumber: arg.slice(idx + 1), partNumber: '(unknown)' };
    });

  let targets: VendorCodeEligibleLineTarget[];
  if (explicitTargets.length > 0) {
    targets = explicitTargets;
    console.log(`Using ${targets.length} explicitly-specified target(s) (ignoring any saved discovery file).`);
  } else {
    const file = await loadVendorCodeEligibleLines();
    if (!file) {
      console.error(
        'No explicit targets given and no data/vendor-code-eligible-lines.json found.\n' +
          `Run \`npm run vendor:batch-discovery -- --env ${env}\` first, or pass targets explicitly:\n` +
          `  npm run vendor:batch-execute -- <vendorCode>:<serialNumber> [more...] --env ${env}`,
      );
      process.exitCode = 1;
      return;
    }
    if (file.env !== env) {
      console.error(
        `Refusing to proceed: data/vendor-code-eligible-lines.json was generated for env "${file.env}" but this run ` +
          `targets "${env}". Re-run vendor:batch-discovery with --env ${env} first, or pass targets explicitly.`,
      );
      process.exitCode = 1;
      return;
    }
    targets = file.lines;
    const ageMinutes = Math.round((Date.now() - new Date(file.generatedAt).getTime()) / 60000);
    console.log(
      `Loaded ${targets.length} eligible line(s) from data/vendor-code-eligible-lines.json ` +
        `(generated ${ageMinutes} minute(s) ago, at ${file.generatedAt}).`,
    );
  }

  if (targets.length === 0) {
    console.log('0 target(s) to process. Nothing to do.');
    return;
  }

  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  console.log(`Processing ${targets.length} line(s): ${targets.map((t) => `[${t.vendorCode}] ${t.serialNumber}`).join(', ')}`);

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;
  let successCount = 0;
  let exceptionCount = 0;

  try {
    client = await createReadyMxiClient(env);

    for (const target of targets) {
      console.log(`\n--- [${target.vendorCode}] SN ${target.serialNumber} ---`);
      const config = getVendorConfig(target.vendorCode);
      const outcome = await runVendorCodeWriteUp(client, config, target.serialNumber);
      const { success } = logVendorCodeOutcome(db, config, env, outcome);
      if (success) successCount++;
      else exceptionCount++;
    }

    console.log(`\nFinished processing all ${targets.length} line(s): ${successCount} succeeded, ${exceptionCount} exception(s)/error(s) — see data/audit.db (write_up_actions, vendor != 'aeroRepair') for full detail on each.`);
  } catch (err) {
    console.error('Batch execute halted (likely session/login loss):', err instanceof Error ? err.message : String(err));
    console.log('Every line processed before the halt was already logged individually — nothing lost.');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
