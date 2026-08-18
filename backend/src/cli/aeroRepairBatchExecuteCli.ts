import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { loadEligibleLines } from '../writeUps/aeroRepair/eligibleLinesFile.js';
import { LOG_FILE_PATH, logProcessLineResult, processLine } from '../writeUps/aeroRepair/processLine.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

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
    log.info({ targetCount: targets.length }, 'Using explicitly-specified target(s) (ignoring any saved discovery file).');
  } else {
    const file = await loadEligibleLines();
    if (!file) {
      log.error(
        { env },
        'No explicit targets given and no data/aero-repair-eligible-lines.json found. Run `npm run aero-repair:batch-discovery -- --env <env>` first, or pass targets explicitly: `npm run aero-repair:batch-execute -- <partNumber>:<serialNumber> [more...] --env <env>`.',
      );
      process.exitCode = 1;
      return;
    }
    if (file.env !== env) {
      log.error(
        { fileEnv: file.env, requestedEnv: env },
        'Refusing to proceed: data/aero-repair-eligible-lines.json was generated for a different env than this run targets. Re-run batch-discovery with the requested --env first, or pass targets explicitly.',
      );
      process.exitCode = 1;
      return;
    }
    targets = file.lines;
    const ageMinutes = Math.round((Date.now() - new Date(file.generatedAt).getTime()) / 60000);
    log.info(
      { targetCount: targets.length, ageMinutes, generatedAt: file.generatedAt },
      'Loaded eligible line(s) from data/aero-repair-eligible-lines.json',
    );
    if (ageMinutes > 24 * 60) {
      log.info(
        'WARNING: this discovery snapshot is over 24 hours old. Each line below is still independently re-verified live immediately before processing, so a stale entry will just be safely skipped as "no longer eligible" rather than acted on incorrectly — but a fresh scan will also pick up any new lines that have shown up since. Consider re-running batch-discovery first.',
      );
    }
  }

  if (targets.length === 0) {
    log.info('0 target(s) to process. Nothing to do.');
    return;
  }

  log.info(
    { env: env.toUpperCase(), targetCount: targets.length, targets: targets.map((t) => `${t.partNumber}:${t.serialNumber}`) },
    'Target MXI environment — processing line(s).',
  );

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);

    for (const target of targets) {
      log.info({ partNumber: target.partNumber, serialNumber: target.serialNumber }, 'Processing line');
      const result = await processLine(db, client, env, target.partNumber, target.serialNumber, 'second');
      // Logged to the xlsx immediately after EACH line, not accumulated
      // and written once at the very end — a long run across many lines
      // should never risk losing every completed line's record just
      // because a later line hangs or the process gets interrupted.
      await logProcessLineResult(target, result, env);
    }

    log.info({ targetCount: targets.length, logFilePath: LOG_FILE_PATH }, 'Finished processing all line(s) — each logged as it completed.');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ errorMessage }, 'Batch execute halted (likely session/login loss)');
    log.info('Every line processed before the halt was already logged individually — nothing lost.');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
