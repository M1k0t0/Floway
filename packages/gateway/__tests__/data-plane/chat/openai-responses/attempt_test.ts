import { test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { hydrateOpenAIResponsesPayload } from '../../../../src/data-plane/chat/openai-responses/items/hydrate.ts';
import * as outputModule from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { StoredOpenAIResponsesItem } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { acceptedAffinityEvaluation } from '../shared/affinity/helpers.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderModel, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions, type FlagId } from '@floway-dev/provider';
import { CODEX_RESPONSES_LITE_HEADER, CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY as CODEX_RESPONSES_LITE_MARKER } from '@floway-dev/provider-codex';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, ...(store ? { store } : {}) });

const makePayload = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

type CodexResponsesLitePayload = CanonicalOpenAIResponsesPayload & {
  client_metadata: Record<string, unknown>;
};

const codexTools: OpenAIResponsesTool[] = [
  {
    type: 'namespace',
    name: 'workspace',
    description: 'Workspace tools.',
    tools: [{
      type: 'custom',
      name: 'patch',
      description: 'Apply a patch.',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' },
    }],
  },
  {
    type: 'namespace',
    name: 'functions',
    description: '',
    tools: [{
      type: 'function',
      name: 'lookup',
      description: 'Look up a value.',
      parameters: { type: 'object', properties: { key: { type: 'string' } } },
      strict: false,
    }],
  },
  {
    type: 'function',
    name: 'ping',
    parameters: { type: 'object', properties: {} },
    strict: false,
  },
];

const makeCodexResponsesLitePayload = (
  overrides: Partial<CodexResponsesLitePayload> = {},
): CodexResponsesLitePayload => ({
  model: 'public-codex-alias',
  input: [
    { type: 'additional_tools', id: 'at_client', role: 'developer', tools: [] },
    // This is deliberately untagged. Only Codex's exact tagged carrier is
    // promoted to `instructions`; ordinary developer context stays in input.
    { type: 'message', id: 'msg_developer', role: 'developer', content: [{ type: 'input_text', text: 'Use concise answers.' }] },
    { type: 'message', id: 'msg_user', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
  ],
  client_metadata: {
    [CODEX_RESPONSES_LITE_MARKER]: 'true',
    request_trace: 'retain-me',
  },
  tool_choice: 'auto',
  reasoning: { effort: 'low', context: 'all_turns' },
  parallel_tool_calls: false,
  stream: true,
  store: false,
  text: {
    format: {
      type: 'json_schema',
      name: 'short_reply',
      schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] },
    },
  },
  ...overrides,
});

const makeOpenAIResponsesResult = (id = 'resp_test'): OpenAIResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProviderEvents = async function* (events: readonly OpenAIResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeProtocolFrames = async function* <E>(events: readonly E[]): AsyncGenerator<ProtocolFrame<E>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (
  callOpenAIResponses: (model: ProviderModel, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>,
  enabledFlags: ReadonlySet<FlagId> = new Set<FlagId>(),
): ModelCandidate => {
  const provider = stubProvider({ callOpenAIResponses });
  const upstream = 'up_test';
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: provider,
    },
    model: stubInternalModel({
      providerModels: { [upstream]: stubProviderModel({ enabledFlags }) },
    }, upstream),
    fetcher: directFetcher,
  };
};

