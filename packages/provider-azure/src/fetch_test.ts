import { test } from 'vitest';

import { azureFetch, assertAzureUpstreamRecord } from './index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_azure',
  provider: 'azure',
  name: 'Azure Resource',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
      },
    ],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
};

test('azureFetch uses Azure OpenAI v1 paths with api-key auth', async () => {
  const { config } = assertAzureUpstreamRecord(baseRecord);
  const seen: Array<{ url: string; apiKey: string | null; contentType: string | null; beta: string | null; body: unknown }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        contentType: request.headers.get('content-type'),
        beta: request.headers.get('anthropic-beta'),
        body: request.method === 'GET' ? null : await request.json(),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'chat_completions', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await azureFetch(config, 'responses', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await azureFetch(config, 'embeddings', { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) });
      await azureFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(
    seen.map(item => item.url),
    [
      'https://example.openai.azure.com/openai/v1/chat/completions',
      'https://example.openai.azure.com/openai/v1/responses',
      'https://example.openai.azure.com/openai/v1/embeddings',
      'https://example.openai.azure.com/openai/v1/models',
    ],
  );
  assertEquals(
    seen.map(item => item.apiKey),
    ['az-key', 'az-key', 'az-key', 'az-key'],
  );
  assertEquals(
    seen.map(item => item.contentType),
    ['application/json', 'application/json', 'application/json', null],
  );
  assertEquals(seen[0].body, { model: 'set-by-provider' });
});

test('azureFetch accepts an endpoint that already includes /openai/v1', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      endpoint: 'https://example.openai.azure.com/openai/v1/',
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'responses', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.openai.azure.com/openai/v1/responses');
});

test('azureFetch accepts Foundry project endpoints for OpenAI v1 calls', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'deepseek-prod',
          endpoints: { responses: {} },
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'responses', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses');
});

test('azureFetch accepts Foundry project OpenAI v1 base URLs', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/openai/v1',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'deepseek-prod',
          endpoints: { responses: {}, messages: {} },
        },
      ],
    },
  });
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'responses', { method: 'POST', body: '{}' });
      await azureFetch(config, 'messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});

test('azureFetch keeps native Anthropic calls on the resource Anthropic base when a project endpoint is entered', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'messages', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/anthropic/v1/messages');
});

test('azureFetch supports Azure Foundry Anthropic Messages with x-api-key auth', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
        },
      ],
    },
  });
  const seen: Array<{ url: string; apiKey: string | null; openAiKey: string | null; version: string | null; beta: string | null }> = [];

  await withMockedFetch(
    request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('x-api-key'),
        openAiKey: request.headers.get('api-key'),
        version: request.headers.get('anthropic-version'),
        beta: request.headers.get('anthropic-beta'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'messages', { method: 'POST', body: '{}' }, { extraHeaders: { 'anthropic-beta': 'context-1m' } });
      await azureFetch(config, 'messages_count_tokens', { method: 'POST', body: '{}' });
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: null,
    },
  ]);
});

test('azureFetch accepts an Azure Foundry Anthropic messages target URI', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
        },
      ],
    },
  });
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetch(config, 'messages', { method: 'POST', body: '{}' });
      await azureFetch(config, 'models', { method: 'GET' });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/anthropic/v1/messages',
    'https://example.services.ai.azure.com/openai/v1/models',
  ]);
});
