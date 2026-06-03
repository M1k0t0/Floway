import type { CustomUpstreamConfig } from './config.ts';
import { type EndpointKey, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const ANTHROPIC_VERSION = '2023-06-01';

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

const CUSTOM_DEFAULT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/v1/embeddings',
  images_generations: '/v1/images/generations',
  images_edits: '/v1/images/edits',
  models: '/v1/models',
};

const resolveCustomPath = (config: CustomUpstreamConfig, endpoint: EndpointKey): string => {
  // count_tokens is intentionally not independently overridable — it tracks
  // whatever path the admin chose for `messages` so the two stay in sync.
  if (endpoint === 'messages_count_tokens') {
    const messagesPath = config.pathOverrides?.messages ?? CUSTOM_DEFAULT_PATHS.messages;
    return `${messagesPath}/count_tokens`;
  }
  // The /models path lives on the fetch toggle, not in pathOverrides.
  if (endpoint === 'models') {
    return config.modelsFetch.endpoint ?? CUSTOM_DEFAULT_PATHS.models;
  }
  return config.pathOverrides?.[endpoint] ?? CUSTOM_DEFAULT_PATHS[endpoint];
};

// Issue an HTTP call against the custom upstream described by `config`. Applies
// the configured auth header, default Content-Type for JSON bodies, and any
// extra headers, then dispatches to the resolved per-endpoint URL.
export const customFetch = async (config: CustomUpstreamConfig, endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.authStyle === 'anthropic') {
    headers.set('x-api-key', config.bearerToken);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
  } else {
    headers.set('Authorization', `Bearer ${config.bearerToken}`);
  }
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) headers.set(k, v);
  }
  const url = joinBaseAndPath(trimTrailingSlash(config.baseUrl), resolveCustomPath(config, endpoint));
  return await fetch(url, { ...init, headers });
};
