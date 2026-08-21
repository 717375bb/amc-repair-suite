import 'dotenv/config';
import path from 'node:path';
import {
  getEffectiveQuoteDispositions,
  insertQuoteWrite,
  openDb,
  quoteExtractionAlreadyWritten,
} from '../../db/db.js';
import { createReadyMxiClient } from '../../mxiWriter/cliMxiClient.js';
import { toMxiDateFormat } from '../../mxiWriter/esdFormatting.js';
import { writePriceLineUpdate } from '../../mxiWriter/writePriceLineUpdate.js';
import { markOutlookMailRead } from '../../quoteWriter/outlookMarkRead.js';
import { isWritable, type QuoteDisposition } from '../../quoteWriter/quoteDisposition.js';
import type { MxiEnv } from '../../mxiWriter/config.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('quote');

/**
 * Vendor Quote Writer — MXI write runner (Stage 5).
 *
 * For each approved quote: write Unit Price + Price Type=QUOTE + Promise By
 * (the ESD derived from the vendor's own quote, NOT the Invoice Price
 * Writer's "tomorrow" placeholder), reauthorize if the real page state says
 * it's needed, reissue, independently re-verify — then, and only then, mark
 * the source email read.
 *
 * Reuses writePriceLineUpdate() rather than reimplementing the write: it is
 * already live-proven, and carries the serial-number cross-check, the
 * integer-cents price comparison, and the always-re-verify discipline.
 *
 * FOUR structural guards, none of which depend on the caller behaving:
 *   1. Disposition is re-read from the DB, never trusted from the request.
 *      A row marked NREP/BER/excluded cannot be written even if its id is
 *      passed in explicitly.
 *   2. quoteExtractionAlreadyWritten() blocks a second successful write —
 *      re-writing reissues the order again for nothing.
 *   3. Rows missing an order number, price, serial, or ESD are skipped;
 *      there is no partial write.
 *   4. Mail is marked read ONLY after a verified-successful write, so a
 *      failure leaves the item in the unread queue.
 */

interface Envelope {
  type: 'phase' | 'summary' | 'order-result' | 'fatal' | 'done';
  [key: string]: unknown;
}

function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { env: MxiEnv; dbRunId: number; extractionIds: number[] } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = get('--env');
  if (env !== 'stage' && env !== 'production') {
    throw new Error('--env must be exactly "stage" or "production".');
  }
  const dbRunId = Number(get('--db-run-id'));
  if (!Number.isInteger(dbRunId) || dbRunId <= 0) throw new Error('--db-run-id must be a positive integer.');
  const raw = get('--extraction-ids');
  if (!raw) throw new Error('--extraction-ids is required (JSON array).');
  const extractionIds = JSON.parse(raw) as number[];
  if (!Array.isArray(extractionIds) || extractionIds.length === 0) {
    throw new Error('--extraction-ids must be a non-empty JSON array.');
  }
  return { env, dbRunId, extractionIds };
}

interface WritableRow {
  id: number;
  order_number: string | null;
  serial_number: string | null;
  unit_price: number | null;
  resolved_esd: string | null;
  source_entry_id: string;
  document_kind: string;
}

async function main(): Promise<void> {
  const { env, dbRunId, extractionIds } = parseArgs();
  const db = openDb(path.join('data', 'audit.db'));

  const placeholders = extractionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, order_number, serial_number, unit_price, resolved_esd, source_entry_id, document_kind
       FROM quote_extractions
       WHERE run_id = ? AND id IN (${placeholders})`,
    )
    .all(dbRunId, ...extractionIds) as WritableRow[];

  // Guard 1: effective disposition comes from the DB, never the request.
  const dispositions = getEffectiveQuoteDispositions(db, dbRunId);

  emit({ type: 'summary', dbRunId, env, requested: extractionIds.length, found: rows.length });
  emit({ type: 'phase', phase: 'writing' });

  const cancelSignal = watchStdinForCancellation();

  const client = await createReadyMxiClient(env);
  const password = env === 'production' ? process.env.MXI_PROD_PASSWORD : process.env.MXI_STAGE_PASSWORD;

  let written = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const row of rows) {
      if (cancelSignal.aborted) break;

      const orderNumber = row.order_number ?? `(extraction ${row.id})`;

      const skip = (reason: string) => {
        skipped++;
        emit({ type: 'order-result', extractionId: row.id, orderNumber, status: 'skipped', errorMessage: reason });
      };

      const disposition = (dispositions.get(row.id)?.disposition ?? 'pending') as QuoteDisposition;
      if (!isWritable(disposition)) {
        skip(`Not writable — disposition is "${disposition}".`);
        continue;
      }
      if (row.document_kind !== 'quote') {
        skip(`Not a quote (${row.document_kind}).`);
        continue;
      }
      // Guard 2: never re-write something already successfully written.
      if (quoteExtractionAlreadyWritten(db, row.id)) {
        skip('Already written successfully — not re-attempted.');
        continue;
      }
      // Guard 3: no partial writes.
      const missing: string[] = [];
      if (!row.order_number) missing.push('order number');
      if (row.unit_price === null) missing.push('price');
      if (!row.serial_number) missing.push('serial number');
      if (!row.resolved_esd) missing.push('ESD');
      if (missing.length > 0) {
        skip(`Missing ${missing.join(', ')} — refusing to write a partial update.`);
        continue;
      }

      const priceString = row.unit_price!.toFixed(2);
      const esdMxi = toMxiDateFormat(row.resolved_esd!);

      log.info({ orderNumber, env, price: priceString, esd: esdMxi }, 'attempting quote write');

      const result = await writePriceLineUpdate(
        client,
        row.order_number!,
        row.serial_number!,
        priceString,
        password ?? '',
        esdMxi,
      );

      // Guard 4: mail is only ever marked read after a verified success.
      let markedRead = false;
      let markReadError: string | null = null;
      if (result.status === 'success') {
        const mark = await markOutlookMailRead(row.source_entry_id);
        markedRead = mark.ok;
        markReadError = mark.error;
      }

      insertQuoteWrite(db, {
        quoteExtractionId: row.id,
        orderNumber: row.order_number!,
        targetEnv: env,
        writtenPrice: priceString,
        writtenEsd: row.resolved_esd,
        writeStatus: result.status,
        errorMessage: result.errorMessage,
        markedRead,
        approvedBy: 'quote-writer-ui',
      });

      if (result.status === 'success') written++;
      else if (result.status === 'skipped') skipped++;
      else failed++;

      emit({
        type: 'order-result',
        extractionId: row.id,
        orderNumber,
        status: result.status,
        outcome: result.outcome,
        originalPrice: result.originalPrice,
        writtenPrice: priceString,
        writtenEsd: row.resolved_esd,
        markedRead,
        // Deliberately distinct from errorMessage: a mailbox bookkeeping
        // miss is NOT a failed MXI write, and must not read like one.
        markReadError,
        errorMessage: result.errorMessage,
      });
    }
  } finally {
    await client.shutdown();
    db.close();
  }

  log.info({ written, skipped, failed, env }, 'quote write run complete');
  emit({ type: 'done', written, skipped, failed });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ error: message }, 'quote write runner failed');
  emit({ type: 'fatal', message });
  process.exitCode = 1;
});
