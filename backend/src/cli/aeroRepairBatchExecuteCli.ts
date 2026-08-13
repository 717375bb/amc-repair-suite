import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { loadEligibleLines } from '../writeUps/aeroRepair/eligibleLinesFile.js';
import { LOG_FILE_PATH, logProcessLineResult, processLine } from '../writeUps/aeroRepair/processLine.js';

/**
 * The full automatic per-line flow, no pause, no human review step — per
 * the relaxed-gate decision: write-up form fill through Auth Flow
 * confirmation, then Issue Order, then Move to Dock, all in one pass.
 * (One narrow exception: a genuine single-candidate no-task line still
 * pauses once, per the one-time Ad-Hoc-continuation proof gate — see
 * writeUp.ts/adHocContinuationProof.ts — until that specific path has
 * been proven end-to-end for real.)
 *
 * Immediately before each line's write-up begins, re-verifies FRESH
 * (read-only) that it's still genuinely eligible — never trusts an
 * earlier discovery scan's snapshot. Real, confirmed reason this matters:
 * this is a shared production system (`P000BAL4`'s outbound shipment was
 * moved to dock by another human entirely, between sessions, with zero
 * involvement from this automation).
 *
 * On any unexpected failure partway through a line, logs it and moves on
 * to the next line — never halts the batch over one line's failure.
 * Session/login loss is the one exception that halts entirely (thrown
 * back out of processLine uncaught, same standing rule as the ESD
 * writer's mxiClient halt-on-session-loss behavior).
 *
 * processLine/logProcessLineResult live in writeUps/aeroRepair/processLine.ts
 * — shared with aeroRepairContinueAdHocCli.ts, so the one-time manual
 * continuation proof drives the exact same real flow, not a duplicate.
 *
 * Usage:
 *   npm run aero-repair:batch-execute -- --env production
 *     No targets given -> reads data/aero-repair-eligible-lines.json (written
 *     by the last aero-repair:batch-discovery run for this same env) and
 *     processes every line in it. This is the normal daily path: scan, then
 *     run, no manual partNumber:serialNumber list needed.
 *   npm run aero-repair:batch-execute -- <partNumber>:<serialNumber> [more...] [--env production]
 *     Explicit targets override the file entirely — for testing/re-running
 *     one specific line without touching the saved discovery snapshot.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const explicitTargets = rest
    .filter((arg) => arg.includes(':'))
    .map((arg) => {
      const idx = arg.indexOf(':');
      return { partNumber: arg.slice(0, idx), serialNumber: arg.slice(idx + 1) };
    });

  let targets: { partNumber: string; serialNumber: string }[];
  if (explicitTargets.length > 0) {
    targets = explicitTargets;
    console.log(`Using ${targets.length} explicitly-specified target(s) (ignoring any saved discovery file).`);
  } else {
    const file = await loadEligibleLines();
    if (!file) {
      console.error(
        'No explicit targets given and no data/aero-repair-eligible-lines.json found.\n' +
          'Run `npm run aero-repair:batch-discovery -- --env ' +
          env +
          '` first, or pass targets explicitly:\n' +
          '  npm run aero-repair:batch-execute -- <partNumber>:<serialNumber> [more...] --env ' +
          env,
      );
      process.exitCode = 1;
      return;
    }
    if (file.env !== env) {
      console.error(
        `Refusing to proceed: data/aero-repair-eligible-lines.json was generated for env "${file.env}" but this run ` +
          `targets "${env}". Re-run batch-discovery with --env ${env} first, or pass targets explicitly.`,
      );
      process.exitCode = 1;
      return;
    }
    targets = file.lines;
    const ageMinutes = Math.round((Date.now() - new Date(file.generatedAt).getTime()) / 60000);
    console.log(
      `Loaded ${targets.length} eligible line(s) from data/aero-repair-eligible-lines.json ` +
        `(generated ${ageMinutes} minute(s) ago, at ${file.generatedAt}).`,
    );
    if (ageMinutes > 24 * 60) {
      console.log(
        'WARNING: this discovery snapshot is over 24 hours old. Each line below is still independently ' +
          're-verified live immediately before processing, so a stale entry will just be safely skipped as ' +
          '"no longer eligible" rather than acted on incorrectly — but a fresh scan will also pick up any new ' +
          'lines that have shown up since. Consider re-running batch-discovery first.',
      );
    }
  }

  if (targets.length === 0) {
    console.log('0 target(s) to process. Nothing to do.');
    return;
  }

  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  console.log(`Processing ${targets.length} line(s): ${targets.map((t) => `${t.partNumber}:${t.serialNumber}`).join(', ')}`);

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);

    for (const target of targets) {
      console.log(`\n--- ${target.partNumber} / SN ${target.serialNumber} ---`);
      const result = await processLine(db, client, env, target.partNumber, target.serialNumber, 'second');
      // Logged to the xlsx immediately after EACH line, not accumulated
      // and written once at the very end — a long run across many lines
      // should never risk losing every completed line's record just
      // because a later line hangs or the process gets interrupted.
      await logProcessLineResult(target, result, env);
    }

    console.log(`\nFinished processing all ${targets.length} line(s) — each logged to ${LOG_FILE_PATH} as it completed.`);
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
