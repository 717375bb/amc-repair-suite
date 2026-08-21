import 'dotenv/config';
import path from 'node:path';
import { getInvoicePriceRetryRows, insertInvoicePriceRun, insertInvoicePriceWrite, openDb } from '../../db/db.js';
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
 *
 * CLAUDE_CODE_PROMPT (retry failed lines) — two modes now, both ending up
 * at the exact same per-row loop below:
 *  - Fresh run: --file-path/--file-name, parses the uploaded sheet, opens
 *    a new invoice_price_runs row.
 *  - Retry: --retry-run-id/--order-numbers, reconstructs each row's
 *    (serialNumberSheet, newPrice) from this run's own append-only write
 *    history via getInvoicePriceRetryRows() (the uploaded sheet's staged
 *    copy is long gone by retry time — see invoicePriceJobManager.ts's
 *    cleanup()), appends to the SAME dbRunId rather than opening a new one.
 */

interface InvoicePriceEnvelope {
  type: 'summary' | 'order-result' | 'done' | 'fatal';
  dbRunId?: number;
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

interface FreshRunArgs {
  mode: 'fresh';
  env: MxiEnv;
  filePath: string;
  fileName: string;
}

interface RetryRunArgs {
  mode: 'retry';
  env: MxiEnv;
  retryRunId: number;
  orderNumbers: string[];
}

function parseArgs(): FreshRunArgs | RetryRunArgs {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const rawEnv = get('--env');
  if (rawEnv !== 'stage' && rawEnv !== 'production') {
    throw new Error(`--env must be exactly "stage" or "production", got: ${rawEnv}`);
  }

  const retryRunIdRaw = get('--retry-run-id');
  if (retryRunIdRaw !== undefined) {
    const retryRunId = Number(retryRunIdRaw);
    if (!Number.isFinite(retryRunId)) throw new Error(`--retry-run-id must be a number, got: ${retryRunIdRaw}`);
    const rawOrders = get('--order-numbers');
    if (!rawOrders) throw new Error('--order-numbers is required (JSON array of order number strings) for a retry.');
    const orderNumbers = JSON.parse(rawOrders) as string[];
    if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      throw new Error('--order-numbers must be a non-empty JSON array.');
    }
    return { mode: 'retry', env: rawEnv, retryRunId, orderNumbers };
  }

  const filePath = get('--file-path');
  const fileName = get('--file-name');
  if (!filePath) throw new Error('--file-path is required.');
  if (!fileName) throw new Error('--file-name is required.');
  return { mode: 'fresh', env: rawEnv, filePath, fileName };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const args = parseArgs();
  const { env } = args;

  const db = openDb(path.join('data', 'audit.db'));

  let runId: number;
  let rows: Array<{ orderNumber: string; serialNumber: string; newPrice: string }>;

  if (args.mode === 'fresh') {
    await validateHeaders(args.filePath, args.fileName);
    const parsedRows = await parseInvoicePriceRows(args.filePath);
    const duplicates = detectDuplicateOrderNumbers(parsedRows);
    runId = insertInvoicePriceRun(db, { startedAt, sourceFile: args.fileName, rowCount: parsedRows.length });
    rows = parsedRows.map((r) => ({ orderNumber: r.orderNumber, serialNumber: r.serialNumber, newPrice: r.newPrice }));
    emit({ type: 'summary', dbRunId: runId, rowCount: rows.length, duplicateCount: duplicates.length });
    if (duplicates.length > 0) {
      log.warn({ duplicates }, 'invoice price writer: duplicate PO Numbers found in sheet (processed anyway, not blocked)');
    }
  } else {
    runId = args.retryRunId;
    const retryRows = getInvoicePriceRetryRows(db, runId, args.orderNumbers);
    const alreadySucceededCount = args.orderNumbers.length - retryRows.length;
    rows = retryRows.map((r) => ({ orderNumber: r.orderNumber, serialNumber: r.serialNumberSheet, newPrice: r.newPrice }));
    emit({ type: 'summary', dbRunId: runId, rowCount: rows.length, duplicateCount: 0 });
    if (alreadySucceededCount > 0) {
      log.warn(
        { runId, requestedCount: args.orderNumbers.length, alreadySucceededCount },
        'invoice price writer retry: some requested order numbers already succeeded — not re-attempted',
      );
    }
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
      // Logged for every row, success included: which authorize/issue path an
      // order took (already authorized vs freshly authorized) is exactly the
      // detail that was previously invisible.
      if (result.issueDetail) log.info({ orderNumber: row.orderNumber, issueDetail: result.issueDetail }, 'authorize/issue outcome');

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
