import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../../db/db.js';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { processLine, logProcessLineResult } from '../../writeUps/aeroRepair/processLine.js';
import { discoverEligibleLines } from '../../writeUps/aeroRepair/batchDiscovery.js';
import { runVendorCodeWriteUp } from '../../writeUps/shared/vendorCodeWriteUp.js';
import { getVendorConfig } from '../../writeUps/shared/vendorRegistry.js';
import { logVendorCodeOutcome } from '../../writeUps/shared/vendorCodeOutcomeLogging.js';
import { AERO_REPAIR_VENDOR_ID, listVendors } from '../vendors.js';
import { aeroRepairResultToLogEvent, quarantinedLineToLogEvent, vendorCodeOutcomeToLogEvent, type RunLogEvent } from '../runLog.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('api');

/**
 * The one file in this feature with a real import path to write/submit
 * calls (processLine, runVendorCodeWriteUp) — deliberately isolated here,
 * never imported by discoveryRunner.ts, so the read/write boundary is a
 * structural fact about the module graph, not a convention someone has to
 * remember. Calls the exact same functions the existing CLIs call, in the
 * exact same way — every outcome reaches data/audit.db through the SAME
 * insertWriteUpAction/logVendorCodeOutcome calls the CLI path uses. This
 * file adds no new audit path; it's a new caller of the existing one.
 */

interface ExecuteTarget {
  vendorId: string;
  partNumber: string;
  serialNumber: string;
}

interface ExecuteEnvelope {
  type: 'line' | 'done' | 'fatal';
  event?: RunLogEvent;
  message?: string;
}

