import { describe, expect, test } from 'vitest';

import {
  aliasFromApiId,
  buildClaudeCodeCatalog,
  claudeCodeResolveRequestedModelId,
  type ClaudeCodeApiModel,
} from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { ClaudeCodeProviderData } from './types.ts';

const SAMPLE_API_MODELS: ClaudeCodeApiModel[] = [
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000 },
];

describe('aliasFromApiId', () => {
  test('strips an 8-digit date suffix when present', () => {
    expect(aliasFromApiId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(aliasFromApiId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(aliasFromApiId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
  });

  test('passes alias-shape ids through unchanged', () => {
    expect(aliasFromApiId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(aliasFromApiId('claude-fable-5')).toBe('claude-fable-5');
    expect(aliasFromApiId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('buildClaudeCodeCatalog', () => {
  const models = buildClaudeCodeCatalog(SAMPLE_API_MODELS, new Set<string>());

  test('publishes each model under its public alias (date-stripped where applicable)', () => {
    expect(models.map(m => m.id)).toEqual([
      'claude-fable-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  test('preserves the original upstream id under providerData.upstreamModelId', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect((byAlias.get('claude-sonnet-4-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-sonnet-4-5-20250929');
    expect((byAlias.get('claude-opus-4-7')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-opus-4-7');
    expect((byAlias.get('claude-fable-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-fable-5');
  });

  test('every model advertises only the messages endpoint and chat kind', () => {
    for (const m of models) {
      expect(m.endpoints).toEqual({ messages: {} });
      expect(m.kind).toBe('chat');
      expect(m.owned_by).toBe('anthropic');
    }
  });

  test('carries display_name and context window from the api response', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect(byAlias.get('claude-fable-5')!.display_name).toBe('Claude Fable 5');
    expect(byAlias.get('claude-fable-5')!.limits.max_context_window_tokens).toBe(1_000_000);
    expect(byAlias.get('claude-haiku-4-5')!.limits.max_context_window_tokens).toBe(200_000);
  });

  test('wires pricing through pricingForClaudeCodeModelKey keyed by the upstream id', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect(byAlias.get('claude-opus-4-7')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-opus-4-7'));
    expect(byAlias.get('claude-sonnet-4-5')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'));
    expect(byAlias.get('claude-fable-5')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-fable-5'));
  });

  test('forwards the supplied enabledFlags set onto every model', () => {
    const flags = new Set(['custom-flag-a', 'custom-flag-b']);
    const built = buildClaudeCodeCatalog(SAMPLE_API_MODELS, flags);
    for (const m of built) {
      expect(m.enabledFlags).toBe(flags);
    }
  });
});

describe('claudeCodeResolveRequestedModelId', () => {
  test('resolves a dated id to its public alias', () => {
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(claudeCodeResolveRequestedModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
  });

  test('returns undefined when the id is already in alias shape', () => {
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-5')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-7')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-fable-5')).toBeUndefined();
  });

  test('returns undefined for ids outside the claude- namespace', () => {
    expect(claudeCodeResolveRequestedModelId('gpt-4')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('gemini-2.5-pro')).toBeUndefined();
  });

  test('returns undefined for malformed dated ids (not exactly 8 digits)', () => {
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-foo')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-2025')).toBeUndefined();
  });
});
