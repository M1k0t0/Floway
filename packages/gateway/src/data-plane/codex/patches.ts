// Field overrides applied to upstream codex catalog entries before they
// are returned from `/azure-api.codex/codex/models`.
//
// Each entry pairs a target slug with a known better catalog answer AND a
// minimum actual context the floway-side registry must advertise for that
// slug before we apply the override. The codex catalog speaks for the
// OpenAI 1p backend; floway's actual upstream (Copilot, custom, azure)
// may or may not match. Advertising values the upstream cannot honour
// would let codex send oversized requests we have no way to fulfil, so
// we gate every override on a registry confirmation of the slug's real
// limit. Surrounding ModelInfo fields (base_instructions, model_messages,
// truncation_policy, web_search_tool_type, ...) pass through untouched
// so floway tracks upstream codex behavior automatically when it changes
// between releases.

import type { CodexCatalog } from './catalog.ts';

interface ModelOverride {
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  auto_compact_token_limit?: number | null;
}

interface ConditionalOverride {
  override: ModelOverride;
  // Minimum context_window the local registry must advertise for the slug
  // before we replace the codex-bundled fields. Anything less, and the
  // catalog entry passes through unchanged.
  minActualContextWindow: number;
}

// gpt-5.5 and gpt-5.4: advertise the 1M-context tier when floway's own
// registry says the slug actually has at least 1.05M of context. codex's
// bundled catalog pins context_window at 272000 for the v1 OpenAI 1p
// backend that rejected larger windows; flipping every gate exposes the
// full window through floway.
//
//   effective_context_window_percent: codex multiplies context_window by
//     this percent (default 95) when computing `model_context_window` —
//     we set 100 so the advertised window lands exactly at 1.05M.
//   auto_compact_token_limit: codex defaults to 90% of resolved_context_window
//     when omitted, then clamps any explicit value to that ceiling. 945000
//     pins the trigger at exactly 90% rather than letting codex round on
//     its own.
const ONE_M_CONDITIONAL: ConditionalOverride = {
  override: {
    context_window: 1050000,
    max_context_window: 1050000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: 945000,
  },
  minActualContextWindow: 1050000,
};

const CODEX_MODEL_OVERRIDES: Record<string, ConditionalOverride> = {
  'gpt-5.5': ONE_M_CONDITIONAL,
  'gpt-5.4': ONE_M_CONDITIONAL,
};

export type ContextWindowResolver = (slug: string) => number | null;

export const applyCodexOverrides = (catalog: CodexCatalog, actualContextWindowOf: ContextWindowResolver): CodexCatalog => ({
  models: catalog.models.map(model => {
    const entry = CODEX_MODEL_OVERRIDES[model.slug];
    if (entry === undefined) return model;
    const actual = actualContextWindowOf(model.slug);
    if (actual === null || actual < entry.minActualContextWindow) return model;
    return { ...model, ...entry.override };
  }),
});
