import 'dotenv/config';
import path from 'node:path';
import { insertQuoteExtraction, insertQuoteRun, openDb } from '../db/db.js';
import { createLogger } from '../logging/logger.js';
import { getSecretProvider } from '../security/secretProvider.js';
import { AnthropicQuoteProvider } from '../quoteWriter/anthropicQuoteProvider.js';
import { DryRunQuoteProvider } from '../quoteWriter/dryRunQuoteProvider.js';
import { readOutlookQuotes, OutlookReadError } from '../quoteWriter/outlookReader.js';
import { resolveQuoteEsd } from '../quoteWriter/quoteEsd.js';
import { initialDisposition } from '../quoteWriter/quoteDisposition.js';
import type { QuoteExtractionProvider } from '../quoteWriter/extractionTypes.js';

const log = createLogger('quote');

/**
 * Vendor Quote Writer — ingest CLI (Stages 1-3).
 *
 * Reads quote PDFs from the configured Outlook folder, extracts each with
 * Claude, derives the ESD, and records everything to data/audit.db.
 *
 * **Writes nothing to MXI and nothing to the mailbox.** This is the
 * read-and-understand half; the write half is a separate, human-approved
 * step, same split as the ESD Finder's compare-then-write design.
 *
 * Usage:
 *   npm run quote:ingest -- [--folder "Inbox\Quotes"] [--max 25] [--since-days 7] [--dry-run]
 *
 * --dry-run uses DryRunQuoteProvider: exercises the whole pipeline
 * (Outlook read -> ESD derivation -> DB insert) with ZERO API calls and no
 * key required, exactly like the ESD pipeline's own --dry-run.
 */

interface Args {
  folderPath: string;
  max: number;
  sinceDays: number;
  dryRun: boolean;
  unreadOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const folderPath = get('--folder') ?? process.env.QUOTES_FOLDER_PATH;
  if (!folderPath) {
    throw new Error(
      'No quotes folder configured. Pass --folder "Inbox\\Quotes" or set QUOTES_FOLDER_PATH in .env.',
    );
  }
  return {
    folderPath,
    max: Number(get('--max') ?? 25),
    sinceDays: Number(get('--since-days') ?? 0),
    dryRun: argv.includes('--dry-run'),
    unreadOnly: argv.includes('--unread-only'),
  };
}

function fmtMoney(value: number | null, currency: string | null): string {
  if (value === null) return '—';
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  let provider: QuoteExtractionProvider;
  if (args.dryRun) {
    provider = new DryRunQuoteProvider();
    log.info('DRY RUN — no Anthropic API calls will be made.');
  } else {
    const secretProvider = getSecretProvider();
    await secretProvider.init();
    provider = new AnthropicQuoteProvider(secretProvider.get('ANTHROPIC_API_KEY'));
  }

  let read;
  try {
    read = await readOutlookQuotes({
      folderPath: args.folderPath,
      maxMessages: args.max,
      sinceDays: args.sinceDays,
      unreadOnly: args.unreadOnly,
    });
  } catch (err) {
    if (err instanceof OutlookReadError) {
      log.error({ error: err.message }, 'Could not read the Outlook quotes folder');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const pdfCount = read.messages.reduce((sum, m) => sum + m.attachments.length, 0);
  if (pdfCount === 0) {
    log.info({ folderPath: read.folderPath, scanned: read.scannedCount }, 'No PDF attachments found — nothing to do.');
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  const runId = insertQuoteRun(db, {
    startedAt,
    folderPath: read.folderPath,
    scannedCount: read.scannedCount,
    pdfCount,
  });

  console.log(`\nRun ID ${runId} — ${read.folderPath}`);
  console.log(`Scanned ${read.scannedCount} message(s), ${pdfCount} PDF(s) to extract.\n`);

  let quotes = 0;
  let nonQuotes = 0;
  let needsReview = 0;

  for (const message of read.messages) {
    for (const attachment of message.attachments) {
      const extraction = await provider.extract({
        pdfPath: attachment.savedPath,
        fileName: attachment.fileName,
        subject: message.subject,
        senderName: message.senderName,
        senderEmail: message.senderEmail,
        emailBody: message.body,
      });

      const isQuote = extraction.documentKind === 'quote';
      // Only a real quote gets an ESD derived. A shop-finding report or an
      // unrelated PDF has no ESD to compute and must never look writable.
      const esd = isQuote ? resolveQuoteEsd(extraction) : null;

      // A quote we can't tie to an order, or can't price, can never be
      // written — surfaced as review rather than silently dropped.
      const missingOrder = isQuote && !extraction.orderNumber;
      const missingPrice = isQuote && extraction.unitPrice === null;
      const rowNeedsReview =
        (esd?.needsReview ?? false) || missingOrder || missingPrice || (isQuote && extraction.confidence === 'low');

      insertQuoteExtraction(db, {
        runId,
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
        needsReview: rowNeedsReview,
        vendorSaysNonRepairable: extraction.vendorSaysNonRepairable,
        nonRepairableEvidence: extraction.nonRepairableEvidence,
        senderFirstName: extraction.senderFirstName,
        initialDisposition: isQuote ? initialDisposition(extraction.vendorSaysNonRepairable) : 'excluded_other',
        confidence: extraction.confidence,
        reasoningNote: extraction.reasoningNote,
      });

      if (isQuote) quotes++;
      else nonQuotes++;
      if (rowNeedsReview) needsReview++;

      const flags: string[] = [];
      if (missingOrder) flags.push('NO ORDER #');
      if (missingPrice) flags.push('NO PRICE');
      if (esd?.needsReview) flags.push('ESD NEEDS CHECK');
      if (isQuote && extraction.confidence === 'low') flags.push('LOW CONFIDENCE');
      if (extraction.vendorSaysNonRepairable) flags.push('NREP (vendor says non-repairable)');

      if (isQuote) {
        console.log(
          `  ${(extraction.orderNumber ?? '????????').padEnd(9)} ` +
            `${fmtMoney(extraction.unitPrice, extraction.currency).padStart(14)}  ` +
            `ESD ${esd?.esd ?? '—'}  ` +
            `${(extraction.vendorName ?? '').slice(0, 26).padEnd(26)}` +
            `${flags.length ? '  << ' + flags.join(', ') : ''}`,
        );
      } else {
        console.log(`  (skipped: ${extraction.documentKind})  ${attachment.fileName.slice(0, 48)}`);
      }
    }
  }

  db.close();

  console.log(`\n${quotes} quote(s), ${nonQuotes} non-quote PDF(s) skipped, ${needsReview} need review.`);
  console.log(`Nothing has been written to MXI or to your mailbox.`);
  console.log(`Run ID ${runId} is recorded in data/audit.db.\n`);
}

main().catch((err) => {
  log.error({ error: err instanceof Error ? err.message : String(err) }, 'quote ingest failed');
  process.exitCode = 1;
});
