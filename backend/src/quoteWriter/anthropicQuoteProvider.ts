import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logging/logger.js';
import type {
  QuoteExtractionInput,
  QuoteExtractionProvider,
  QuoteExtractionResult,
} from './extractionTypes.js';

const log = createLogger('quote');

/**
 * Sonnet rather than the Haiku used by inference/anthropicProvider.ts — a
 * deliberate, documented tradeoff. That provider classifies short free-text
 * notes; this one reads money off a document that may well be a scan, and a
 * misread price gets written into a real MXI order. Accuracy is worth more
 * than the per-call saving here. Change in one place if that calculus ever
 * shifts.
 */
const MODEL = 'claude-sonnet-5';
const TOOL_NAME = 'record_quote_extraction';
const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `You are reading a PDF attached to an email sent to PSA Airlines' component repair team by an outside repair vendor. Extract the quote details exactly as stated. Never estimate, infer, or "helpfully" fill in a value that is not really there — a null is always better than a guess, because these values get written into a real maintenance system.

FIRST decide what the document actually is:
- "quote": a repair quotation / estimate / price proposal for repairing a specific part.
- "shop_finding_report": a teardown or shop findings report. These frequently arrive in the SAME email as a real quote — it is not the quote itself, even if it mentions money.
- "other_not_a_quote": anything else (receiving discrepancy notices, packing slips, invoices for already-completed work, correspondence).

If it is not a quote, set documentKind accordingly and leave the money/date fields null. Do not try to salvage a quote out of a document that isn't one.

ORDER NUMBER: PSA repair order numbers look like "P000" followed by four alphanumeric characters (e.g. P000BDY1, P000BAWT). Look in the PDF body, but ALSO use the email subject and attachment filename provided in the user message — vendors very often put the order number only in the subject line ("Repair Quote for your RO# P000BDY1") or the filename. Record which of those three places you actually found it in via orderNumberSource. If it appears in more than one place, prefer the PDF body and report that.

PRICE: report the total quoted repair amount as a plain number — no currency symbol, no thousands separators (e.g. 1359.79, not "$1,359.79"). If the document shows several line items, report the TOTAL the vendor is asking for. If you genuinely cannot tell which figure is the total, set unitPrice to null and say so in reasoningNote rather than guessing.

TURNAROUND: quotes express this two different ways. If an explicit calendar ship/ready/delivery date is given, put it in promisedShipDate as an ISO date and leave leadTimeDays null. If instead it gives a turnaround in days ("10-14 days ARO", "30 day TAT"), put the number in leadTimeDays and leave promisedShipDate null. If a RANGE is given, take the LONGER end — under-promising is the safer error. If neither is stated, both are null.

NON-REPAIRABLE (important): set vendorSaysNonRepairable to true ONLY when the vendor themselves states the part cannot be repaired. Real cues include "NREP", "non-repairable", "not repairable", "unserviceable", "beyond repair", "scrap", "condemned", "BER", or language saying they are returning it unrepaired. When true, quote the vendor's own supporting words verbatim in nonRepairableEvidence.

Check the EMAIL BODY for this as well as the PDF. This is not hypothetical: a real message in this folder stated a scrap decision only in the body ("The scrap fee for P000BCSG ... is $360") while the attached PDF said nothing about it. A vendor quoting a SCRAP FEE rather than a repair price is stating the part is non-repairable.

Be strict about this. It must reflect what the VENDOR said, not your own judgement about whether the price seems too high to be worth repairing — that commercial call belongs to PSA, never to you and never to the vendor. A quote that is merely expensive is NOT non-repairable. If the vendor is quoting a price to perform a repair, that is a normal repairable quote, however costly. If the document is ambiguous, set it false and explain the ambiguity in reasoningNote.

CONFIDENCE: "high" only when the document is clearly legible and the key fields are unambiguous. Use "low" for scans you are partly guessing at, and say what was unclear in reasoningNote.

Always call the record_quote_extraction tool.`;

