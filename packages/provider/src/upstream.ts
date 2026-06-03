// Logical endpoint keys used by the gateway-internal upstream dispatcher.
// Each provider package owns its own path resolution per key; this enum is the
// single shared vocabulary the api uses when asking a provider to issue a call
// at a named endpoint (registry probes, route mounts, etc.).
// `messages_count_tokens` is intentionally a logical key: it is a sub-path of
// `messages` and follows the same provider-owned path policy, so the UI never
// exposes it as a separate configurable endpoint.
export type EndpointKey = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings' | 'images_generations' | 'images_edits' | 'models';

// Subset of EndpointKey whose calls go over SSE.
export type StreamingEndpointKey = 'chat_completions' | 'responses' | 'messages';

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
}
