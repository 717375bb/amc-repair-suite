import type {
  QuoteExtractionInput,
  QuoteExtractionProvider,
  QuoteExtractionResult,
} from './extractionTypes.js';

/**
 * No-op extraction provider — exercises the whole pipeline (Outlook read ->
 * ESD derivation -> DB insert -> printed summary) with ZERO API calls and
 * no API key required. Same purpose and shape as
 * inference/dryRunProvider.ts.
 *
 * Deliberately still recovers the order number from the email subject and
 * filename by regex, because that costs nothing and makes a --dry-run
 * genuinely useful for checking the Outlook half in isolation: you can see
 * which real orders a run WOULD touch without paying for extraction or
 * trusting a model. Everything that genuinely requires reading the PDF
 * (price, dates, PN/SN) comes back null, and confidence is always 'low' so
 * a dry-run row can never be mistaken for a real extraction.
 */
export class DryRunQuoteProvider implements QuoteExtractionProvider {
  async extract(input: QuoteExtractionInput): Promise<QuoteExtractionResult> {
    const orderPattern = /\bP000[A-Z0-9]{4}\b/i;
    const fromSubject = input.subject?.match(orderPattern)?.[0];
    const fromFileName = input.fileName.match(orderPattern)?.[0];
    const found = fromSubject ?? fromFileName ?? null;

    return {
      documentKind: 'quote',
      orderNumber: found ? found.toUpperCase() : null,
      orderNumberSource: fromSubject ? 'email_subject' : fromFileName ? 'file_name' : null,
      quoteNumber: null,
      vendorName: null,
      partNumber: null,
      serialNumber: null,
      unitPrice: null,
      currency: null,
      quoteDate: null,
      promisedShipDate: null,
      leadTimeDays: null,
      // No PDF was read, so no vendor claim was seen. Never assert one.
      vendorSaysNonRepairable: false,
      nonRepairableEvidence: null,
      senderFirstName: null,
      confidence: 'low',
      reasoningNote: 'Dry run — no PDF was read and no API call was made.',
    };
  }
}
