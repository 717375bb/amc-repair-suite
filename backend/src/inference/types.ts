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
  /**
   * Set ONLY when the provider itself could not answer — a network failure,
   * a rejected credential, or a malformed response after retry.
   *
   * REAL BUG THIS EXISTS TO FIX (2026-08-28): the provider degraded to
   * classification 'none' on failure, which is indistinguishable from the
   * model genuinely finding no date in the text. Run 31 had 241 orders fail
   * with a TLS certificate error from corporate SSL inspection, and every
   * one was presented to the analyst as "No ESD Found" — a claim about the
   * vendor's notes, when nothing had been read at all.
   */
  providerError?: string | null;
}

export interface EsdInferenceProvider {
  infer(input: EsdInferenceInput): Promise<EsdInferenceResult>;
}
