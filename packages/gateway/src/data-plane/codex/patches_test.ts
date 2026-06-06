import { describe, expect, it } from 'vitest';

import type { CodexCatalog } from './catalog.ts';
import { applyCodexOverrides } from './patches.ts';

describe('applyCodexOverrides', () => {
  const ONE_M = {
    context_window: 1050000,
    max_context_window: 1050000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: 945000,
  };

  const buildCatalog = (): CodexCatalog => ({
    models: [
      { slug: 'gpt-5.5', context_window: 272000, base_instructions: 'unchanged' },
      { slug: 'gpt-5.4', context_window: 272000, base_instructions: 'unchanged-too' },
      { slug: 'gpt-5.3-codex', context_window: 272000 },
    ],
  });

  it('overrides slugs whose registry context window meets the minimum, leaves others untouched', () => {
    const out = applyCodexOverrides(buildCatalog(), () => 1050000);
    expect(out.models.find(m => m.slug === 'gpt-5.5')).toMatchObject({ slug: 'gpt-5.5', ...ONE_M, base_instructions: 'unchanged' });
    expect(out.models.find(m => m.slug === 'gpt-5.4')).toMatchObject({ slug: 'gpt-5.4', ...ONE_M, base_instructions: 'unchanged-too' });
    expect(out.models.find(m => m.slug === 'gpt-5.3-codex')).toEqual({ slug: 'gpt-5.3-codex', context_window: 272000 });
  });

  it('skips the override when the registry advertises less than the target window', () => {
    const out = applyCodexOverrides(buildCatalog(), () => 272000);
    expect(out.models.find(m => m.slug === 'gpt-5.5')).toEqual({ slug: 'gpt-5.5', context_window: 272000, base_instructions: 'unchanged' });
    expect(out.models.find(m => m.slug === 'gpt-5.4')).toEqual({ slug: 'gpt-5.4', context_window: 272000, base_instructions: 'unchanged-too' });
  });

  it('skips the override when the registry has no record of the slug', () => {
    const out = applyCodexOverrides(buildCatalog(), () => null);
    expect(out.models).toEqual(buildCatalog().models);
  });

  it('returns input shape unchanged when no slug matches an override', () => {
    const input: CodexCatalog = { models: [{ slug: 'gpt-5.4-mini', context_window: 272000 }] };
    expect(applyCodexOverrides(input, () => 1050000)).toEqual(input);
  });

  it('does not mutate the input catalog', () => {
    const input: CodexCatalog = { models: [{ slug: 'gpt-5.5', context_window: 272000 }] };
    const snapshot = JSON.parse(JSON.stringify(input)) as CodexCatalog;
    applyCodexOverrides(input, () => 1050000);
    expect(input).toEqual(snapshot);
  });
});
