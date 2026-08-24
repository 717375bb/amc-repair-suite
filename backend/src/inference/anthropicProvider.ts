import Anthropic from '@anthropic-ai/sdk';
import { describeError } from '../quoteWriter/connectionErrorDetail.js';
import { PARTS_PENDING_MAX_DAYS, PARTS_PENDING_MIN_DAYS } from './constants.js';
import type { EsdInferenceInput, EsdInferenceProvider, EsdInferenceResult } from './types.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TOOL_NAME = 'record_esd_inference';

const SYSTEM_PROMPT = `You're reviewing repair vendor notes for an airline component repair order. Determine whether the text tells us when the part will actually come back to us (the ESD), as opposed to a date about something else entirely, like the vendor's own upstream part order or a manufacturer's shipment to them.

Classify the text into exactly one of these categories:
- "explicit_date": the vendor states a clear, firm promise/ship date for OUR part.
- "vendor_quote_estimate": the vendor has given an estimate or quote date that is not yet confirmed. This is very often phrased as an "EQD" or "estimated quote date" — treat EQD/"estimated quote date" as an explicit, direct cue for this category, not just generic estimate language.
- "parts_pending": the vendor is clearly waiting on a sub-part or manufacturer shipment before they can work on or ship our part. Any date mentioned refers to that upstream event, not directly to our part's ship date. Reason about how many additional days (20-30) are reasonable based on how firm or vague the wait sounds — do not default to the middle of the range every time.
- "not_esd_relevant": the text references the part being scrapped or already shipped/returned. Nothing about a future ESD applies here — this takes priority even if some other date appears in the text (e.g. a shipped-on date or scrap-approval date is not an ESD).
- "quote_sent_reference": the text mentions a quote having been sent (to PSA or the customer) but gives no date you can compute an ESD from. This is a distinct signal for a future quote-follow-up workflow, not something to force into a date estimate.
- "none": there is no date of any kind anywhere in the text, and none of the categories above apply.

If the text contains a date that is genuinely the vendor's promise/estimate for shipping OUR part, you must classify it as explicit_date, vendor_quote_estimate, or parts_pending and extract that date — "none" is only for text with truly no date anywhere and no other category applicable, not a way to hedge on an unclear one. "not_esd_relevant" and "quote_sent_reference" never carry an extractedBaseDate, even if some other date is mentioned in the text — set extractedBaseDate to null for both.

Always call the record_esd_inference tool with your findings.`;

const inputSchema = {
  type: 'object' as const,
  properties: {
    classification: {
      type: 'string',
      enum: [
        'explicit_date',
        'vendor_quote_estimate',
        'parts_pending',
        'not_esd_relevant',
        'quote_sent_reference',
        'none',
      ],
    },
    extractedBaseDate: {
      type: ['string', 'null'],
      description:
        'ISO date (YYYY-MM-DD) found in the text. Null only if classification is "none".',
    },
    suggestedPartsPendingOffsetDays: {
      type: ['integer', 'null'],
      description: `Only meaningful when classification is "parts_pending". A reasoned offset between ${PARTS_PENDING_MIN_DAYS} and ${PARTS_PENDING_MAX_DAYS} inclusive, based on how firm or vague the wait sounds. Null otherwise.`,
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
    },
    reasoningNote: {
      type: 'string',
      description:
        '1-2 sentence internal note explaining the classification, for audit/debugging. Not customer-facing.',
    },
  },
  required: [
    'classification',
    'extractedBaseDate',
    'suggestedPartsPendingOffsetDays',
    'confidence',
    'reasoningNote',
  ],
};

export class AnthropicEsdProvider implements EsdInferenceProvider {
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async infer(input: EsdInferenceInput): Promise<EsdInferenceResult> {
    try {
      return await this.attemptInfer(input);
    } catch {
      try {
        return await this.attemptInfer(input);
      } catch (secondError) {
        const message = describeError(secondError);
        return {
          classification: 'none',
          extractedBaseDate: null,
          suggestedPartsPendingOffsetDays: null,
          confidence: 'low',
          reasoningNote: `AI inference failed after retry: ${message}`,
        };
      }
    }
  }

  private async attemptInfer(input: EsdInferenceInput): Promise<EsdInferenceResult> {
    const userContent = [
      `Order Number: ${input.orderNumber}`,
      `Vendor Name: ${input.vendorName || '(unknown)'}`,
      `Current Status: ${input.currentStatus || '(blank)'}`,
      `Vendor Notes: ${input.vendorNotes || '(blank)'}`,
    ].join('\n');

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: TOOL_NAME,
          description: 'Record the ESD inference classification for this order.',
          input_schema: inputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userContent }],
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      throw new Error('No tool_use block in response');
    }

    return this.validateResult(toolUse.input);
  }

  private validateResult(raw: unknown): EsdInferenceResult {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Malformed tool response: not an object');
    }
    const obj = raw as Record<string, unknown>;

    const classification = obj.classification;
    if (
      classification !== 'explicit_date' &&
      classification !== 'vendor_quote_estimate' &&
      classification !== 'parts_pending' &&
      classification !== 'not_esd_relevant' &&
      classification !== 'quote_sent_reference' &&
      classification !== 'none'
    ) {
      throw new Error(`Malformed tool response: invalid classification "${String(classification)}"`);
    }

    const confidence = obj.confidence;
    if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
      throw new Error(`Malformed tool response: invalid confidence "${String(confidence)}"`);
    }

    const extractedBaseDate = typeof obj.extractedBaseDate === 'string' ? obj.extractedBaseDate : null;

    let suggestedPartsPendingOffsetDays: number | null = null;
    if (typeof obj.suggestedPartsPendingOffsetDays === 'number') {
      const val = obj.suggestedPartsPendingOffsetDays;
      if (val >= PARTS_PENDING_MIN_DAYS && val <= PARTS_PENDING_MAX_DAYS) {
        suggestedPartsPendingOffsetDays = val;
      }
    }

    const reasoningNote = typeof obj.reasoningNote === 'string' ? obj.reasoningNote : '';

    return {
      classification,
      extractedBaseDate,
      suggestedPartsPendingOffsetDays,
      confidence,
      reasoningNote,
    };
  }
}
