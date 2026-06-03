import { assertAzureUpstreamRecord } from './config.ts';
import { azureFetch } from './fetch.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { type ModelProvider, type ModelProviderInstance, type ProviderCallResult, type ProviderStreamParser, type StreamingEndpointKey, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord, defaultsForProvider, mergeAnthropicBetaHeader, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

interface AzureProviderData {
  upstreamModelId: string;
}

const providerData = (model: UpstreamModel): AzureProviderData => model.providerData as AzureProviderData;

// Project an Azure model config row into the slim provider-neutral fields.
// kind/endpoints/providerData/enabledFlags are added by the caller.
const azureInternalModel = (model: UpstreamModelConfig): Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: publicModelId(model),
    limits: { ...(model.limits ?? {}) },
  };
  if (model.display_name !== undefined) internal.display_name = model.display_name;
  if (model.cost) internal.cost = model.cost;
  return internal;
};

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);

  const call = (endpoint: 'messages_count_tokens' | 'embeddings' | 'images_generations', model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult> => {
    const upstreamModelId = providerData(model).upstreamModelId;
    return azureFetch(azure.config, endpoint, { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal }, { extraHeaders: headers })
      .then(response => ({
        response,
        modelKey: upstreamModelId,
      }));
  };

  const callStreaming = <TEvent>(
    endpoint: StreamingEndpointKey,
    model: UpstreamModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Record<string, string> | undefined,
    parser: ProviderStreamParser<TEvent>,
  ) => {
    const upstreamModelId = providerData(model).upstreamModelId;
    return streamingProviderCall(
      azureFetch(
        azure.config,
        endpoint,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const provider: ModelProvider = {
    async getProvidedModels() {
      return azure.config.models.map(model => {
        // The model's flag overrides are gated by a dashboard toggle: `enabled: false`
        // skips the model layer entirely (the upstream layer wins), `enabled: true`
        // applies `values` as a final layer that can re-enable or remove flags seeded by
        // defaults or the upstream. See `resolveEffectiveFlags` for layer semantics.
        const modelLayer = model.flagOverrides?.enabled ? model.flagOverrides.values : undefined;
        const effective = resolveEffectiveFlags(defaultsForProvider('azure'), [azure.flagOverrides, modelLayer]);
        const endpoints = model.endpoints;
        return {
          ...azureInternalModel(model),
          kind: kindForEndpoints(endpoints),
          endpoints,
          providerData: {
            upstreamModelId: model.upstreamModelId,
          } satisfies AzureProviderData,
          enabledFlags: effective,
        };
      });
    },
    getPricingForModelKey(modelKey) {
      return azure.config.models.find(model => model.upstreamModelId === modelKey)?.cost ?? null;
    },
    callChatCompletions: (model, body, signal, headers) => callStreaming('chat_completions', model, body, signal, headers, parseChatCompletionsStream),
    callResponses: (model, body, signal, headers) => callStreaming('responses', model, body, signal, headers, parseResponsesStream),
    callMessages: (model, body, signal, headers, anthropicBeta) => callStreaming('messages', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta), parseMessagesStream),
    callMessagesCountTokens: (model, body, signal, headers, anthropicBeta) => call('messages_count_tokens', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => call('images_generations', model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Azure routes by upstream model id in the multipart `model` field; the
      // runtime re-encodes the FormData with a fresh boundary and sets
      // Content-Type itself.
      const upstreamModelId = providerData(model).upstreamModelId;
      body.append('model', upstreamModelId);
      const response = await azureFetch(azure.config, 'images_edits', { method: 'POST', body, signal }, { extraHeaders: headers });
      return { response, modelKey: upstreamModelId };
    },
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    disabledPublicModelIds: azure.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: true,
  };
};
