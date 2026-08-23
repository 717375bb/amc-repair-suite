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
import { writePriceLineUpdate, type PriceLineUpdateResult } from '../../mxiWriter/writePriceLineUpdate.js';
import { convertRepairToExchange } from '../../mxiWriter/convertToExchange.js';
import { writeScrapPriceLines, BER_DEFAULT_SCRAP_FEE } from '../../mxiWriter/writeScrapPriceLines.js';
import { markOutlookMailRead } from '../../quoteWriter/outlookMarkRead.js';
import { createOutlookReply, resolveReplyMode } from '../../quoteWriter/outlookReply.js';
import {
  firstNameFromDisplayName,
  formatPriceForEmail,
  loadApprovalTemplate,
  renderApprovalReply,
} from '../../quoteWriter/quoteReplyTemplate.js';
import { resolveWriteAction, type QuoteDisposition } from '../../quoteWriter/quoteDisposition.js';
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
 * THREE mutually exclusive write actions, resolved by resolveWriteAction()
 * from the row's disposition and exchange flag — never more than one runs:
 *   price_line   ordinary repair quote -> writePriceLineUpdate()
 *   exchange     vendor offered a replacement -> convertRepairToExchange()
 *   scrap_price  NREP or BER -> writeScrapPriceLines()
 * Each carries its own price through a different MXI mechanism, so running
 * two would push the same money twice.
 *
 * FOUR structural guards, none of which depend on the caller behaving:
 *   1. Disposition is re-read from the DB, never trusted from the request,
 *      and it decides WHICH action runs. A row the analyst excluded cannot
 *      be written even if its id is passed in explicitly.
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
  quote_number: string | null;
  vendor_name: string | null;
  currency: string | null;
  part_number: string | null;
  sender_name: string | null;
  sender_first_name: string | null;
  suggests_exchange: number;
}

