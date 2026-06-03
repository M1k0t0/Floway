import { type AzureUpstreamConfig, isFoundryProjectRootPath, trimTrailingSlash } from './config.ts';
import { type EndpointKey, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const AZURE_OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  models: '/models',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
};

// Per-endpoint query suffix appended to the resolved request URL. Image
// endpoints on Azure's /openai/v1 surface currently require
// ?api-version=preview because gpt-image-2 (released 2026-04-21) and the
// gpt-image-1 family are exposed only under the preview lifecycle. We will
// drop this entry once Azure promotes the image endpoints to the GA default.
const AZURE_OPENAI_QUERY: Partial<Record<EndpointKey, string>> = {
  images_generations: 'api-version=preview',
  images_edits: 'api-version=preview',
};

const AZURE_ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
};

const azureOpenAiV1BaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  const path = trimTrailingSlash(url.pathname);
  if (path.endsWith('/openai/v1')) {
    url.pathname = path;
  } else if (path === '/anthropic/v1/messages' || path === '/anthropic/v1' || path === '/anthropic') {
    url.pathname = '/openai/v1';
  } else if (isFoundryProjectRootPath(path)) {
    url.pathname = `${path}/openai/v1`;
  } else {
    url.pathname = '/openai/v1';
  }
  return trimTrailingSlash(url.href);
};

const withAzureFoundryServicesHost = (url: URL): URL => {
  const next = new URL(url.href);
  if (next.hostname.endsWith('.openai.azure.com')) {
    next.hostname = `${next.hostname.slice(0, -'.openai.azure.com'.length)}.services.ai.azure.com`;
  }
  return next;
};

const azureAnthropicBaseUrl = (endpoint: string): string => {
  const url = withAzureFoundryServicesHost(new URL(trimTrailingSlash(endpoint)));
  const path = trimTrailingSlash(url.pathname);
  if (path === '/anthropic/v1/messages') {
    url.pathname = path.slice(0, -'/v1/messages'.length);
  } else if (path === '/anthropic/v1') {
    url.pathname = path.slice(0, -3);
  } else if (path === '/anthropic') {
    url.pathname = path;
  } else {
    url.pathname = '/anthropic';
  }
  return trimTrailingSlash(url.href);
};

const requestUrl = (openAiBaseUrl: string | undefined, anthropicBaseUrl: string | undefined, endpoint: EndpointKey): string => {
  const openAiPath = AZURE_OPENAI_PATHS[endpoint];
  if (openAiPath) {
    if (!openAiBaseUrl) throw new Error('Azure upstream config does not include an OpenAI v1 endpoint');
    const url = joinBaseAndPath(openAiBaseUrl, openAiPath);
    const query = AZURE_OPENAI_QUERY[endpoint];
    if (!query) return url;
    // Append per-endpoint query through URL.searchParams so a future path
    // that itself carries a query suffix does not produce `path?a?b`.
    // AZURE_OPENAI_QUERY stores already-encoded pairs (e.g. `api-version=
    // preview`); parsing-then-appending preserves their encoding.
    const parsed = new URL(url);
    for (const [key, value] of new URLSearchParams(query).entries()) {
      parsed.searchParams.append(key, value);
    }
    return parsed.href;
  }

  const anthropicPath = AZURE_ANTHROPIC_PATHS[endpoint];
  if (anthropicPath) {
    if (!anthropicBaseUrl) throw new Error('Azure upstream config does not include an Anthropic endpoint');
    return joinBaseAndPath(anthropicBaseUrl, anthropicPath);
  }

  throw new Error(`Unsupported Azure upstream endpoint ${endpoint}`);
};

const isAnthropicEndpoint = (endpoint: EndpointKey): boolean => endpoint === 'messages' || endpoint === 'messages_count_tokens';

// Issue an HTTP call against the Azure upstream described by `config`. Applies
// the right credential header per surface (api-key for OpenAI v1, x-api-key +
// anthropic-version for /anthropic), default JSON Content-Type, any extra
// headers, and resolves the URL through the per-surface base/path logic above.
export const azureFetch = async (config: AzureUpstreamConfig, endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> => {
  const openAiBaseUrl = azureOpenAiV1BaseUrl(config.endpoint);
  const anthropicBaseUrl = azureAnthropicBaseUrl(config.endpoint);
  const headers = new Headers(init.headers);
  if (isAnthropicEndpoint(endpoint)) {
    headers.set('x-api-key', config.apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('api-key', config.apiKey);
  }
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) headers.set(key, value);
  }
  return await fetch(requestUrl(openAiBaseUrl, anthropicBaseUrl, endpoint), { ...init, headers });
};