const makeNativeLiteCandidate = (
  callOpenAIResponses: (model: ProviderModel, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>,
  supportsOpenAIResponsesLite: (model: ProviderModel) => boolean,
): ModelCandidate => {
  const upstream = 'up_native_lite';
  const providerModel = stubProviderModel({ id: 'gpt-real-provider-model', endpoints: { openaiResponses: {} } });
  const provider = stubProvider({ callOpenAIResponses });
  provider.supportsOpenAIResponsesLite = supportsOpenAIResponsesLite;
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: provider,
    },
    model: stubInternalModel({
      id: 'gpt-resolved-target',
      endpoints: { openaiResponses: {} },
      providerModels: { [upstream]: providerModel },
    }, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): Promise<OpenAIResponsesStreamEvent[]> => {
  const out: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

const installRepo = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: API_KEY_ID, userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

const insertStoredItem = async (repo: InMemoryRepo, overrides: Partial<StoredOpenAIResponsesItem> & Pick<StoredOpenAIResponsesItem, 'id'> & { type: string }): Promise<StoredOpenAIResponsesItem> => {
  const { type, ...itemOverrides } = overrides;
  const row: StoredOpenAIResponsesItem = {
    apiKeyId: API_KEY_ID,
    itemHash: `hash-${overrides.id}`,
    payload: { item: { type, id: overrides.id } },
    refreshedAt: Date.now(),
    ...itemOverrides,
  };
  await repo.openaiResponsesItems.insertMany([row], 0);
  return row;
};

test('generate native success leaves source-edge state ownership to the caller', async () => {
  installRepo();

  const completedEvent: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult(),
  };
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));

  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');

  const events = await collectEvents(result.events);
  assert(events.length >= 1, 'expected at least the response.completed event');

  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('generate isolates provider mutations with JSON-safe container cloning', async () => {
  installRepo();
  const metadata = JSON.parse('{"__proto__":{"retained":true},"nested":{"value":"source"}}') as Record<string, unknown>;
  const payload = makePayload({ metadata });
  const sourceItem = payload.input[0];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    const clonedMetadata = body.metadata as { nested: { value: string } } & Record<string, unknown>;
    assert(Object.hasOwn(clonedMetadata, '__proto__'), 'clone lost the own __proto__ JSON field');
    clonedMetadata.nested.value = 'provider';
    (body.input[0] as { role: string }).role = 'assistant';
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([]),
      modelKey: 'test-model-key',
    };
  });

  await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers(),
  });

  assertEquals((payload.metadata as { nested: { value: string } }).nested.value, 'source');
  assertEquals((sourceItem as { role: string }).role, 'user');
});

test('generate treats a translated OpenAI Responses payload as opaque to native affinity and state', async () => {
  installRepo();
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'openai-responses.reasoning.encrypted_content',
  );
  const unwrap = vi.spyOn(ctx.affinity.codec, 'unwrap');
  const getStoredItem = vi.spyOn(store, 'getItemById');
  const itemId = 'rs_source_edge';

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }],
    }),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(unwrap.mock.calls.length, 0);
  assertEquals(getStoredItem.mock.calls.length, 0);
  assertEquals(observedBody?.input, [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }]);
});

test('generate applies role compatibility flags in target-chain order', async () => {
  installRepo();
  let observedBody: Omit<OpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<OpenAIResponsesPayload, 'model'>,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callOpenAIResponses, new Set([
    'rewrite-developer-to-system',
    'rewrite-mid-conv-system-to-user',
    'rewrite-system-to-developer',
  ]));

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.input, [
    { type: 'message', role: 'system', content: 'base instructions' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user', content: 'inline instructions' },
  ]);
});

test('generate defers the role rewrite until after translation to OpenAI Chat Completions', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (
    _model: ProviderModel,
    body: Omit<OpenAIChatCompletionsPayload, 'model'>,
  ): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedBody = body;
    return {
      ok: true,
      events: (async function* () {
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        yield doneFrame();
      })(),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const upstream = 'up_chat';
  const endpoints = { openaiChatCompletions: {} };
  const candidate: ModelCandidate = {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: stubProvider({ callOpenAIChatCompletions }),
    },
    model: stubInternalModel({
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({
          endpoints,
          enabledFlags: new Set(['rewrite-system-to-developer']),
        }),
      },
    }, upstream),
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.messages, [
    { role: 'developer', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'inline instructions' },
  ]);
});

test('generate passes non-events provider result through unchanged', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapOpenAIResponsesClientOutput');

  const upstreamResponse = new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 502, headers: new Headers({ 'content-type': 'application/json' }) });
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: false,
    response: upstreamResponse,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callOpenAIResponses);
  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 502);
  // Wrap must not run when the upstream failed before any events flowed.
  assertEquals(wrapSpy.mock.calls.length, 0);
  wrapSpy.mockRestore();
});

