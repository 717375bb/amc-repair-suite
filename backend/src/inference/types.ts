export interface EsdInferenceInput {
  orderNumber: string;
  vendorName: string | null;
  currentStatus: string | null;
  vendorNotes: string | null;
}

export interface EsdInferenceResult {
  classification:
    | 'explicit_date'
    | 'vendor_quote_estimate'
    | 'parts_pending'
    | 'not_esd_relevant'
    | 'quote_sent_reference'
    | 'none';
  /** ISO date the AI found in the text, null if classification is 'none'. */
  extractedBaseDate: string | null;
  /** Only meaningful when classification is 'parts_pending'; must be 20-30 or null. */
  suggestedPartsPendingOffsetDays: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** 1-2 sentence internal note for audit/debugging, not customer-facing. */
  reasoningNote: string;
}

export interface EsdInferenceProvider {
  infer(input: EsdInferenceInput): Promise<EsdInferenceResult>;
}
