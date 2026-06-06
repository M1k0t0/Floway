// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Catalog source: dynamic by codex client version (see catalog.ts) with a
// bundled snapshot as fallback. Per-slug overrides live in patches.ts and
// are gated on what floway's own registry actually advertises for the
// slug, so a deployment whose upstream does not honour the override's
// target window keeps the codex-bundled defaults.

import type { Context } from 'hono';

import { resolveCodexCatalog } from './catalog.ts';
import { applyCodexOverrides, type ContextWindowResolver } from './patches.ts';
import { apiKeyUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getInternalModels } from '../providers/registry.ts';

export const codexModels = async (c: Context): Promise<Response> => {
  const [catalog, internalModels] = await Promise.all([
    resolveCodexCatalog(c.req.header('user-agent')),
    getInternalModels(apiKeyUpstreamIdsFromContext(c)),
  ]);
  const actualContextWindowOf: ContextWindowResolver = slug =>
    internalModels.find(m => m.id === slug)?.limits.max_context_window_tokens ?? null;
  return Response.json(applyCodexOverrides(catalog, actualContextWindowOf));
};