test('compact returns the clean upstream result for source-edge affinity and storage', async () => {
  installRepo();

  // Native /responses/compact returns a fully-shaped compaction envelope —
  // the `action: 'compact'` branch of `provider.callOpenAIResponses` does the
  // Copilot compaction_trigger reshape internally — so the attempt receives
  // a OpenAIResponsesResult, expands it into synthetic frames, and wraps the
  // output for storage. The synthesized envelope carries a `compaction`
  // output item; wrap observes it and derives the 'replace' snapshot.
  const compactionItem = {
    type: 'compaction' as const,
    id: 'cmp_1',
    encrypted_content: 'ENC',
  };
  const compactionResult: OpenAIResponsesResult = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    // Cast: `compaction` is an input-shaped item type the protocol's
    // OpenAIResponsesResult.output type does not include but the runtime accepts.
    output: [compactionItem] as unknown as OpenAIResponsesResult['output'],
  };

  const callOpenAIResponses = vi.fn(async (_model: ProviderModel, _body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction): Promise<ProviderOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`compact candidate received action='${action}'`);
    return {
      action: 'compact',
      ok: true,
      result: compactionResult,
      modelKey: 'test-model-key',
      headers: new Headers({
        'x-openai-internal-codex-responses-lite': 'true',
        'x-request-id': 'req_compact',
      }),
    };
  });

  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const result = await openaiResponsesAttempt.invoke({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'kept message' },
      ],
    }),
    action: 'compact',
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(result.result.output.length, 1);
  assertEquals((result.result.output[0] as { id: string }).id, 'cmp_1');
  assertEquals(result.result.id, compactionResult.id);
  assertEquals(result.headers?.get('x-openai-internal-codex-responses-lite'), 'true');
  assertEquals(result.headers?.get('x-request-id'), 'req_compact');
});

test('generate strips disallowed headers and injects external image loading across translation to Anthropic Messages', async () => {
  installRepo();
  initExternalResourceFetcher(url => {
    assertEquals(url.href, 'https://example.com/image.png');
    return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }));
  });
  let observedHeaders: Headers | undefined;
  let observedAnthropicBeta: readonly string[] | undefined;
  let observedBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
  const upstreamModel = stubInternalModel({ endpoints: { anthropicMessages: {} } }, 'up_test');
  const anthropicMessagesProvider = stubProvider({
    callAnthropicMessages: async (_model, body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
      observedHeaders = opts.headers;
      observedAnthropicBeta = (opts as AnthropicMessagesUpstreamCallOptions).anthropicBeta;
      observedBody = body as Omit<AnthropicMessagesPayload, 'model'>;
      return {
        ok: true,
        events: (async function* () {
          yield eventFrame<AnthropicMessagesStreamEvent>({
            type: 'message_start',
            message: {
              id: 'msg_1', type: 'message', role: 'assistant', content: [],
              model: 'test-model', stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_stop' });
          yield doneFrame();
        })(),
        modelKey: 'k',
        headers: new Headers(),
      };
    },
  });
  const candidate: ModelCandidate = {
    provider: {
      upstreamId: 'up_test', kind: 'custom', name: 'up_test', inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: anthropicMessagesProvider,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }],
      }],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    candidate,
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols', 'x-test': 'abc' }),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedHeaders?.get('x-test'), null);
  assertEquals(observedHeaders?.get('anthropic-beta'), null);
  assertEquals(observedAnthropicBeta, []);
  const message = observedBody?.messages[0];
  assert(message?.role === 'user' && Array.isArray(message.content));
  const image = message.content.find(block => block.type === 'image');
  assert(image?.type === 'image');
  assertEquals(image.source, { type: 'base64', media_type: 'image/png', data: 'AQID' });
});