const inputSchema = {
  type: 'object' as const,
  properties: {
    documentKind: {
      type: 'string',
      enum: ['quote', 'shop_finding_report', 'other_not_a_quote'],
    },
    orderNumber: {
      type: ['string', 'null'],
      description: 'PSA repair order number, e.g. "P000BDY1". Null if genuinely absent everywhere.',
    },
    orderNumberSource: {
      type: ['string', 'null'],
      enum: ['pdf_body', 'email_subject', 'file_name', null],
      description: 'Where the order number was actually found. Null if orderNumber is null.',
    },
    quoteNumber: { type: ['string', 'null'] },
    vendorName: { type: ['string', 'null'] },
    partNumber: { type: ['string', 'null'] },
    serialNumber: { type: ['string', 'null'] },
    unitPrice: {
      type: ['number', 'null'],
      description: 'Total quoted amount as a plain number. Null if not determinable.',
    },
    currency: { type: ['string', 'null'], description: 'ISO 4217 e.g. "USD".' },
    quoteDate: { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD).' },
    promisedShipDate: {
      type: ['string', 'null'],
      description: 'ISO date (YYYY-MM-DD). Null when turnaround is given in days instead.',
    },
    leadTimeDays: {
      type: ['integer', 'null'],
      description: 'Turnaround in days, longer end of any range. Null when an explicit date is given instead.',
    },
    vendorSaysNonRepairable: {
      type: 'boolean',
      description:
        'True ONLY if the vendor states the part cannot be repaired (NREP / non-repairable / unserviceable / scrap / condemned). Never your own judgement about whether the price is worth it.',
    },
    nonRepairableEvidence: {
      type: ['string', 'null'],
      description: "The vendor's own supporting words, verbatim. Null when vendorSaysNonRepairable is false.",
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoningNote: { type: 'string' },
  },
  required: ['documentKind', 'vendorSaysNonRepairable', 'confidence', 'reasoningNote'],
};

function failureResult(reason: string): QuoteExtractionResult {
  return {
    documentKind: 'other_not_a_quote',
    orderNumber: null,
    orderNumberSource: null,
    quoteNumber: null,
    vendorName: null,
    partNumber: null,
    serialNumber: null,
    unitPrice: null,
    currency: null,
    quoteDate: null,
    promisedShipDate: null,
    leadTimeDays: null,
    // Deliberately false on a failed extraction: absence of evidence is not
    // evidence the vendor said anything. A failed row is a needs-review row
    // regardless, and must never silently assert a scrap-relevant claim.
    vendorSaysNonRepairable: false,
    nonRepairableEvidence: null,
    confidence: 'low',
    reasoningNote: reason,
  };
}

/**
 * Real Claude-backed PDF extraction. Sends the PDF itself (base64 document
 * block) rather than pre-extracted text, so scanned/image quotes work
 * identically to machine-generated ones — the user confirmed the real mix
 * is unknown, so a text-only extractor would have silently failed on the
 * first scan.
 *
 * Mirrors inference/anthropicProvider.ts's discipline exactly: forced
 * tool_choice (never free-text JSON parsing), one retry, then a safe
 * explicit-failure result rather than throwing and killing the whole run.
 * A failed extraction becomes a needs-review row, never a silent skip and
 * never a guess.
 */
export class AnthropicQuoteProvider implements QuoteExtractionProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(input: QuoteExtractionInput): Promise<QuoteExtractionResult> {
    let pdfBase64: string;
    try {
      pdfBase64 = (await readFile(input.pdfPath)).toString('base64');
    } catch (err) {
      return failureResult(
        `Could not read PDF from disk: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const contextLines = [
      `Attachment filename: ${input.fileName}`,
      `Email subject: ${input.subject ?? '(none)'}`,
      `Sender: ${input.senderName ?? '(unknown)'} <${input.senderEmail ?? 'unknown'}>`,
      '',
      'Email body (may be truncated):',
      input.emailBody?.trim() || '(empty)',
    ].join('\n');

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          tools: [{ name: TOOL_NAME, description: 'Record the extracted quote details.', input_schema: inputSchema }],
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
                },
                {
                  type: 'text',
                  text: `${contextLines}\n\nExtract the quote details from the attached PDF.`,
                },
              ],
            },
          ],
        });

        const toolUse = response.content.find((b) => b.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') {
          lastError = 'Model did not return a tool_use block.';
          continue;
        }

        const raw = toolUse.input as Partial<QuoteExtractionResult>;
        if (!raw.documentKind) {
          lastError = 'Tool response omitted documentKind.';
          continue;
        }

        return {
          documentKind: raw.documentKind,
          orderNumber: raw.orderNumber ?? null,
          orderNumberSource: raw.orderNumberSource ?? null,
          quoteNumber: raw.quoteNumber ?? null,
          vendorName: raw.vendorName ?? null,
          partNumber: raw.partNumber ?? null,
          serialNumber: raw.serialNumber ?? null,
          unitPrice: typeof raw.unitPrice === 'number' ? raw.unitPrice : null,
          currency: raw.currency ?? null,
          quoteDate: raw.quoteDate ?? null,
          promisedShipDate: raw.promisedShipDate ?? null,
          leadTimeDays: typeof raw.leadTimeDays === 'number' ? raw.leadTimeDays : null,
          // Strict === true: anything the model returns other than a real
          // boolean true must not become a scrap signal by coercion.
          vendorSaysNonRepairable: raw.vendorSaysNonRepairable === true,
          nonRepairableEvidence: raw.nonRepairableEvidence ?? null,
          confidence: raw.confidence ?? 'low',
          reasoningNote: raw.reasoningNote ?? '(no reasoning note returned)',
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn({ attempt, fileName: input.fileName, error: lastError }, 'quote extraction attempt failed');
      }
    }

    return failureResult(`Extraction failed after ${MAX_ATTEMPTS} attempt(s): ${lastError ?? 'unknown error'}`);
  }
}
