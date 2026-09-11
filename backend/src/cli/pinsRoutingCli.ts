import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { PIN_PART_NUMBER, runPinsRoutingForBn } from '../backShop/pinRouting.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Standalone tool for routing a pin (PN 4114T06P03) to back-shop repair,
 * per explicit user direction (2026-09-10) that this runs independently
 * of the vendor-code write-up pipeline rather than as a step inside it.
 *
 * `npm run pins:route -- <BN> [--env production]`
 *
 * Thin wrapper — the actual routing/write logic lives in
 * backShop/pinRouting.ts's runPinsRoutingForBn, shared with the Back Shop
 * tab's own "Run" button (api/jobRunners/pinsRoutingRunner.ts, which loops
 * this same function over every pin found in one discovery pass as a
 * single batched job — see that file's own docblock) so there is exactly
 * one implementation, not two that could silently drift.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const bn = rest[0];

  if (!bn) {
    log.error('Usage: npm run pins:route -- <BN> [--env production]');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase(), bn, partNumber: PIN_PART_NUMBER }, 'Starting pin routing');

  const db = openDb(path.join('data', 'audit.db'));
  const client = await createReadyMxiClient(env);

  try {
    const result = await runPinsRoutingForBn(client, db, env, bn);
    if (result.status === 'success') {
      log.info(result, 'Pin routing complete');
    } else {
      log.error(result, 'Pin routing did not complete successfully');
      process.exitCode = 1;
    }
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
