import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logging/logger.js';
import type { ScrapCertExtraction, ScrapCertInput, ScrapCertProvider } from './certExtractionTypes.js';

const log = createLogger('scrap');

const MODEL = 'claude-sonnet-5';
const TOOL_NAME = 'record_scrap_certificate';
const MAX_ATTEMPTS = 2;

/**
 * Same model choice and forced-tool-call discipline as the quote reader:
 * these values drive a real, irreversible MXI scrap, so accuracy is worth
 * more than the per-call saving.
 */
const SYSTEM_PROMPT = `You are reading a PDF that should be a SCRAP CERTIFICATE (often titled "Scrap Certification", "Notice of Destruction", or similar) sent to PSA Airlines by an outside repair vendor after physically destroying a part.

FIRST decide whether this really is a scrap certificate. If it is a quote, an invoice, a shop findings report, a packing slip, or anything else, set isScrapCertificate to false and leave the identifier fields null. Do not try to salvage a scrap cert out of a document that isn't one — the downstream action physically scraps a real part in the maintenance system.

ORDER NUMBER: PSA repair order numbers look like "P000" followed by four alphanumeric characters (e.g. P000BCSG). On a scrap cert this is almost always labelled "Customer PO" or "Customer P.O." — NOT the vendor's own reference. Vendors also print their OWN work order / RO number (e.g. "Barfield RO: WOP1134279"); that goes in vendorReference, never in orderNumber.

SERIAL NUMBER: the S/N of the destroyed part, exactly as printed. This is used to pick the correct item out of a list in MXI, so transcribe it character-for-character — do not normalise case, strip leading zeros, or "tidy" it.

If either the order number or the serial number is genuinely absent or illegible, return null for it and say so in reasoningNote. A null is always better than a guess here: a wrong serial would scrap the wrong part.

CONFIDENCE: "high" only when the document is clearly legible and both identifiers are unambiguous. Use "low" for scans you are partly guessing at.

Always call the record_scrap_certificate tool.`;

const inputSchema = {
  type: 'object' as const,
  properties: {
    isScrapCertificate: { type: 'boolean' },
    orderNumber: {
      type: ['string', 'null'],
      description: 'PSA order number from "Customer PO", e.g. "P000BCSG". Never the vendor\'s own RO number.',
    },
    serialNumber: {
      type: ['string', 'null'],
      description: 'Serial number of the destroyed part, transcribed exactly as printed.',
    },
    partNumber: { type: ['string', 'null'] },
    vendorName: { type: ['string', 'null'] },
    vendorReference: {
      type: ['string', 'null'],
      description: "The vendor's own work order / RO reference, e.g. \"WOP1134279\".",
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoningNote: { type: 'string' },
  },
  required: ['isScrapCertificate', 'confidence', 'reasoningNote'],
};

function failureResult(reason: string): ScrapCertExtraction {
  return {
    isScrapCertificate: false,
    orderNumber: null,
    serialNumber: null,
    partNumber: null,
    vendorName: null,
    vendorReference: null,
    confidence: 'low',
    reasoningNote: reason,
  };
}

export class AnthropicScrapCertProvider implements ScrapCertProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(input: ScrapCertInput): Promise<ScrapCertExtraction> {
    const pdfBase64 = (await readFile(input.pdfPath)).toString('base64');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: MODEL,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: [{ name: TOOL_NAME, description: 'Record the scrap certificate details.', input_schema: inputSchema }],
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
                { type: 'text', text: `Attachment filename: ${input.fileName}` },
              ],
            },
          ],
        });

        const toolUse = response.content.find((c) => c.type === 'tool_use');
        if (!toolUse || toolUse.type !== 'tool_use') {
          if (attempt < MAX_ATTEMPTS) continue;
          return failureResult('Model did not return a tool call.');
        }

        const raw = toolUse.input as Record<string, unknown> & Partial<ScrapCertExtraction>;
        return {
          isScrapCertificate: raw.isScrapCertificate === true,
          orderNumber: raw.orderNumber ?? null,
          serialNumber: raw.serialNumber ?? null,
          partNumber: raw.partNumber ?? null,
          vendorName: raw.vendorName ?? null,
          vendorReference: raw.vendorReference ?? null,
          confidence: raw.confidence ?? 'low',
          reasoningNote: raw.reasoningNote ?? '',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ attempt, fileName: input.fileName, error: message }, 'scrap cert extraction attempt failed');
        if (attempt >= MAX_ATTEMPTS) return failureResult(`Extraction failed after ${MAX_ATTEMPTS} attempts: ${message}`);
      }
    }
    return failureResult('Unreachable.');
  }
}
