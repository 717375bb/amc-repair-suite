import 'dotenv/config';
import path from 'node:path';
import { insertInvoicePriceRun, insertInvoicePriceWrite, openDb } from '../../db/db.js';
import { detectDuplicateOrderNumbers, parseInvoicePriceRows, validateHeaders } from '../invoicePriceWriter/ingestion.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { writePriceLineUpdate } from '../../mxiWriter/writePriceLineUpdate.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('esd');

/**
 * Invoice Price Writer — single-phase job runner (no separate
 * compare/approve gate like the ESD Finder: the uploaded sheet already
 * fully specifies what to do per row, there's nothing to infer). Spawned
 * by invoicePriceJobManager.ts via the same spawnRunner/
 * mxiCredentialEnvOverrides discipline as every other MXI-touching runner
 * in this project — creates its OWN MxiClient via createReadyMxiClient(env)
 * (never server.ts's shared, server-lifetime client), same reasoning as
 * esdWriteRunner.ts: the environment selector must genuinely control where
 * the write lands, not be cosmetic.
 */

interface InvoicePriceEnvelope {
  type: 'summary' | 'order-result' | 'done' | 'fatal';
  rowCount?: number;
  duplicateCount?: number;
  orderNumber?: string;
  serialNumberSheet?: string;
  serialNumberMxi?: string | null;
  originalPrice?: string | null;
  newPrice?: string;
  status?: 'success' | 'failed' | 'skipped';
  outcome?: string;
  errorMessage?: string | null;
  message?: string;
}

function emit(envelope: InvoicePriceEnvelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { env: MxiEnv; filePath: string; fileName: string } {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  const filePathIdx = args.indexOf('--file-path');
  const fileNameIdx = args.indexOf('--file-name');
  const rawEnv = envIdx >= 0 ? args[envIdx + 1] : undefined;
  const filePath = filePathIdx >= 0 ? args[filePathIdx + 1] : undefined;
  const fileName = fileNameIdx >= 0 ? args[fileNameIdx + 1] : undefined;

  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be exactly "stage" or "production", got: ${rawEnv}`);
  }
  if (!filePath) throw new Error('--file-path is required.');
  if (!fileName) throw new Error('--file-name is required.');
  return { env: rawEnv, filePath, fileName };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const { env, filePath, fileName } = parseArgs();

  await validateHeaders(filePath, fileName);
  const rows = await parseInvoicePriceRows(filePath);
  const duplicates = detectDuplicateOrderNumbers(rows);

  const db = openDb(path.join('data', 'audit.db'));
  const runId = insertInvoicePriceRun(db, { startedAt, sourceFile: fileName, rowCount: rows.length });

  emit({ type: 'summary', rowCount: rows.length, duplicateCount: duplicates.length });
  if (duplicates.length > 0) {
    log.warn({ duplicates }, 'invoice price writer: duplicate PO Numbers found in sheet (processed anyway, not blocked)');
  }

  const cancelSignal = watchStdinForCancellation();

  // Same per-user MXI credential already threaded into this process's env
  // by mxiCredentialEnvOverrides() — also reused directly for the mid-flow
  // re-authorization dialog, never a new credential-entry UI.
  const password = env === 'production' ? process.env.MXI_PROD_PASSWORD : process.env.MXI_STAGE_PASSWORD;
  if (!password) {
    db.close();
    emit({ type: 'fatal', message: `No MXI password available in the environment for env="${env}".` });
    process.exitCode = 1;
    return;
  }

  const client = await createReadyMxiClient(env);
  try {
    for (const row of rows) {
      if (cancelSignal.aborted) break;

      log.info({ orderNumber: row.orderNumber }, 'invoice price writer: processing row');
      const result = await writePriceLineUpdate(client, row.orderNumber, row.serialNumber, row.newPrice, password);

      insertInvoicePriceWrite(db, {
        runId,
        orderNumber: row.orderNumber,
        serialNumberSheet: row.serialNumber,
        serialNumberMxi: result.serialNumberMxi,
        originalPrice: result.originalPrice,
        newPrice: row.newPrice,
        targetEnv: env,
        outcome: result.outcome,
        writeStatus: result.status,
        errorMessage: result.errorMessage,
      });

      emit({
        type: 'order-result',
        orderNumber: row.orderNumber,
        serialNumberSheet: row.serialNumber,
        serialNumberMxi: result.serialNumberMxi,
        originalPrice: result.originalPrice,
        newPrice: row.newPrice,
        status: result.status,
        outcome: result.outcome,
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
