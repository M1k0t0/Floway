import type { CacheRepo, ModelProvider, TelemetryModelIdentity, UpstreamModel } from '@floway-dev/provider';

export const memoryCacheRepo = (): CacheRepo => {
  const store = new Map<string, string>();
  return {
    get: key => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: key => {
      store.delete(key);
      return Promise.resolve();
    },
    deletePrefix: prefix => {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      return Promise.resolve();
    },
  };
};

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  getPricingForModelKey: () => null,
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callResponsesCompact: () => Promise.reject(new Error('stubProvider.callResponsesCompact was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  callImagesGenerations: () => Promise.reject(new Error('stubProvider.callImagesGenerations was called')),
  callImagesEdits: () => Promise.reject(new Error('stubProvider.callImagesEdits was called')),
  ...overrides,
});