function emit(envelope: ExecuteEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

/**
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — a couple of minutes,
 * per explicit fix spec ("consider a short settle delay... so it isn't
 * fighting the same instantaneous spike"). Only applied once, before the
 * whole second pass, never per-line — the second pass itself is a single
 * attempt per quarantined line, not another inline-backoff loop.
 */
const SECOND_PASS_SETTLE_DELAY_MS = 120_000;

/** CLAUDE_CODE_PROMPT (cancel button) — resolves early if cancelled mid-wait, so a cancel during the settle delay doesn't force waiting out the full 2 minutes. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function parseArgs(): { env: MxiEnv; targets: ExecuteTarget[] } {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  const targetsIdx = args.indexOf('--targets');
  const rawEnv = envIdx >= 0 ? args[envIdx + 1] : undefined;
  const rawTargets = targetsIdx >= 0 ? args[targetsIdx + 1] : undefined;

  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be "stage" or "production", got: ${rawEnv}`);
  }
  if (!rawTargets) {
    throw new Error('--targets is required (JSON array of {vendorId, partNumber, serialNumber})');
  }
  const targets = JSON.parse(rawTargets) as ExecuteTarget[];
  return { env: rawEnv, targets };
}

async function main(): Promise<void> {
  const { env, targets } = parseArgs();
  const vendorList = listVendors();
  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;
  let seq = 0;
  // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — Aero Repair lines
  // that hit a retryable failure on their single main-pass attempt.
  // Vendor-code-family lines never enter this list — unchanged, single-
  // attempt, immediate-finalize behavior (no evidence tied that family to
  // this failure class, and this fix stays scoped to what was evidenced).
  const quarantined: ExecuteTarget[] = [];
  // CLAUDE_CODE_PROMPT (cancel button) — checked before each line (main
  // pass), before/during the settle delay, and before each quarantined
  // line (second pass) — never mid-Playwright-action. See
  // cancellationWatcher.ts's docstring for the full mechanism.
  const cancelSignal = watchStdinForCancellation();

  try {
    client = await createReadyMxiClient(env);

    // Main pass — one content-aware attempt per line. No inline backoff
    // burned here regardless of outcome; a retryable Aero Repair failure
    // is quarantined and moved past immediately.
    for (const target of targets) {
      if (cancelSignal.aborted) break;
      const vendorMeta = vendorList.find((v) => v.id === target.vendorId);
      const vendorDisplayName = vendorMeta?.displayName ?? target.vendorId;

      emit({
        type: 'line',
        event: {
          seq: seq++,
          timestamp: new Date().toISOString(),
          vendorId: target.vendorId,
          vendorDisplayName,
          partNumber: target.partNumber,
          serialNumber: target.serialNumber,
          description: target.partNumber,
          status: 'in_progress',
          summary: 'Processing...',
        },
      });

      if (target.vendorId === AERO_REPAIR_VENDOR_ID) {
        const result = await processLine(db, client, env, target.partNumber, target.serialNumber, 'main');
        if (result.status === 'quarantined') {
          quarantined.push(target);
          emit({ type: 'line', event: quarantinedLineToLogEvent(seq++, target.vendorId, vendorDisplayName, target) });
          continue;
        }
        await logProcessLineResult(target, result, env);
        emit({ type: 'line', event: aeroRepairResultToLogEvent(seq++, target.vendorId, vendorDisplayName, target, result) });
      } else {
        const config = getVendorConfig(target.vendorId);
        const outcome = await runVendorCodeWriteUp(client, config, target.serialNumber);
        logVendorCodeOutcome(db, config, env, outcome);
        emit({ type: 'line', event: vendorCodeOutcomeToLogEvent(seq++, target.vendorId, vendorDisplayName, target, outcome) });
      }
    }

    // Second pass — automatic, once, only over quarantined lines. Per
    // explicit fix spec: settle briefly (the latency this targets is
    // transient and time-of-day driven — confirmed real: the failing
    // 53-order run was 9:10-10:20 AM ET), then re-run discovery fresh
    // (proximity matters — a stale snapshot inflates false "no longer
    // eligible") before reprocessing. Deliberately no fresh in_progress
    // event per line here — each quarantined line already has one
    // outstanding in_progress count from the main pass (see
    // jobManager.ts's applyExecuteEnvelope) that only this pass's
    // terminal event resolves.
    if (quarantined.length > 0 && !cancelSignal.aborted) {
      log.error(
        { quarantinedCount: quarantined.length, settleDelayMs: SECOND_PASS_SETTLE_DELAY_MS },
        '[second-pass] line(s) quarantined — settling before automatic retry',
      );
      await sleep(SECOND_PASS_SETTLE_DELAY_MS, cancelSignal);

      if (!cancelSignal.aborted) {
        log.error('[second-pass] re-running discovery fresh before reprocessing quarantined line(s)...');
        try {
          const freshLines = await discoverEligibleLines(client);
          log.error({ freshLineCount: freshLines.length }, '[second-pass] fresh discovery found real line(s) across all Aero Repair part numbers');
        } catch (err) {
          log.error(
            { errorMessage: err instanceof Error ? err.message : String(err) },
            '[second-pass] fresh discovery failed — proceeding to reprocess quarantined line(s) anyway',
          );
        }

        for (const target of quarantined) {
          if (cancelSignal.aborted) break;
          const vendorMeta = vendorList.find((v) => v.id === target.vendorId);
          const vendorDisplayName = vendorMeta?.displayName ?? target.vendorId;
          const result = await processLine(db, client, env, target.partNumber, target.serialNumber, 'second');
          await logProcessLineResult(target, result, env);
          emit({ type: 'line', event: aeroRepairResultToLogEvent(seq++, target.vendorId, vendorDisplayName, target, result) });
        }
      }
    }

    emit({ type: 'done' });
  } catch (err) {
    // Session/login loss (or any other unexpected halt) — per carry-forward
    // rule 5, this must surface as a run-level halt, never disguised as a
    // per-line exception. The job manager maps a 'fatal' envelope to job
    // status 'failed', distinct from 'partial' (which means some lines
    // exceptioned but the run itself completed).
    emit({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