test('generate seeds privatePayload before interceptors so the web-search shim replays the prior wsc results on echo', async () => {
  // End-to-end contract: when a stateless client (e.g. Codex CLI) echoes a
  // prior gateway-created web_search_call by its emitted id, the web-search shim's
  // `transformItems` (which runs as part of the interceptor chain) must
  // find the persisted `payload.private` and emit the cached function_call
  // + function_call_output pair to upstream — NOT the not-preserved
  // placeholder.
  //
  // The wire shape we model here:
  //   - row.id = the public item id echoed as `wsc.id`.
  //   - payload.item.id = that same public id.
  //   - payload.private = WebSearchCallPrivatePayload (v:1, functionCallItem, ir).
  //
  // This regression caught a prior ordering bug where hydration + beginAttempt
  // ran inside the interceptor closure, after the shim's input transform —
  // so privatePayload was always empty when the shim looked it up, and
  // every echoed wsc collapsed to the placeholder.
  const repo = installRepo();
  const storedId = `ws_${'a'.repeat(32)}`;
  const storedItem = {
    type: 'web_search_call' as const,
    id: storedId,
    status: 'completed' as const,
    action: { type: 'search' as const, query: 'deepseek v4', queries: ['deepseek v4'] },
  };
  await insertStoredItem(repo, {
    id: storedId,
    type: 'web_search_call',
    payload: {
      item: storedItem,
      private: {
        v: 1,
        functionCallItem: {
          type: 'function_call',
          call_id: 'call_orig_xyz',
          name: 'web_search',
          arguments: '{"search_query":[{"q":"deepseek v4"}]}',
          status: 'completed',
        },
        ir: {
          action: { type: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
          results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'CACHED_SNIPPET_BODY' }],
        },
      },
    },
  });

  // Capture the upstream-bound body so we can verify what the shim produced
  // after the echoed wsc passed through transformItems.
  let capturedBody: { input?: unknown[] } | undefined;
  const upstreamResponse = makeOpenAIResponsesResult();
  // The shim's multi-turn loop requires `response.created` (carrying a model
  // name) before any synthesized terminal envelope. Emit the canonical
  // created → in_progress → completed sequence so the shim can wrap.
  const upstreamEvents: OpenAIResponsesStreamEvent[] = [
    { type: 'response.created', sequence_number: 0, response: upstreamResponse },
    { type: 'response.in_progress', sequence_number: 1, response: upstreamResponse },
    { type: 'response.completed', sequence_number: 2, response: upstreamResponse },
  ];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    capturedBody = body as { input?: unknown[] };
    return { action: 'generate', ok: true, events: makeProviderEvents(upstreamEvents), modelKey: 'test-model-key', headers: new Headers() };
  });
  const candidate = makeCandidate(callOpenAIResponses, new Set(['openai-responses-web-search-shim']));

  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  await store.loadInputItems([{ type: 'web_search_call', id: storedId }], []);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'openai-responses.reasoning.encrypted_content',
    { syntheticItem: true },
  );

  const sourcePayload = makePayload({
    input: [
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'reasoning', id: 'rs_affinity', summary: [], encrypted_content: carrier },
      {
        type: 'web_search_call',
        id: storedId,
        status: 'completed',
        action: { type: 'search', queries: ['deepseek v4'] },
      } as unknown as never,
    ],
    tools: [{ type: 'web_search' }],
  });
  await store.loadInputItems(sourcePayload.input, sourcePayload.input);
  const hydrated = hydrateOpenAIResponsesPayload(sourcePayload, store);
  const affinity = await analyzeOpenAIResponsesAffinity(hydrated.payload, ctx.affinity.codec);
  const result = await openaiResponsesAttempt.generate({
    payload: acceptedAffinityEvaluation(affinity, candidate).materialize(),
    sourceState: {
      privatePayloads: hydrated.privatePayloads,
    },
    ctx,
    candidate,
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assert(capturedBody !== undefined, 'callOpenAIResponses was not invoked');
  const input = (capturedBody!.input ?? []) as Array<{ type: string; call_id?: string; output?: string; name?: string; arguments?: string }>;
  // The wsc echo MUST be replaced by the recovered function_call + output pair,
  // carrying the persisted call_id and the cached snippet body verbatim.
  const fc = input.find(i => i.type === 'function_call' && i.call_id === 'call_orig_xyz');
  assert(fc !== undefined, 'expected replayed function_call with the persisted call_id');
  assertEquals(fc!.name, 'web_search');
  assertEquals(fc!.arguments, '{"search_query":[{"q":"deepseek v4"}]}');
  const fco = input.find(i => i.type === 'function_call_output' && i.call_id === 'call_orig_xyz');
  assert(fco !== undefined, 'expected replayed function_call_output');
  assert(fco!.output?.includes('CACHED_SNIPPET_BODY'), `expected cached body in function_call_output, got: ${fco!.output}`);
  // And the not-preserved placeholder MUST NOT appear.
  assert(
    !input.some(i => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes('Prior search results were not preserved')),
    'shim emitted the not-preserved placeholder despite a stored private payload',
  );
});

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const completedEvent: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult(),
  };
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'request-id': 'req_resp_xyz',
  });
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: upstreamHeaders,
  }));
  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('request-id'), 'req_resp_xyz');
  await collectEvents(result.events);
});

