import { test } from 'vitest';

import { customFetch, assertCustomUpstreamRecord } from './index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  provider: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    endpoints: { chatCompletions: {} },
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
};

test('customFetch uses default /v1/* paths', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);

  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'chat_completions', { method: 'POST', body: '{}' });
      await customFetch(config, 'responses', { method: 'POST', body: '{}' });
      await customFetch(config, 'messages', { method: 'POST', body: '{}' });
      await customFetch(config, 'messages_count_tokens', { method: 'POST', body: '{}' });
      await customFetch(config, 'embeddings', { method: 'POST', body: '{}' });
      await customFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/v1/chat/completions',
    'https://custom.example.com/v1/responses',
    'https://custom.example.com/v1/messages',
    'https://custom.example.com/v1/messages/count_tokens',
    'https://custom.example.com/v1/embeddings',
    'https://custom.example.com/v1/models',
  ]);
});

test('customFetch applies path overrides without an automatic /v1 prefix', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      pathOverrides: {
        messages: '/api/v1/messages',
      },
    },
  });
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'messages', { method: 'POST', body: '{}' });
      await customFetch(config, 'messages_count_tokens', { method: 'POST', body: '{}' });
      await customFetch(config, 'chat_completions', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/api/v1/messages',
    // count_tokens follows the messages override path.
    'https://custom.example.com/api/v1/messages/count_tokens',
    // Endpoints without an override fall back to the OpenAI default.
    'https://custom.example.com/v1/chat/completions',
  ]);
});

test('customFetch resolves the /models path from modelsFetch.endpoint', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: '/models' },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(seen, 'https://custom.example.com/models');
});

test('customFetch falls back to the default /models path when modelsFetch.endpoint is absent', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(seen, 'https://custom.example.com/v1/models');
});

test('customFetch sends the configured bearer token', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  let authHeader: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
});

test('customFetch defaults authStyle to bearer when omitted', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
  assertEquals(xApiKey, null);
});

test('customFetch with authStyle "anthropic" sends x-api-key + anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(config, 'messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, 'sk-test');
  assertEquals(anthropicVersion, '2023-06-01');
});

test('customFetch with authStyle "anthropic" preserves a caller-supplied anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetch(
        config,
        'messages',
        { method: 'POST', body: '{}', headers: { 'anthropic-version': '2024-01-01' } },
      );
    },
  );

  assertEquals(anthropicVersion, '2024-01-01');
});
