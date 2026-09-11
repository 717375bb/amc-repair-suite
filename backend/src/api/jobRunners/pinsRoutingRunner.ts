import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../../db/db.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { runPinsRoutingForBn, type PinsRoutingRunResult } from '../../backShop/pinRouting.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('backshop');

/**
 * Back Shop tab's "Run" button — per explicit user correction (2026-09-11):
 * "I want them looped in with the scrap process... when I push the 'run'
 * button after the read, it simply runs the process setup for pins when
 * it hits one of them. But I want all pins found to run in a single
 * process." Every pin discovered in one discovery pass is submitted here
 * TOGETHER, in one job/one browser session — one `--bns` JSON array, not
 * one job per pin — the same "many targets, one job" shape
 * scrapJobManager.ts's own in-house batch already uses.
 *
 * Runs runPinsRoutingForBn() per BN, unchanged — the exact same function
 * cli/pinsRoutingCli.ts uses. No reimplementation of the routing/write
 * logic itself; see that function's own docblock and pinRouting.ts's
 * runPinCorrectBaseFlow/runPinWrongBaseShipmentFlow for what parts of this
 * are still unverified against real MXI.
 *
 * One BN failing does NOT stop the rest — same "each reports its own
 * result, the batch keeps going" reasoning as the in-house scrap job.
 */

interface Envelope {
  type: 'phase' | 'result' | 'fatal' | 'done';
  phase?: string;
  result?: PinsRoutingRunResult;
  message?: string;
}

function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { env: MxiEnv; bns: string[] } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = get('--env');
  if (env !== 'stage' && env !== 'production') throw new Error('--env must be exactly "stage" or "production".');
  const rawBns = get('--bns');
  if (!rawBns) throw new Error('--bns (JSON array of BN strings) is required.');
  const bns = JSON.parse(rawBns) as string[];
  if (!Array.isArray(bns) || bns.length === 0) throw new Error('--bns must be a non-empty JSON array.');
  return { env, bns };
}

async function main(): Promise<void> {
  const { env, bns } = parseArgs();
  const db = openDb(path.join('data', 'audit.db'));
  const client = await createReadyMxiClient(env);

  try {
    for (const [index, bn] of bns.entries()) {
      emit({ type: 'phase', phase: `routing ${index + 1} of ${bns.length} pins` });
      try {
        const result = await runPinsRoutingForBn(client, db, env, bn);
        emit({ type: 'result', result });
      } catch (err) {
        // One pin's own failure (a page that never resolved, an
        // unexpected MXI state) must not take the rest of the batch down
        // with it — same discipline as every other multi-target job here.
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error({ bn, errorMessage }, '[pins-routing] one BN in the batch failed — continuing with the rest');
        emit({
          type: 'result',
          result: {
            bn,
            currentLocation: '',
            base: null,
            path: 'unknown',
            status: 'failed',
            locationUsed: null,
            destination: null,
            totals: null,
            errorMessage,
          },
        });
      }
    }
  } finally {
    await client.shutdown();
    db.close();
  }

  emit({ type: 'done' });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err }, 'pins routing runner failed');
  emit({ type: 'fatal', message });
  process.exit(1);
});