test('generate bridges a marked Codex Responses Lite request to standard Responses and restores its client view', async () => {
  installRepo();
  const payload = makeCodexResponsesLitePayload({ tools: codexTools });
  const sourcePayload = JSON.parse(JSON.stringify(payload));
  const headers = new Headers({
    [CODEX_RESPONSES_LITE_HEADER]: 'true',
    'x-client-trace': 'source-header',
  });
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  let observedHeaders: Headers | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
    _action: OpenAIResponsesAction,
    _signal: AbortSignal | undefined,
    opts: UpstreamCallOptions,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    observedHeaders = opts.headers;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: {
          ...makeOpenAIResponsesResult('resp_bridged'),
          // Model wire identities deliberately differ from the caller-visible
          // custom/function types. The bridge must restore them on egress.
          output: [
            {
              type: 'function_call',
              call_id: 'call_patch',
              namespace: 'workspace',
              name: 'patch',
              arguments: 'apply',
              status: 'completed',
            },
            {
              type: 'custom_tool_call',
              call_id: 'call_lookup',
              namespace: 'functions',
              name: 'lookup',
              input: '{"key":"value"}',
              status: 'completed',
            },
          ],
          // These intentionally reflect the lifted standard request. Restoration
          // must put the original Lite controls back on the response resource.
          tools: [],
          instructions: 'lifted instructions must not leak',
          parallel_tool_calls: true,
          reasoning: { effort: 'high', context: 'current_turn' },
        },
      }]),
      modelKey: 'standard-key',
      headers: new Headers({ 'x-request-id': 'req_bridged' }),
    };
  });

  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: makeCandidate(callOpenAIResponses),
    headers,
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assert(observedBody !== undefined, 'expected standard Responses provider call');
  assertEquals(observedHeaders?.get(CODEX_RESPONSES_LITE_HEADER), null);
  // The upstream allowlist intentionally filters arbitrary client headers;
  // the source Headers instance is checked below for immutability instead.
  assertEquals(headers.get('x-client-trace'), 'source-header');
  assertEquals(observedBody.input, [
    { type: 'message', id: 'msg_developer', role: 'developer', content: [{ type: 'input_text', text: 'Use concise answers.' }] },
    { type: 'message', id: 'msg_user', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] },
  ]);
  assertEquals(observedBody.tools, codexTools);
  assertEquals(observedBody.tool_choice, 'auto');
  assertEquals(observedBody.reasoning, { effort: 'low', context: 'all_turns' });
  assertEquals(observedBody.parallel_tool_calls, false);
  assertEquals(observedBody.stream, true);
  assertEquals(observedBody.store, false);
  assertEquals(observedBody.text, payload.text);
  assertEquals((observedBody as unknown as { client_metadata?: unknown }).client_metadata, { request_trace: 'retain-me' });

  const events = await collectEvents(result.events);
  const completed = events.find((event): event is Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' }> => event.type === 'response.completed');
  assert(completed !== undefined, 'expected response.completed');
  assertEquals(completed.response.output, [
    {
      type: 'custom_tool_call',
      call_id: 'call_patch',
      namespace: 'workspace',
      name: 'patch',
      input: 'apply',
      status: 'completed',
    },
    {
      type: 'function_call',
      call_id: 'call_lookup',
      namespace: 'functions',
      name: 'lookup',
      arguments: '{"key":"value"}',
      status: 'completed',
    },
  ]);
  assertEquals(completed.response.tools, codexTools);
  assertEquals(completed.response.instructions, undefined);
  assertEquals(completed.response.parallel_tool_calls, false);
  assertEquals(completed.response.reasoning, { effort: 'low', context: 'all_turns' });
  assertEquals(result.headers?.get(CODEX_RESPONSES_LITE_HEADER), 'true');
  assertEquals(result.headers?.get('x-request-id'), 'req_bridged');
  assertEquals(payload, sourcePayload);
  assertEquals(headers.get(CODEX_RESPONSES_LITE_HEADER), 'true');
  assertEquals(headers.get('x-client-trace'), 'source-header');
});

