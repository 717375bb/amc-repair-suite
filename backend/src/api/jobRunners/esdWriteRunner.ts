import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { insertMxiWrite } from '../../db/db.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { assembleNoteText, toMxiDateFormat } from '../../mxiWriter/esdFormatting.js';
import { writeEsdAndNotes } from '../../mxiWriter/writeEsdAndNotes.js';

/**
 * Open Order ESD Finder — write job runner. Spawned by
 * esdFinderJobManager.ts (same spawnRunner discipline as every other
 * runner in this project).
 *
 * CRITICAL DESIGN POINT: this creates its OWN MxiClient via
 * createReadyMxiClient(env) using the `env` this specific job was started
 * with — it never touches server.ts's single, server-lifetime `mxiClient`
 * (which is fixed to whatever MXI_ENV the server happened to boot with,
 * currently 'production'). That shared client is exactly what NOT to reuse
 * here: the whole point of this file existing separately is that the
 * environment selector must genuinely control where the write lands, not
 * be cosmetic. `target_env` on every mxi_writes row below is this same
 * explicit `env` value, not read back from any client's own config.
 *
 * Calls writeEsdAndNotes() unchanged — the exact same function
 * server.ts's /esd-updates/:orderNumber/approve and mxiWriteEsd.ts already
 * use. No reimplementation of the write/verify logic itself.
 */

interface EsdWriteEnvelope {
  type: 'order-result' | 'done' | 'fatal';
  orderNumber?: string;
  status?: 'success' | 'failed' | 'skipped';
  errorMessage?: string | null;
  message?: string;
}

function emit(envelope: EsdWriteEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

interface EsdInferenceRowForWrite {
  id: number;
  order_number: string;
  inferred_esd: string;
  vendor_notes: string | null;
}

function parseArgs(): { env: MxiEnv; dbRunId: number; orderNumbers: string[] } {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  const runIdIdx = args.indexOf('--esd-run-id');
  const ordersIdx = args.indexOf('--order-numbers');
  const rawEnv = envIdx >= 0 ? args[envIdx + 1] : undefined;
  const rawRunId = runIdIdx >= 0 ? args[runIdIdx + 1] : undefined;
  const rawOrders = ordersIdx >= 0 ? args[ordersIdx + 1] : undefined;

  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be exactly "stage" or "production", got: ${rawEnv}`);
  }
  if (!rawRunId) throw new Error('--esd-run-id is required.');
  if (!rawOrders) throw new Error('--order-numbers is required (JSON array of order number strings).');

  const dbRunId = Number(rawRunId);
  const orderNumbers = JSON.parse(rawOrders) as string[];
  if (!Number.isFinite(dbRunId)) throw new Error(`--esd-run-id must be a number, got: ${rawRunId}`);
  if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
    throw new Error('--order-numbers must be a non-empty JSON array.');
  }
  return { env: rawEnv, dbRunId, orderNumbers };
}

async function main(): Promise<void> {
  const { env, dbRunId, orderNumbers } = parseArgs();
  const db = new Database(path.join('data', 'audit.db'));

  // Same run-scoped, flag='ok'-gated query approveAndWrite.ts uses —
  // scoped to the SPECIFIC compare run, never "whatever the latest run
  // happens to be" (getActionableEsdInference's own hardcoded MAX(id)
  // semantics would be wrong here: a later, unrelated run could exist by
  // the time a write actually happens).
  const placeholders = orderNumbers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, order_number, inferred_esd, vendor_notes FROM esd_inferences
       WHERE run_id = ? AND flag = 'ok' AND order_number IN (${placeholders})`,
    )
    .all(dbRunId, ...orderNumbers) as EsdInferenceRowForWrite[];

  const foundOrderNumbers = new Set(rows.map((r) => r.order_number));
  for (const orderNumber of orderNumbers) {
    if (!foundOrderNumbers.has(orderNumber)) {
      emit({
        type: 'order-result',
        orderNumber,
        status: 'skipped',
        errorMessage: `Not found as an actionable (flag='ok') row under run ${dbRunId} — refusing to write it.`,
      });
    }
  }

  if (rows.length === 0) {
    db.close();
    emit({ type: 'done' });
    return;
  }

  const client = await createReadyMxiClient(env);
  try {
    for (const row of rows) {
      // Defense-in-depth for the retry-only-failed-orders requirement:
      // never re-attempt an order this esd_inference_id already has a real
      // successful mxi_writes row for, regardless of what the caller
      // requested. Notes to Receiver is an accumulating log — a second
      // real submit would duplicate the entry and reissue the order again
      // for no reason, the same risk already documented for aeroRepair's
      // writeEsdAndNotes-equivalent. This makes "only retry what actually
      // failed" a structural guarantee, not just a UI convention the
      // frontend has to get right every time.
      const alreadySucceeded = db
        .prepare(`SELECT 1 FROM mxi_writes WHERE esd_inference_id = ? AND write_status = 'success' LIMIT 1`)
        .get(row.id);
      if (alreadySucceeded) {
        emit({
          type: 'order-result',
          orderNumber: row.order_number,
          status: 'skipped',
          errorMessage: 'Already successfully written previously under this run — not re-attempted.',
        });
        continue;
      }

      const result = await writeEsdAndNotes(client, row.order_number, {
        esd: toMxiDateFormat(row.inferred_esd),
        noteText: assembleNoteText(row.vendor_notes) ?? undefined,
      });

      insertMxiWrite(db, {
        esdInferenceId: row.id,
        orderNumber: row.order_number,
        targetEnv: env,
        action: 'approved_write',
        inferredEsd: row.inferred_esd,
        writeStatus: result.status,
        errorMessage: result.errorMessage,
        approvedBy: 'esd-finder-ui',
      });

      emit({
        type: 'order-result',
        orderNumber: row.order_number,
        status: result.status,
        errorMessage: result.errorMessage,
      });
    }
  } finally {
    await client.shutdown();
    db.close();
  }

  emit({ type: 'done' });
}

main().catch((err) => {
  emit({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
