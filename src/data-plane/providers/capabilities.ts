import type { ModelEndpoint, UpstreamModel } from './types.ts';

export interface ModelCapabilities {
  maxOutputTokens?: number;
  supportedEndpoints: readonly ModelEndpoint[];
}

export const getModelCapabilities = (model: UpstreamModel): ModelCapabilities => ({
  maxOutputTokens: model?.capabilities?.limits?.max_output_tokens,
  supportedEndpoints: model.supportedEndpoints,
});