test('generate does not infer Codex Responses Lite from an additional_tools item alone', async () => {
  installRepo();
  const payload = makePayload({
    input: [
      { type: 'additional_tools', id: 'at_standard', role: 'developer', tools: [] },
      { type: 'message', role: 'user', content: 'standard request' },
    ],
  });
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([{ type: 'response.completed', sequence_number: 0, response: makeOpenAIResponsesResult() }]),
      modelKey: 'standard-key', headers: new Headers(),
    };
  });

  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.input, payload.input);
  assertEquals(result.headers?.get(CODEX_RESPONSES_LITE_HEADER), null);
});

test('generate preserves native Lite payloads when the selected provider supports the actual provider model', async () => {
  installRepo();
  const payload = makeCodexResponsesLitePayload({ tools: codexTools });
  payload.input[2] = {
    type: 'message',
    id: 'msg_user',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Say hello.' },
      { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high' },
    ],
  };
  const sourcePayload = JSON.parse(JSON.stringify(payload));
  const headers = new Headers({ [CODEX_RESPONSES_LITE_HEADER]: 'true' });
  const supportsOpenAIResponsesLite = vi.fn((model: ProviderModel) => model.id === 'gpt-real-provider-model');
  let observedModel: ProviderModel | undefined;
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    model: ProviderModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedModel = model;
    observedBody = body;
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([{ type: 'response.completed', sequence_number: 0, response: makeOpenAIResponsesResult('resp_native_lite') }]),
      modelKey: 'native-lite-key', headers: new Headers(),
    };
  });

  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: makeNativeLiteCandidate(callOpenAIResponses, supportsOpenAIResponsesLite),
    headers,
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(supportsOpenAIResponsesLite.mock.calls.map(([model]) => model.id), ['gpt-real-provider-model']);
  assertEquals(observedModel?.id, 'gpt-real-provider-model');
  assertEquals(observedBody, {
    ...sourcePayload,
    model: undefined,
  });
  assertEquals('model' in (observedBody ?? {}), false);
  // Upstream header filtering is independent from the interceptor; this body
  // equality pins the Lite marker and all Lite-only request fields instead.
  assertEquals((observedBody?.input[2] as { content?: unknown[] })?.content?.[1], {
    type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high',
  });
  assertEquals(payload, sourcePayload);
  assertEquals(headers.get(CODEX_RESPONSES_LITE_HEADER), 'true');
});

