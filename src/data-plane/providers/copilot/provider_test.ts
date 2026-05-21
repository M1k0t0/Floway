import { test } from 'vitest';

import { createCopilotProvider } from './provider.ts';
import { assertEquals } from '../../../test-assert.ts';
import { copilotModels, jsonResponse, setupAppTest, withMockedFetch } from '../../../test-helpers.ts';
import { messagesCopilotSourceInterceptors } from './interceptors/messages/index.ts';

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const provider = instance.provider;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'gpt-dual',
              supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();

      assertEquals(
        models.map(model => model.id),
        ['gpt-dual'],
      );
      assertEquals(models[0].supportedEndpoints, ['responses']);
    },
  );
});

test('Copilot provider exposes only Responses for Claude when available', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const provider = instance.provider;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              display_name: 'Claude Opus 4.7',
              supported_endpoints: ['/responses', '/chat/completions'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-opus-4-7');
      assertEquals(model.name, 'Claude Opus 4.7');
      assertEquals(model.display_name, 'Claude Opus 4.7');
      assertEquals(model.supportedEndpoints, ['responses']);
    },
  );
});

test('Copilot provider owns the claude-* Messages capability workaround', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const provider = instance.provider;
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-haiku-chat-listed',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          id: 'msg_claude_workaround',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-haiku-chat-listed',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-haiku-chat-listed');
      assertEquals(model.supportedEndpoints, ['messages', 'messages_count_tokens']);

      await provider.callMessages(model, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const provider = instance.provider;
  let responsesBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['medium'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        responsesBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          id: 'resp_endpoint_variant',
          object: 'response',
          model: 'claude-opus-4.7',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      await provider.callResponses(model, {
        input: [],
        reasoning: { effort: 'xhigh' },
      });
    },
  );

  assertEquals(responsesBody?.model, 'claude-opus-4.7');
});

test('Copilot provider owns default response retry fix', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);

  assertEquals(instance.enabledFixes.has('retry-cyber-policy'), true);
});

test('Copilot provider enables Copilot-owned Messages source interceptors by default', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);

  assertEquals(instance.sourceInterceptors?.messages, messagesCopilotSourceInterceptors);
});

test('Copilot provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-resp', supported_endpoints: ['/responses'] },
            { id: 'claude-msg', supported_endpoints: ['/v1/messages'] },
            { id: 'emb-mini', supported_endpoints: ['/embeddings'] },
          ]),
        );
      }

      const path = url.pathname;
      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/chat/completions') {
        return jsonResponse({ id: 'cc', object: 'chat.completion', model: 'gpt-chat', choices: [], usage: {} });
      }
      if (path === '/responses') {
        return jsonResponse({ id: 'r', object: 'response', model: 'gpt-resp', output: [], usage: {} });
      }
      if (path === '/v1/messages') {
        return jsonResponse({ id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-msg', stop_reason: 'end_turn', stop_sequence: null, usage: {} });
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'emb-mini' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();
      const byId = new Map(models.map(model => [model.id, model]));

      await provider.callChatCompletions(byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(byId.get('gpt-resp')!, { input: [] });
      await provider.callMessages(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(byId.get('emb-mini')!, { input: 'hi' });
    },
  );

  assertEquals(bodies['/chat/completions'].stream, true);
  assertEquals(bodies['/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/embeddings'], false);
});
