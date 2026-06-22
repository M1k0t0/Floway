// The Claude Code OAuth bearer accepts the standard Anthropic /v1/models
// endpoint. We refresh the catalog from there on every dispatcher poll so
// the gateway surfaces exactly the models Anthropic exposes to the
// subscription's tier — sonnet / opus 4.5, opus 4.6+, fable-5, etc. —
// without a per-release code bump.
//
// Two id shapes coexist on the wire today. Pre-4.6 models (4.5 / 4.1)
// return with a `-YYYYMMDD` date suffix; their public alias is the
// de-dated form (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`).
// 4.6+ and `claude-fable-5` return with the alias already (no date),
// so the alias derivation is the identity. The catalog id we publish is
// always the alias; the original /v1/models id rides on
// `providerData.upstreamModelId` so the wire fetch in `fetch.ts` and the
// pricing table key by the per-revision id.

import { CLAUDE_CODE_HEADERS_SONNET_OPUS } from './headers.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { ClaudeCodeProviderData } from './types.ts';
import type { Fetcher, UpstreamModel } from '@floway-dev/provider';

const ANTHROPIC_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models?limit=100';

// `/v1/models` returns more fields than we consume; the parser keeps the
// ones the catalog needs and ignores the rest so a benign upstream
// addition does not fail the refresh. Unknown shapes still throw because
// dropping a required field is the kind of contract change we want to
// notice loudly.
export interface ClaudeCodeApiModel {
  id: string;
  display_name: string;
  max_input_tokens: number;
}

export const fetchClaudeCodeModelsList = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeApiModel[]> => {
  const headers: Record<string, string> = {
    ...CLAUDE_CODE_HEADERS_SONNET_OPUS,
    authorization: `Bearer ${accessToken}`,
  };
  const response = await fetcher(ANTHROPIC_MODELS_ENDPOINT, { method: 'GET', headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude Code /v1/models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error('Claude Code /v1/models response missing data array');
  return parsed.data.map(assertApiModel);
};

const assertApiModel = (value: unknown): ClaudeCodeApiModel => {
  if (typeof value !== 'object' || value === null) throw new TypeError('Claude Code /v1/models entry is not an object');
  const { id, display_name, max_input_tokens } = value as Record<string, unknown>;
  if (typeof id !== 'string') throw new TypeError(`Claude Code /v1/models entry missing id: ${JSON.stringify(value).slice(0, 200)}`);
  if (typeof display_name !== 'string') throw new TypeError(`Claude Code /v1/models entry ${id} missing display_name`);
  if (typeof max_input_tokens !== 'number') throw new TypeError(`Claude Code /v1/models entry ${id} missing max_input_tokens`);
  return { id, display_name, max_input_tokens };
};

// Pre-4.6 models return as `claude-<family>-<digits>-<digits>-YYYYMMDD`;
// the public alias is the de-dated form. Newer ids (`claude-opus-4-7`,
// `claude-fable-5`) have no date suffix and pass through unchanged. The
// pattern is intentionally generic over the family slug — anchoring to
// `claude-(haiku|opus|sonnet)` would silently drop a future family the
// upstream exposes before we hard-code its name.
export const aliasFromApiId = (apiId: string): string => apiId.replace(/-\d{8}$/, '');

export const buildClaudeCodeCatalog = (
  apiModels: readonly ClaudeCodeApiModel[],
  enabledFlags: ReadonlySet<string>,
): UpstreamModel[] => apiModels.map(api => {
  const alias = aliasFromApiId(api.id);
  const cost = pricingForClaudeCodeModelKey(api.id);
  const providerData: ClaudeCodeProviderData = { upstreamModelId: api.id };
  return {
    id: alias,
    display_name: api.display_name,
    owned_by: 'anthropic',
    kind: 'chat',
    endpoints: { messages: {} },
    enabledFlags,
    limits: { max_context_window_tokens: api.max_input_tokens },
    providerData,
    ...(cost ? { cost } : {}),
  };
});

// Hook for `ModelProviderInstance.resolveRequestedModelId`: a client that
// addresses a model by its dated upstream id resolves to the catalog alias
// the dispatcher actually carries. The catalog publishes only aliases, so
// any id that already lacks a date suffix needs no remap. We don't validate
// against the live catalog here — the dispatcher's own model-id lookup is
// what fails a request that names a model the upstream doesn't expose.
export const claudeCodeResolveRequestedModelId = (modelId: string): string | undefined => {
  const alias = aliasFromApiId(modelId);
  return alias === modelId ? undefined : alias;
};