test('generate leaves a bridged upstream API error status, body, and headers unchanged', async () => {
  installRepo();
  const errorBody = Uint8Array.of(0, 255, 7, 99);
  const upstreamResponse = new Response(errorBody, {
    status: 429,
    headers: { 'content-type': 'application/problem+json', 'retry-after': '11', 'x-upstream': 'untouched' },
  });
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: false, response: upstreamResponse, modelKey: 'standard-key',
  }));

  const result = await openaiResponsesAttempt.generate({
    payload: makeCodexResponsesLitePayload(),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers({ [CODEX_RESPONSES_LITE_HEADER]: 'true' }),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 429);
  assertEquals(result.headers.get('content-type'), 'application/problem+json');
  assertEquals(result.headers.get('retry-after'), '11');
  assertEquals(result.headers.get('x-upstream'), 'untouched');
  assertEquals(result.headers.get(CODEX_RESPONSES_LITE_HEADER), null);
  assertEquals(result.body, errorBody);
});

test('generate lifts Lite before the real Anthropic Messages and Chat Completions translations', async () => {
  installRepo();
  const payload = makeCodexResponsesLitePayload({ tool_choice: { type: 'custom', name: 'workspace.patch' } });
  payload.input[0] = {
    type: 'additional_tools', id: 'at_client', role: 'developer',
    tools: codexTools.map(tool => tool.type === 'namespace'
      ? { type: tool.type, name: tool.name, tools: tool.tools } as OpenAIResponsesTool
      : tool),
  };
  payload.input.push(
    { type: 'function_call', call_id: 'previous_lookup', name: 'lookup', namespace: 'functions', arguments: '{"key":"previous"}', status: 'completed' },
    { type: 'function_call_output', call_id: 'previous_lookup', output: 'found' },
    { type: 'custom_tool_call', call_id: 'previous_patch', name: 'patch', namespace: 'workspace', input: 'previous patch' },
    { type: 'custom_tool_call_output', call_id: 'previous_patch', output: 'applied' },
    { type: 'message', role: 'user', content: 'Continue.' },
  );

  let anthropicBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
  const callAnthropicMessages = vi.fn(async (
    _model: ProviderModel,
    body: Omit<AnthropicMessagesPayload, 'model'>,
  ): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    anthropicBody = body;
    return {
      ok: true,
      events: makeProtocolFrames([
        {
          type: 'message_start',
          message: {
            id: 'msg_anthropic', type: 'message', role: 'assistant', content: [],
            model: 'anthropic-target', stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_patch', name: 'workspace_patch', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"input":"apply"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_lookup', name: 'functions_lookup', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key":"value"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]),
      modelKey: 'anthropic-key', headers: new Headers(),
    };
  });
  const anthropicUpstream = 'up_lite_anthropic';
  const anthropicCandidate: ModelCandidate = {
    provider: {
      upstreamId: anthropicUpstream, kind: 'custom', name: anthropicUpstream,
      inboundHeaderAllowlist: [], disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callAnthropicMessages }),
    },
    model: stubInternalModel({
      id: 'anthropic-target',
      endpoints: { anthropicMessages: {} },
      providerModels: { [anthropicUpstream]: stubProviderModel({ id: 'anthropic-target', endpoints: { anthropicMessages: {} } }) },
    }, anthropicUpstream),
    fetcher: directFetcher,
  };

  const anthropicResult = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: anthropicCandidate,
    headers: new Headers(),
  });
  assertEquals(anthropicResult.type, 'events');
  if (anthropicResult.type !== 'events') throw new Error('unreachable');
  const anthropicEvents = await collectEvents(anthropicResult.events);
  assert(anthropicBody !== undefined, 'expected the Anthropic Messages call');
  assertEquals(anthropicBody.tools?.map(tool => tool.name), ['workspace_patch', 'functions_lookup', 'ping']);
  assertEquals(anthropicBody.tool_choice, { type: 'tool', name: 'workspace_patch' });
  assert(JSON.stringify(anthropicBody.system).includes('Use concise answers.'));
  const anthropicHistory = anthropicBody.messages.flatMap(message =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_use').map(block => block.name)
      : []);
  assertEquals(anthropicHistory, ['functions_lookup', 'workspace_patch']);

  let chatBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (
    _model: ProviderModel,
    body: Omit<OpenAIChatCompletionsPayload, 'model'>,
  ): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    chatBody = body;
    return {
      ok: true,
      events: makeProtocolFrames([
        {
          id: 'chat_lite', object: 'chat.completion.chunk', created: 0, model: 'chat-target',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        },
        {
          id: 'chat_lite', object: 'chat.completion.chunk', created: 0, model: 'chat-target',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_patch', type: 'function', function: { name: 'workspace_patch', arguments: '{"input":"apply"}' } },
                { index: 1, id: 'call_lookup', type: 'function', function: { name: 'functions_lookup', arguments: '{"key":"value"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        },
      ]),
      modelKey: 'chat-key', headers: new Headers(),
    };
  });
  const chatUpstream = 'up_lite_chat';
  const chatCandidate: ModelCandidate = {
    provider: {
      upstreamId: chatUpstream, kind: 'custom', name: chatUpstream,
      inboundHeaderAllowlist: [], disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callOpenAIChatCompletions }),
    },
    model: stubInternalModel({
      id: 'chat-target',
      endpoints: { openaiChatCompletions: {} },
      providerModels: { [chatUpstream]: stubProviderModel({ id: 'chat-target', endpoints: { openaiChatCompletions: {} } }) },
    }, chatUpstream),
    fetcher: directFetcher,
  };

  const chatResult = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: chatCandidate,
    headers: new Headers(),
  });
  assertEquals(chatResult.type, 'events');
  if (chatResult.type !== 'events') throw new Error('unreachable');
  const chatEvents = await collectEvents(chatResult.events);
  assert(chatBody !== undefined, 'expected the OpenAI Chat Completions call');
  assertEquals(chatBody.tools?.map(tool => tool.function.name), ['workspace_patch', 'functions_lookup', 'ping']);
  assertEquals(chatBody.tool_choice, { type: 'function', function: { name: 'workspace_patch' } });
  assertEquals(chatBody.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function.name), ['functions_lookup', 'workspace_patch']);
  for (const events of [anthropicEvents, chatEvents]) {
    const completed = events.find(event => event.type === 'response.completed');
    assert(completed?.type === 'response.completed', 'expected a translated terminal response');
    assertEquals(completed.response.output.map(item => {
      assert(item.type === 'function_call' || item.type === 'custom_tool_call');
      return [item.type, item.namespace, item.name, item.type === 'function_call' ? item.arguments : item.input];
    }), [
      ['custom_tool_call', 'workspace', 'patch', 'apply'],
      ['function_call', 'functions', 'lookup', '{"key":"value"}'],
    ]);
    assertEquals(completed.response.tool_choice, payload.tool_choice);
  }
});

test('compact lifts Lite before the compact shim rewrites its standard request', async () => {
  installRepo();
  const payload = makeCodexResponsesLitePayload();
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  let observedAction: OpenAIResponsesAction | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
    action: OpenAIResponsesAction,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    observedAction = action;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult('resp_compact_lite'),
      }]),
      modelKey: 'compact-key', headers: new Headers(),
    };
  });

  const result = await openaiResponsesAttempt.invoke({
    payload,
    action: 'compact',
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate: makeCandidate(callOpenAIResponses, new Set(['openai-responses-compact-shim'])),
    headers: new Headers({ [CODEX_RESPONSES_LITE_HEADER]: 'true' }),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(observedAction, 'generate');
  assert(observedBody !== undefined, 'expected compact shim to call the standard provider');
  assertEquals(observedBody.tools, []);
  assert(!observedBody.input.some(item => item.type === 'additional_tools'), 'Lite additional_tools must not reach the compact shim');
  const compactorPrompt = observedBody.input[0];
  assertEquals(compactorPrompt?.type, 'message');
  assert(compactorPrompt?.type === 'message' && compactorPrompt.role === 'system');
  assertEquals(result.headers?.get(CODEX_RESPONSES_LITE_HEADER), 'true');
});
