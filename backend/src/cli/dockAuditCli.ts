import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { readOutboundShipmentDockState } from '../writeUps/shared/issueAndDock.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Dock-move audit — READ ONLY. Clicks nothing, changes nothing.
 *
 * Exists because moveOutboundShipmentToDock() used to return
 * status:'success' purely on "no exception thrown", never re-reading the
 * real dock state (fixed 2026-08-23). Every historical 'success' row was
 * recorded under that weaker rule, so an unknown subset of them may name
 * orders whose part never actually moved — exactly the user-reported
 * symptom ("written up and issued, but the move to dock is not actually
 * occurring, even though the UI says it is").
 *
 * This re-checks those rows against real MXI and prints the ones that are
 * genuinely still sitting at USSTG, so the backlog becomes a concrete list
 * instead of a suspicion.
 *
 * Usage:
 *   npm run dock:audit -- [--limit 25] [--env production]
 *
 * Deliberately bounded by --limit (default 25): each order costs several
 * real page navigations, so auditing all of them at once would take hours.
 * Run it in batches. Results are printed, never written back — deciding
 * what to do about a stuck order is a human call.
 */

interface Row {
  id: number;
  order_number: string;
  shipment_id: string | null;
  created_at: string;
}

async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const limitIdx = rest.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : 25;
  if (!Number.isInteger(limit) || limit <= 0) {
    log.error('--limit must be a positive integer.');
    process.exitCode = 1;
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  const rows = db
    .prepare(
      `SELECT id, order_number, shipment_id, created_at
       FROM write_up_dock_moves
       WHERE move_status = 'success' AND target_env = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(env, limit) as Row[];
  db.close();

  if (rows.length === 0) {
    console.log(`\nNo 'success' dock-move rows found for ${env}.\n`);
    return;
  }

  console.log(`\nRe-checking ${rows.length} order(s) recorded as docked in ${env.toUpperCase()}.`);
  console.log('READ ONLY — nothing will be clicked or changed.\n');

  const client = await createReadyMxiClient(env);
  const stuck: Array<{ orderNumber: string; state: string; recordedAt: string }> = [];
  let confirmed = 0;
  let unknown = 0;

  try {
    const page = await client.getAuthenticatedPage();
    for (const row of rows) {
      let state: string;
      try {
        const real = await readOutboundShipmentDockState(page, client.todoListUrl, row.order_number);
        state = real.status;
      } catch (err) {
        state = `read_error: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`;
      }

      if (state === 'already_docked_or_further') {
        confirmed++;
        console.log(`  OK       ${row.order_number}  genuinely docked`);
      } else if (state === 'not_yet_docked') {
        stuck.push({ orderNumber: row.order_number, state, recordedAt: row.created_at });
        console.log(`  ** STUCK ${row.order_number}  recorded docked ${row.created_at.slice(0, 10)}, still at USSTG`);
      } else {
        unknown++;
        console.log(`  ?        ${row.order_number}  ${state}`);
      }
    }
  } finally {
    await client.shutdown();
  }

  console.log(`\n${confirmed} genuinely docked, ${stuck.length} STUCK, ${unknown} inconclusive.`);
  if (stuck.length > 0) {
    console.log(`\nOrders whose part never actually moved:`);
    for (const s of stuck) console.log(`   ${s.orderNumber}   (recorded as docked ${s.recordedAt.slice(0, 10)})`);
    console.log(`\nThese need a real Move to Dock. Nothing was changed by this audit.\n`);
  } else {
    console.log('');
  }
}

main().catch((err) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'dock audit failed');
  process.exitCode = 1;
});
