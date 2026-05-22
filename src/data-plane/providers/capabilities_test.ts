import { test } from 'vitest';

import { getModelCapabilities } from './capabilities.ts';
import type { UpstreamModel } from './types.ts';
import { assertEquals } from '../../test-assert.ts';

const upstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  name: 'Test',
  version: '1',
  object: 'model',
  supportedEndpoints: [],
  capabilities: {
    family: 'test',
    type: 'chat',
    limits: {},
    supports: {},
  },
  ...overrides,
});

test('getModelCapabilities forwards supportedEndpoints and projects maxOutputTokens', () => {
  const caps = getModelCapabilities(
    upstreamModel({
      supportedEndpoints: ['messages', 'chat_completions'],
      capabilities: {
        family: 'test',
        type: 'chat',
        limits: { max_output_tokens: 64_000 },
        supports: {},
      },
    }),
  );

  assertEquals(caps.supportedEndpoints, ['messages', 'chat_completions']);
  assertEquals(caps.maxOutputTokens, 64_000);
});

test('getModelCapabilities leaves maxOutputTokens undefined when not declared', () => {
  const caps = getModelCapabilities(upstreamModel());

  assertEquals(caps.maxOutputTokens, undefined);
});