async function main(): Promise<void> {
  const { env, dbRunId, extractionIds } = parseArgs();
  const db = openDb(path.join('data', 'audit.db'));

  const placeholders = extractionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, order_number, serial_number, unit_price, resolved_esd, source_entry_id, document_kind,
              quote_number, vendor_name, currency, part_number, sender_name, sender_first_name,
              suggests_exchange
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

  // Load the approval template ONCE, before any write. If it hasn't been
  // given real wording yet, every row records reply_status='skipped' with
  // the reason — the MXI writes still happen (they're the point), but no
  // placeholder text can ever reach a vendor. Deliberately not a fatal
  // error: refusing to write real prices because an email template isn't
  // filled in would be the wrong tradeoff.
  const replyMode = resolveReplyMode();
  let approvalTemplate: string | null = null;
  let templateError: string | null = null;
  try {
    approvalTemplate = loadApprovalTemplate();
    log.info({ replyMode }, 'approval reply template loaded');
  } catch (err) {
    templateError = err instanceof Error ? err.message : String(err);
    log.warn({ error: templateError }, 'approval replies disabled — template not configured');
  }

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
      const writeAction = resolveWriteAction(disposition, row.suggests_exchange === 1);
      if (writeAction === 'none') {
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
      // Serial number is deliberately NOT required. It used to gate the
      // write because writePriceLineUpdate cross-checked it, but that check
      // was removed (2026-08-23) — PSA's BN system means our serial
      // routinely differs from the vendor's. Requiring it here would keep
      // enforcing a rule that no longer exists.
      if (!row.resolved_esd && !row.suggests_exchange) missing.push('ESD');
      if (missing.length > 0) {
        skip(`Missing ${missing.join(', ')} — refusing to write a partial update.`);
        continue;
      }

      const priceString = row.unit_price!.toFixed(2);
      // Exchange rows may legitimately have no ESD (the conversion form
      // carries no promised-by date), so this is only computed when one exists.
      const esdMxi = row.resolved_esd ? toMxiDateFormat(row.resolved_esd) : '';

      log.info({ orderNumber, env, price: priceString, esd: esdMxi }, 'attempting quote write');

      // EXCHANGE branch (per explicit user direction, 2026-08-23). A vendor
      // offering a replacement unit is a different MXI action entirely:
      // Convert Repair To Exchange carries its OWN exchange price, so this
      // deliberately runs INSTEAD OF the price-line write, never alongside
      // it — doing both would push the same money twice through two
      // different mechanisms.
      let result: PriceLineUpdateResult;
      if (writeAction === 'scrap_price') {
        // NREP / BER — the part is being scrapped, so the money moves onto
        // a SCRAP line rather than being written as a repair price.
        //
        // The FEE differs by route, and this distinction matters: an NREP
        // quote literally states a scrap fee, so its extracted price is
        // already the right number. A BER row's extracted price is that
        // quote's REPAIR cost, which would be a large wrong charge — so it
        // uses the configured default instead.
        const scrapFee = disposition === 'excluded_ber' ? BER_DEFAULT_SCRAP_FEE : priceString;
        log.info({ orderNumber, env, scrapFee, disposition }, 'routing to scrap pricing');
        const scrap = await writeScrapPriceLines(client, row.order_number!, scrapFee, password ?? '');
        result = {
          status: scrap.status,
          outcome: scrap.status === 'success' ? 'written' : 'failed',
          originalPrice: null,
          serialNumberMxi: null,
          issueDetail: scrap.issueDetail,
          errorMessage: scrap.errorMessage ?? scrap.skipReason,
        };
      } else if (writeAction === 'exchange') {
        log.info({ orderNumber, env, price: priceString }, 'quote suggests exchange — converting rather than pricing');
        const exchange = await convertRepairToExchange(
          client,
          row.order_number!,
          priceString,
          password ?? '',
        );
        // Mapped onto the same result shape so everything downstream —
        // audit row, envelope, UI, reply — stays identical for both paths.
        result = {
          status: exchange.status,
          outcome: exchange.status === 'success' ? 'written' : 'failed',
          originalPrice: null,
          serialNumberMxi: null,
          issueDetail: exchange.issueDetail,
          errorMessage: exchange.errorMessage ?? exchange.skipReason,
        };
      } else {
        result = await writePriceLineUpdate(
          client,
          row.order_number!,
          row.serial_number ?? '',
          priceString,
          password ?? '',
          esdMxi,
        );
      }

      // Guard 4: mail is only ever marked read, or replied to, after a
      // verified success. A failed write never emails a vendor.
      let markedRead = false;
      let markReadError: string | null = null;
      let replyStatus: 'drafted' | 'sent' | 'failed' | 'skipped' | null = null;
      let replyError: string | null = null;

      if (result.status === 'success') {
        const mark = await markOutlookMailRead(row.source_entry_id);
        markedRead = mark.ok;
        markReadError = mark.error;

        if (approvalTemplate) {
          // Greeting name: the sign-off the AI read from the body, falling
          // back to parsing the From display name. If NEITHER yields a
          // plausible first name, the reply is skipped rather than sent as
          // "Hello !" — a malformed greeting to a real vendor is worse
          // than no reply, and the MXI write still stands either way.
          const greetingName = row.sender_first_name?.trim() || firstNameFromDisplayName(row.sender_name);

          if (!greetingName) {
            replyStatus = 'skipped';
            replyError =
              `No sender first name could be determined (no sign-off in the body, and the From name ` +
              `"${row.sender_name ?? '(none)'}" didn't parse) — skipped rather than greeting the vendor with a blank name.`;
          } else {
            const body = renderApprovalReply(approvalTemplate, {
              orderNumber: row.order_number!,
              quoteNumber: row.quote_number,
              partNumber: row.part_number,
              serialNumber: row.serial_number,
              price: formatPriceForEmail(priceString),
              currency: row.currency,
              esd: esdMxi,
              vendorName: row.vendor_name,
              senderFirstName: greetingName,
            });
            const reply = await createOutlookReply(row.source_entry_id, body, replyMode);
            replyStatus = reply.ok ? (reply.mode === 'send' ? 'sent' : 'drafted') : 'failed';
            replyError = reply.error;
          }
        } else {
          replyStatus = 'skipped';
          replyError = templateError;
        }
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
        replyStatus,
        replyError,
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
        issueDetail: result.issueDetail,
        // Deliberately distinct from errorMessage: a mailbox bookkeeping
        // miss is NOT a failed MXI write, and must not read like one. Same
        // reasoning for replyStatus/replyError.
        markReadError,
        replyStatus,
        replyError,
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
