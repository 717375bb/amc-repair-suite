import type { EsdInferenceInput, EsdInferenceProvider, EsdInferenceResult } from './types.js';

/**
 * Used by `--dry-run`. Makes no API calls — every order that would otherwise
 * reach Step 2 comes back classified 'none' with a note explaining why, so
 * the rest of the pipeline (parsing, matching, Step 1, DB, Excel export) can
 * still be exercised end-to-end without an ANTHROPIC_API_KEY.
 */
export class DryRunEsdProvider implements EsdInferenceProvider {
  async infer(_input: EsdInferenceInput): Promise<EsdInferenceResult> {
    return {
      classification: 'none',
      extractedBaseDate: null,
      suggestedPartsPendingOffsetDays: null,
      confidence: 'low',
      reasoningNote: 'Dry run: AI inference skipped (--dry-run flag, no API call made).',
    };
  }
}
