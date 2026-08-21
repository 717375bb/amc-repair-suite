import 'dotenv/config';
import path from 'node:path';
import { insertQuoteExtraction, insertQuoteRun, openDb } from '../../db/db.js';
import { getSecretProvider } from '../../security/secretProvider.js';
import { AnthropicQuoteProvider } from '../../quoteWriter/anthropicQuoteProvider.js';
import { readOutlookQuotes, OutlookReadError } from '../../quoteWriter/outlookReader.js';
import { resolveQuoteEsd } from '../../quoteWriter/quoteEsd.js';
import { initialDisposition } from '../../quoteWriter/quoteDisposition.js';
import { watchStdinForCancellation } from './cancellationWatcher.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('quote');

/**
 * Vendor Quote Writer — ingest runner, spawned by quoteJobManager.ts.
 *
 * Same pipeline as cli/quoteIngestCli.ts, but streams one 'extraction'
 * envelope per PDF so the UI fills in progressively instead of waiting on
 * a whole batch (extraction is ~7s per PDF, so a 25-PDF run is minutes).
 *
 * Touches neither MXI nor the mailbox — this is the read-and-understand
 * half only.
 */

interface Envelope {
  type: 'phase' | 'summary' | 'extraction' | 'fatal' | 'done';
  [key: string]: unknown;
}

function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function parseArgs(): { folderPath: string; max: number; unreadOnly: boolean } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const folderPath = get('--folder');
  if (!folderPath) throw new Error('--folder is required');
  return {
    folderPath,
    max: Number(get('--max') ?? 25),
    unreadOnly: args.includes('--unread-only'),
  };
}

async function main(): Promise<void> {
  const { folderPath, max, unreadOnly } = parseArgs();
  const startedAt = new Date().toISOString();

  const secretProvider = getSecretProvider();
  await secretProvider.init();
  const provider = new AnthropicQuoteProvider(secretProvider.get('ANTHROPIC_API_KEY'));

  // Checked between PDFs, never mid-extraction. Nothing here holds a
  // browser or mailbox handle, so cancelling only avoids further real API
  // cost — there's no shared resource to orphan.
  const cancelSignal = watchStdinForCancellation();

  emit({ type: 'phase', phase: 'reading-outlook' });
  let read;
  try {
    read = await readOutlookQuotes({ folderPath, maxMessages: max, unreadOnly });
  } catch (err) {
    if (err instanceof OutlookReadError) {
      emit({ type: 'fatal', message: err.message });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const pdfCount = read.messages.reduce((sum, m) => sum + m.attachments.length, 0);
  const db = openDb(path.join('data', 'audit.db'));
  const dbRunId = insertQuoteRun(db, {
    startedAt,
    folderPath: read.folderPath,
    scannedCount: read.scannedCount,
    pdfCount,
  });

  emit({
    type: 'summary',
    dbRunId,
    folderPath: read.folderPath,
    scannedCount: read.scannedCount,
    pdfCount,
  });

  if (pdfCount === 0) {
    db.close();
    emit({ type: 'done' });
    return;
  }

  emit({ type: 'phase', phase: 'extracting' });

  for (const message of read.messages) {
    for (const attachment of message.attachments) {
      if (cancelSignal.aborted) break;

      const extraction = await provider.extract({
        pdfPath: attachment.savedPath,
        fileName: attachment.fileName,
        subject: message.subject,
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        emailBody: message.body,
      });

      const isQuote = extraction.documentKind === 'quote';
      const esd = isQuote ? resolveQuoteEsd(extraction) : null;

      // A vendor-stated non-repairable auto-excludes: no repair means no
      // repair to price. A human can still override it back to pending.
      const disposition = isQuote ? initialDisposition(extraction.vendorSaysNonRepairable) : 'excluded_other';

      // Every reason a row can't be auto-trusted, surfaced explicitly
      // rather than collapsed into one opaque boolean — the reviewer needs
      // to know WHY, not just that something's off.
      const reviewReasons: string[] = [];
      if (isQuote && !extraction.orderNumber) reviewReasons.push('No order number found');
      if (isQuote && extraction.unitPrice === null) reviewReasons.push('No price found');
      if (isQuote && extraction.confidence === 'low') reviewReasons.push('Low extraction confidence');
      if (esd?.needsReview) reviewReasons.push(esd.explanation);
      if (extraction.vendorSaysNonRepairable) {
        reviewReasons.push(
          `Vendor says NON-REPAIRABLE${extraction.nonRepairableEvidence ? `: "${extraction.nonRepairableEvidence}"` : ''}`,
        );
      }

      const extractionId = insertQuoteExtraction(db, {
        runId: dbRunId,
        sourceEntryId: message.entryId,
        subject: message.subject,
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        receivedTime: message.receivedTime,
        fileName: attachment.fileName,
        savedPath: attachment.savedPath,
        documentKind: extraction.documentKind,
        orderNumber: extraction.orderNumber,
        orderNumberSource: extraction.orderNumberSource,
        quoteNumber: extraction.quoteNumber,
        vendorName: extraction.vendorName,
        partNumber: extraction.partNumber,
        serialNumber: extraction.serialNumber,
        unitPrice: extraction.unitPrice,
        currency: extraction.currency,
        quoteDate: extraction.quoteDate,
        promisedShipDate: extraction.promisedShipDate,
        leadTimeDays: extraction.leadTimeDays,
        resolvedEsd: esd?.esd ?? null,
        esdBasis: esd?.basis ?? null,
        needsReview: reviewReasons.length > 0,
        vendorSaysNonRepairable: extraction.vendorSaysNonRepairable,
        nonRepairableEvidence: extraction.nonRepairableEvidence,
        senderFirstName: extraction.senderFirstName,
        initialDisposition: disposition,
        confidence: extraction.confidence,
        reasoningNote: extraction.reasoningNote,
      });

      emit({
        type: 'extraction',
        row: {
          extractionId,
          entryId: message.entryId,
          subject: message.subject,
          senderName: message.senderName,
          fileName: attachment.fileName,
          documentKind: extraction.documentKind,
          orderNumber: extraction.orderNumber,
          orderNumberSource: extraction.orderNumberSource,
          quoteNumber: extraction.quoteNumber,
          vendorName: extraction.vendorName,
          partNumber: extraction.partNumber,
          serialNumber: extraction.serialNumber,
          unitPrice: extraction.unitPrice,
          currency: extraction.currency,
          quoteDate: extraction.quoteDate,
          promisedShipDate: extraction.promisedShipDate,
          resolvedEsd: esd?.esd ?? null,
          esdBasis: esd?.basis ?? null,
          esdExplanation: esd?.explanation ?? null,
          needsReview: reviewReasons.length > 0,
          reviewReasons,
          vendorSaysNonRepairable: extraction.vendorSaysNonRepairable,
          nonRepairableEvidence: extraction.nonRepairableEvidence,
          disposition,
          confidence: extraction.confidence,
          reasoningNote: extraction.reasoningNote,
        },
      });
    }
    if (cancelSignal.aborted) break;
  }

  db.close();
  emit({ type: 'done' });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ error: message }, 'quote ingest runner failed');
  emit({ type: 'fatal', message });
  process.exitCode = 1;
});
