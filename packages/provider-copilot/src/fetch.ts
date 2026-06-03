// Copilot upstream transport. The auth.ts layer owns the GitHub-token → short
// lived Copilot-token exchange and KV cache; this module maps a logical
// endpoint to the path Copilot serves it on, then dispatches through that
// authed fetch.

import { copilotAuthedFetch, isCopilotTokenFetchError } from './auth.ts';
import type { CopilotUpstreamConfig } from './config.ts';
import type { EndpointKey, UpstreamFetchOptions } from '@floway-dev/provider';

// Copilot mounts its API at the host root and uses an Anthropic-style
// `/v1/messages` for the Messages endpoint while keeping `/chat/completions`,
// `/responses`, `/embeddings`, `/images/*`, and `/models` un-prefixed. These
// paths are not admin-configurable: they reflect Copilot's own contract, not
// a deployment choice.
const COPILOT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
  models: '/models',
};

// Subset of the persisted copilot upstream record's config the transport needs;
// `user` is irrelevant to the wire, so the parameter type names only the auth
// fields. Any CopilotUpstreamConfig satisfies it structurally.
type CopilotFetchConfig = Pick<CopilotUpstreamConfig, 'githubToken' | 'accountType'>;

// Issue an HTTP call against Copilot's upstream for a named endpoint. Wraps
// `copilotAuthedFetch` (which owns the token exchange + KV cache) with the
// endpoint→path mapping above and converts a CopilotTokenFetchError into a
// regular Response so callers can treat token-exchange failures the same as
// any other 4xx/5xx.
export const copilotFetch = async (config: CopilotFetchConfig, endpoint: EndpointKey, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> => {
  try {
    return await copilotAuthedFetch(COPILOT_PATHS[endpoint], init, config.githubToken, config.accountType, options?.extraHeaders ? { headers: options.extraHeaders } : undefined);
  } catch (error) {
    if (!isCopilotTokenFetchError(error)) throw error;
    return new Response(error.body, {
      status: error.status,
      headers: new Headers(error.headers),
    });
  }
};
