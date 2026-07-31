import type { EsdInferenceInput, EsdInferenceProvider, EsdInferenceResult } from './types.js';

export class AzureOpenAiEsdProvider implements EsdInferenceProvider {
  // TODO: implement once Azure OpenAI access is confirmed
  async infer(_input: EsdInferenceInput): Promise<EsdInferenceResult> {
    throw new Error('Not implemented');
  }
}
