import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { missingRequiredCompactionKeys, missingRequiredResourceKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import * as responseResource from '../../../../src/data-plane/chat/openai-responses/response-resource.ts';
import { openaiResponsesServe } from '../../../../src/data-plane/chat/openai-responses/serve.ts';
import * as chatContext from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import * as liteCodec from '../../../../src/data-plane/codex/responses-lite.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { SqlRepo } from '../../../../src/repo/sql.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../../../repo/test-sqlite.ts';
import { flushAsyncWork } from '../../../test-utils/app.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesResultToEvents, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type FlagId, type ModelCandidate, directFetcher, type ProviderOpenAIResponsesResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the http entry exactly the
// provider candidates it wants, optionally with an alias-rules overlay
// attached.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}
const resolutionsQueue: QueuedResolution[] = [];
const lastSeenModel: { value: string | null } = { value: null };
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async ({ model }: { model: string }) => {
      lastSeenModel.value = model;
      const next = resolutionsQueue.shift();
      if (next === undefined) throw new Error('http_test: no resolution enqueued');
      return next;
    }),
  };
});

const { openaiResponsesHttp } = await import('../../../../src/data-plane/chat/openai-responses/http.ts');

const API_KEY_ID = 'key_http_test';

const queueResolution = (
  candidates: readonly ModelCandidate[],
  extra: { sawModel?: boolean; aliasRules?: AliasRules } = {},
): void => {
  const rules = extra.aliasRules;
  resolutionsQueue.push({
    candidates: rules !== undefined ? candidates.map(c => ({ ...c, rules })) : candidates,
    sawModel: extra.sawModel ?? candidates.length > 0,
    failedUpstreams: [],
  });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save(buildApiKey());
  return repo;
};

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: API_KEY_ID,
  userId: 1,
  name: 'http_test',
  key: 'sk-http-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'http_test',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

const makeApp = (apiKeyOverrides: Partial<ApiKey> = {}): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  // Stamp the authenticated key onto every request so the http entry sees the
  // same value the real auth middleware would set.
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey(apiKeyOverrides));
    c.set('user', buildUser());
    await next();
  });
  app.post('/v1/responses', openaiResponsesHttp.generate);
  app.post('/v1/responses/compact', openaiResponsesHttp.compact);
  return app;
};

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

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  enabledFlags?: ReadonlySet<FlagId>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
  const provider = stubProvider({
    callOpenAIResponses: overrides.callOpenAIResponses,
  });
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
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({
          endpoints,
          enabledFlags: overrides.enabledFlags ?? new Set(),
        }),
      },
    }, upstream),
    fetcher: directFetcher,
  };
};

const completedEvents = (id = 'resp_test'): OpenAIResponsesStreamEvent[] =>
  openaiResponsesResultToEvents(makeOpenAIResponsesResult(id)).map(frame => frame.event);

const queueCompletedResponse = (id = 'resp_test') => {
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents(completedEvents(id)),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueResolution([makeCandidate({ callOpenAIResponses })]);
  return callOpenAIResponses;
};

test('POST /v1/responses streams a successful SSE body', async () => {
  installRepo();
  const callOpenAIResponses = queueCompletedResponse();

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('event: response.completed'));
  // The source boundary mints its own response id; upstream's "resp_test" is discarded.
  const completedMatch = body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/);
  assert(completedMatch !== null, 'expected a source-owned response id in the SSE body');
  assert(completedMatch[1] !== 'resp_test', 'expected the source boundary to replace the upstream response id');
  assertEquals(body.split('data: [DONE]').length - 1, 1);
  assert(body.endsWith('data: [DONE]\n\n'), 'expected the SSE body to terminate on the [DONE] sentinel');
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('POST /v1/responses makes a done reasoning item reusable before terminal', async () => {
  installRepo();
  const originalReasoning = {
    type: 'reasoning' as const,
    id: 'rs_upstream',
    summary: [],
    encrypted_content: 'opaque',
  };
  const observedBodies: Array<Omit<CanonicalOpenAIResponsesPayload, 'model'>> = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let responseCall = 0;
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
    responseCall += 1;
    if (responseCall === 1) {
      const inProgress = {
        ...makeOpenAIResponsesResult('resp_first'),
        status: 'in_progress' as const,
        output: [],
        output_text: '',
      };
      return {
        action: 'generate',
        ok: true,
        events: (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
          yield eventFrame({ type: 'response.created', response: inProgress });
          yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: originalReasoning });
          yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: originalReasoning });
          await firstReleased;
        })(),
        modelKey: 'test-model-key',
        headers: new Headers(),
      };
    }
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents(completedEvents('resp_second')),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate({ callOpenAIResponses });
  queueResolution([candidate]);
  queueResolution([candidate]);

  const firstResponse = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'first', store: true, stream: true }),
  });
  const reader = firstResponse.body?.getReader();
  if (reader === undefined) throw new Error('Expected streaming response body');
  const decoder = new TextDecoder();
  let buffered = '';
  let publicReasoning: typeof originalReasoning | undefined;
  while (publicReasoning === undefined) {
    const next = await reader.read();
    if (next.done) throw new Error('Response ended before output_item.done');
    buffered += decoder.decode(next.value, { stream: true });
    for (const block of buffered.split('\n\n')) {
      if (!block.startsWith('event: response.output_item.done\n')) continue;
      const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (data === undefined) throw new Error('output_item.done had no data line');
      const event = JSON.parse(data) as { item: typeof originalReasoning };
      publicReasoning = event.item;
    }
  }
  assertEquals(publicReasoning.id, originalReasoning.id);
  assert(publicReasoning.encrypted_content !== originalReasoning.encrypted_content);
  await reader.cancel();

  try {
    const secondResponse = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: 'test-model',
        store: true,
        input: [publicReasoning, { type: 'message', role: 'user', content: 'continue' }],
      }),
    });
    assertEquals(secondResponse.status, 200);
    await secondResponse.json();
    assertEquals(observedBodies[1]?.input[0], originalReasoning);
  } finally {
    releaseFirst();
  }
});

test('POST /v1/responses canonicalizes an implicit system message and rewrites it to developer', async () => {
  installRepo();
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body as Omit<CanonicalOpenAIResponsesPayload, 'model'>;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents(completedEvents()),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueResolution([makeCandidate({
    callOpenAIResponses,
    enabledFlags: new Set(['rewrite-system-to-developer']),
  })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
      ],
      store: false,
      stream: true,
    }),
  });

  assertEquals(response.status, 200);
  const responseBody = await response.text();
  const responseId = responseBody.match(/"id":"(resp_[A-Za-z0-9_-]+)"/)?.[1];
  assert(responseId !== undefined, 'expected store:false response id');
  assert(responseId !== 'resp_test', 'expected the source boundary to replace the upstream response id');
  assertEquals(observedBody?.input, [
    { type: 'message', role: 'developer', content: 'rules' },
    { type: 'message', role: 'user', content: 'hello' },
  ]);
});

test('POST /v1/responses rejects a malformed untyped input item', async () => {
  installRepo();
  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: [null] }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; param: string } };
  assertEquals(body.error.message, 'Untyped OpenAI Responses input items require a valid role and content.');
  assertEquals(body.error.param, 'input[0]');
});

test('POST /v1/responses returns a single JSON body when stream is omitted', async () => {
  installRepo();
  queueCompletedResponse('resp_nonstream');

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as OpenAIResponsesResult;
  assert(body.id.length > 0 && body.id !== 'resp_nonstream', 'expected the source boundary to replace the upstream response id');
  assertEquals(body.status, 'completed');
});

test('POST /v1/responses answers a translated-shape upstream with a complete response resource', async () => {
  installRepo();
  queueCompletedResponse('resp_complete');

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(missingRequiredResourceKeys(body), []);
});

test('POST /v1/responses returns 502 when a non-streaming output item cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello' }),
    });

    assertEquals(response.status, 502);
    const body = await response.json() as { error: { message: string } };
    assertEquals(body.error.message, 'simulated item persistence failure');
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses terminates an SSE stream with error when an output item cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
    });

    // Streaming headers are already committed, so the protocol error frame is
    // the failure signal; a successful terminal frame must never follow it.
    assertEquals(response.status, 200);
    const body = await response.text();
    assert(body.includes('event: error'));
    assert(body.includes('simulated item persistence failure'));
    assert(!body.includes('event: response.output_item.done'));
    assert(!body.includes('event: response.completed'));
    assert(!body.includes('[DONE]'), 'expected a failed stream to end on the error frame, not the sentinel');
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses returns 502 when the response snapshot cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.openaiResponsesSnapshots, 'insert').mockRejectedValue(new Error('simulated snapshot persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello' }),
    });

    assertEquals(response.status, 502);
    const body = await response.json() as { error: { message: string } };
    assertEquals(body.error.message, 'simulated snapshot persistence failure');
  } finally {
    persistence.mockRestore();
  }
});

// One compact turn against a stubbed candidate. The upstream result is
// returned so a test can compare the answered body against what the upstream
// actually sent. Token counts are part of the default because every real
// compaction is a turn a model ran; a test that wants the reported-nothing
// case passes `usage: null`.
const compactTurn = async (
  upstream: Partial<OpenAIResponsesResult> = {},
  requestFields: Record<string, unknown> = {},
): Promise<{ upstream: OpenAIResponsesResult; response: Response }> => {
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: OpenAIResponsesResult = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as OpenAIResponsesResult['output'],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    ...upstream,
  };
  const callOpenAIResponses = vi.fn(async (_model: unknown, _body: unknown, action: OpenAIResponsesAction): Promise<ProviderOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  queueResolution([makeCandidate({ callOpenAIResponses })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
      store: false,
      ...requestFields,
    }),
  });
  return { upstream: compactionResult, response };
};

test('POST /v1/responses/compact returns a non-streaming compaction body', async () => {
  const repo = installRepo();
  const { response } = await compactTurn();

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { object: string; id: string; output: Array<{ id: string }> };
  assertEquals(body.object, 'response.compaction');
  assert(body.id.length > 0 && body.id !== 'resp_test', 'expected the source boundary to replace the upstream response id');
  assertEquals(await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, body.id, 0), null);
  assertEquals(await repo.openaiResponsesItems.lookupMany(API_KEY_ID, body.output.map(item => item.id), 0), []);
});

test('POST /v1/responses/compact answers the compaction resource, not the response resource', async () => {
  installRepo();
  const { upstream, response } = await compactTurn(
    { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
    { temperature: 0.3 },
  );

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(missingRequiredCompactionKeys(body), []);
  assertEquals(typeof body.created_at, 'number');
  assertEquals(body.usage, {
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
  assertEquals(responseOnlyKeysAdded(upstream, body), []);
});

test('POST /v1/responses/compact reports the failure when the upstream reported no usage', async () => {
  installRepo();
  const { response } = await compactTurn({ usage: null });

  assertEquals(response.status, 502);
  const body = await response.json() as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'internal_error');
  assert(
    body.error.message.includes('reported no token usage'),
    `expected the missing-usage condition to be named, got ${body.error.message}`,
  );
});

test('POST /v1/responses with an unresolvable previous_response_id renders the verbatim 400 envelope', async () => {
  installRepo();

  // No candidates need to be queued — the entry rejects before routing runs.
  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      previous_response_id: 'resp_missing',
      input: [{ type: 'message', role: 'user', content: 'follow up' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; type: string; param: string; code: string } };
  assertEquals(body.error.message, "Previous response with id 'resp_missing' not found.");
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'previous_response_id');
  assertEquals(body.error.code, 'previous_response_not_found');
});

test('POST /v1/responses and /v1/responses/compact reject a body without `model` with the OpenAI missing-parameter 400', async () => {
  installRepo();

  for (const path of ['/v1/responses', '/v1/responses/compact']) {
    const response = await makeApp().request(path, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ input: 'hello' }),
    });

    assertEquals(response.status, 400);
    const body = await response.json() as { error: { message: string; type: string; param: string; code: string } };
    assertEquals(body.error, {
      message: "Missing required parameter: 'model'.",
      type: 'invalid_request_error',
      param: 'model',
      code: 'missing_required_parameter',
    });
  }
});

const queueCodexAutoReviewCandidate = (
  callOpenAIResponses: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>,
): void => {
  const candidate = makeCandidate({ callOpenAIResponses });
  Object.assign(candidate.model, { id: 'gpt-5.4' });
  queueResolution([candidate], { aliasRules: { reasoning: { effort: 'low' } } });
};

test('POST /v1/responses routes a codex-auto-review request through the seeded alias: rewrites the model to gpt-5.4 and stamps reasoning.effort=low', async () => {
  installRepo();
  lastSeenModel.value = null;
  const observedBodies: Omit<CanonicalOpenAIResponsesPayload, 'model'>[] = [];
  queueCodexAutoReviewCandidate(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents(completedEvents()),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'codex-auto-review', input: 'hello', stream: true }),
  });

  assertEquals(response.status, 200);
  // The resolver sees the inbound alias id verbatim; target-id walking is
  // internal to `enumerateModelCandidates`.
  assertEquals(lastSeenModel.value, 'codex-auto-review');
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callOpenAIResponses to receive a body');
  // The attempt strips `model` from the body — the provider re-stamps it
  // from `candidate.model.id` — so we only verify the rules landed on the
  // IR.
  assertEquals(observed.reasoning?.effort, 'low');
});

test('POST /v1/responses/compact routes a codex-auto-review request through the seeded alias: rewrites the model to gpt-5.4 and stamps reasoning.effort=low (the alias rule overlays the compact body too)', async () => {
  installRepo();
  lastSeenModel.value = null;
  const observedBodies: Omit<CanonicalOpenAIResponsesPayload, 'model'>[] = [];
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: OpenAIResponsesResult = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as OpenAIResponsesResult['output'],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
  };
  queueCodexAutoReviewCandidate(async (_model, body, action): Promise<ProviderOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    observedBodies.push(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'codex-auto-review',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      prompt_cache_retention: '24h',
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(lastSeenModel.value, 'codex-auto-review');
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callOpenAIResponses to receive a body');
  assertEquals(observed.reasoning?.effort, 'low');
  assertEquals(observed.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assertEquals(observed.prompt_cache_retention, '24h');
});

test('POST /v1/responses renders the OpenAI-shaped model-unsupported 400 when no candidate matches the responses picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `openaiCompletions` —
  // openaiResponsesTarget (responses > messages > openai-chat-completions) rejects it,
  // leaving zero viable candidates, and with sawModel=true the serve renders
  // model-unsupported as a 400.
  queueResolution([makeCandidate({ endpoints: { openaiCompletions: {} } })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'wrong-endpoint-model', input: 'hello' }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assert(body.error.message.includes('does not support'));
});

test('POST /v1/responses/compact answers a body that states no status, as a native compact upstream sends', async () => {
  installRepo();
  const { response } = await compactTurn({ status: undefined as unknown as OpenAIResponsesResult['status'] });

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(body.object, 'response.compaction');
  assertEquals(missingRequiredCompactionKeys(body), []);
  assertEquals((body.output as Array<{ type: string }>).map(item => item.type), ['compaction']);
});

test('POST /v1/responses nests a mid-stream failure under `error` so an SDK stream reader throws on it, then follows it with response.failed', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame(completedEvents()[0]!);
      throw new Error('upstream exploded mid-stream');
    })(),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueResolution([makeCandidate({ callOpenAIResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
  });

  const body = await response.text();
  const chunk = body.split('\n\n').find(part => part.startsWith('event: error'));
  assert(chunk !== undefined, `expected an error frame in ${body}`);
  const data = JSON.parse(chunk.slice(chunk.indexOf('data: ') + 'data: '.length)) as {
    type: string;
    error?: { message?: unknown };
    message?: unknown;
  };
  assertEquals(data.type, 'error');
  assertEquals(data.error?.message, 'upstream exploded mid-stream');
  assert(data.message === undefined, 'expected the payload to sit under `error`, not at the top level');

  const failedChunk = body.split('\n\n').find(part => part.startsWith('event: response.failed'));
  assert(failedChunk !== undefined, `expected a response.failed frame in ${body}`);
  const failed = JSON.parse(failedChunk.slice(failedChunk.indexOf('data: ') + 'data: '.length)) as {
    response: { status: string; id: string; error: { message: string } };
  };
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error.message, 'upstream exploded mid-stream');
  const created = JSON.parse(
    body.split('\n\n').find(part => part.startsWith('event: response.created'))!.split('data: ')[1]!,
  ) as { response: { id: string } };
  assertEquals(failed.response.id, created.response.id);
});

const translatedCustomCandidate = (
  target: 'openaiChatCompletions' | 'anthropicMessages',
  observe: (body: Record<string, unknown>) => void,
  callExec = false,
): ModelCandidate => {
  const candidate = makeCandidate({ upstream: `up_${target}`, endpoints: { [target]: {} } });
  const instance = stubProvider({
    callOpenAIChatCompletions: async (_model, body) => {
      observe(body as unknown as Record<string, unknown>);
      const chunk = (choices: OpenAIChatCompletionsStreamEvent['choices']): OpenAIChatCompletionsStreamEvent => ({ id: 'chat_exec', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices });
      return {
        ok: true, modelKey: 'test-model-key', events: (async function* () {
          yield eventFrame(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));
          yield eventFrame(chunk([{ index: 0, delta: callExec ? { tool_calls: [{ index: 0, id: 'call_exec', type: 'function', function: { name: 'exec', arguments: '{"input":"patch"}' } }] } : { content: 'done' }, finish_reason: null }]));
          yield eventFrame(chunk([{ index: 0, delta: {}, finish_reason: callExec ? 'tool_calls' : 'stop' }]));
          yield doneFrame();
        })(),
      };
    },
    callAnthropicMessages: async (_model, body) => {
      observe(body as unknown as Record<string, unknown>);
      return {
        ok: true, modelKey: 'test-model-key', events: (async function* () {
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_start', message: { id: 'msg_exec', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_start', index: 0, content_block: callExec ? { type: 'tool_use', id: 'call_exec', name: 'exec', input: {} } : { type: 'text', text: '' } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_delta', index: 0, delta: callExec ? { type: 'input_json_delta', partial_json: '{"input":"patch"}' } : { type: 'text_delta', text: 'done' } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_stop', index: 0 });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_delta', delta: { stop_reason: callExec ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_stop' });
        })(),
      };
    },
  });
  return { ...candidate, provider: { ...candidate.provider, instance } };
};

for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
  test(`POST /v1/responses continues a custom exec call through ${target} with text-array output`, async () => {
    installRepo();
    const bodies: Record<string, unknown>[] = [];
    const observe = (body: Record<string, unknown>) => { bodies.push(structuredClone(body)); };
    const headers = { 'content-type': 'application/json' };
    const tools = [{ type: 'custom', name: 'exec' }];
    queueResolution([translatedCustomCandidate(target, observe, true)]);
    const first = await makeApp().request('/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'test-model', store: true, tools, input: [{ role: 'user', content: 'inspect the request' }] }),
    });
    assertEquals(first.status, 200);
    const previous = await first.json() as OpenAIResponsesResult;
    const call = previous.output.find(item => item.type === 'custom_tool_call');
    assert(call?.type === 'custom_tool_call');
    assertEquals([call.name, call.namespace, call.input], ['exec', undefined, 'patch']);
    assertEquals(bodies.length, 1);

    queueResolution([translatedCustomCandidate(target, observe)]);
    const second = await makeApp().request('/v1/responses', {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'test-model', store: true, tools, previous_response_id: previous.id,
        input: [{
          type: 'custom_tool_call_output', call_id: call.call_id,
          output: [{ type: 'input_text', text: 'first\n' }, { type: 'input_text', text: 'second' }],
        }],
      }),
    });
    assertEquals(second.status, 200);
    const completed = await second.json() as OpenAIResponsesResult;
    assertEquals(completed.status, 'completed');
    assertEquals(completed.output_text, 'done');
    assertEquals(bodies.length, 2);
    if (target === 'openaiChatCompletions') {
      assertEquals(bodies[1]!.messages, [
        { role: 'user', content: 'inspect the request' },
        {
          role: 'assistant', content: null,
          tool_calls: [{ id: call.call_id, type: 'function', function: { name: 'exec', arguments: '{"input":"patch"}' } }],
        },
        { role: 'tool', tool_call_id: call.call_id, content: 'first\nsecond' },
      ]);
    } else {
      assertEquals(bodies[1]!.messages, [
        { role: 'user', content: 'inspect the request' },
        { role: 'assistant', content: [{ type: 'tool_use', id: call.call_id, name: 'exec', input: { input: 'patch' } }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: call.call_id,
            content: [{ type: 'text', text: 'first\n' }, { type: 'text', text: 'second' }],
            cache_control: { type: 'ephemeral' },
          }],
        },
      ]);
    }
  });
}

const translatedNamespaceCandidate = (
  target: 'openaiChatCompletions' | 'anthropicMessages',
  observe: (body: Record<string, unknown>) => void,
  returnedName?: string,
  fail = false,
): ModelCandidate => {
  const candidate = makeCandidate({ upstream: `up_${target}`, endpoints: { [target]: {} } });
  const instance = stubProvider({
    callOpenAIChatCompletions: async (_model, body) => {
      observe(body as unknown as Record<string, unknown>);
      if (fail) return { ok: false, response: new Response('retry this candidate', { status: 500 }), modelKey: 'test-model-key' };
      const chunk = (choices: OpenAIChatCompletionsStreamEvent['choices']): OpenAIChatCompletionsStreamEvent => ({ id: 'chat_namespace', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices });
      return {
        ok: true, modelKey: 'test-model-key', events: (async function* () {
          yield eventFrame(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));
          yield eventFrame(chunk([{ index: 0, delta: returnedName === undefined ? { content: 'done' } : { tool_calls: [{ index: 0, id: 'call_namespace', type: 'function', function: { name: returnedName, arguments: '{"input":"patch"}' } }] }, finish_reason: null }]));
          yield eventFrame(chunk([{ index: 0, delta: {}, finish_reason: returnedName === undefined ? 'stop' : 'tool_calls' }]));
          yield doneFrame();
        })(),
      };
    },
    callAnthropicMessages: async (_model, body) => {
      observe(body as unknown as Record<string, unknown>);
      if (fail) return { ok: false, response: new Response('retry this candidate', { status: 500 }), modelKey: 'test-model-key' };
      return {
        ok: true, modelKey: 'test-model-key', events: (async function* () {
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_start', message: { id: 'msg_namespace', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_start', index: 0, content_block: returnedName === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call_namespace', name: returnedName, input: {} } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_delta', index: 0, delta: returnedName === undefined ? { type: 'text_delta', text: 'done' } : { type: 'input_json_delta', partial_json: '{"input":"patch"}' } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'content_block_stop', index: 0 });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_delta', delta: { stop_reason: returnedName === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_stop' });
        })(),
      };
    },
  });
  return { ...candidate, provider: { ...candidate.provider, instance } };
};

for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
  for (const scope of ['namespace', 'flat'] as const) {
    test(`${target} continuation keeps historical function and current custom identities distinct in ${scope} tools`, async () => {
      const repo = installRepo();
      const bodies: Record<string, unknown>[] = [];
      const tools = (type: 'function' | 'custom') => scope === 'namespace'
        ? [{ type: 'namespace', name: 'fs', description: '', tools: [{ type, name: 'read' }] }]
        : [{ type, name: 'read' }, { type: 'namespace', name: 'unused', description: '', tools: [{ type: 'function', name: 'other' }] }];
      const currentName = scope === 'namespace' ? 'fs_read' : 'read';
      queueResolution([translatedNamespaceCandidate(target, body => bodies.push(structuredClone(body)), currentName)]);
      const first = await makeApp().request('/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', tools: tools('function'), input: 'read a file' }),
      });
      assertEquals(first.status, 200);
      const previous = await first.json() as OpenAIResponsesResult;
      const history = previous.output.find(item => item.type === 'function_call');
      assert(history?.type === 'function_call');
      queueResolution([translatedNamespaceCandidate(target, body => bodies.push(structuredClone(body)), currentName)]);
      const second = await makeApp().request('/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', tools: tools('custom'), previous_response_id: previous.id, input: [{ type: 'function_call_output', call_id: history.call_id, output: 'done' }, { role: 'user', content: 'continue' }] }),
      });
      assertEquals(second.status, 200);
      const current = await second.json() as OpenAIResponsesResult;
      const output = current.output.find(item => item.type === 'custom_tool_call');
      assert(output?.type === 'custom_tool_call');
      assertEquals([output.name, output.namespace, output.input], ['read', scope === 'namespace' ? 'fs' : undefined, 'patch']);
      assertEquals(bodies.length, 2);
      assert(JSON.stringify(bodies[1]!.messages).includes(`"name":"${currentName}_2"`), 'historical function must not borrow the current custom alias');
      const rows = await repo.openaiResponsesItems.lookupMany(API_KEY_ID, [history.id!], 0);
      assertEquals(rows[0]?.payload.item, history);
    });
  }

  test(`Responses Lite ${target} persists canonical namespaces and replays them with a changed tool collision set`, async () => {
    const repo = installRepo();
    const bodies: Record<string, unknown>[] = [];
    const namespace = { type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit', format: { type: 'text' } }] };
    const flat = { type: 'function', name: 'files_edit', parameters: { type: 'object' } };
    queueResolution([translatedNamespaceCandidate(target, body => bodies.push(structuredClone(body)), 'files_edit_2')]);
    const first = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'test-model', tools: [flat], tool_choice: { type: 'custom', name: 'edit', namespace: 'files' }, input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }, { role: 'user', content: 'edit a file' }] }),
    });
    assertEquals(first.status, 200);
    const firstBody = await first.json() as OpenAIResponsesResult;
    const item = firstBody.output.find(item => item.type === 'custom_tool_call');
    assert(item?.type === 'custom_tool_call');
    assertEquals([item.name, item.namespace, item.input], ['edit', 'files', 'patch']);
    assertEquals(firstBody.tool_choice, { type: 'custom', name: 'edit', namespace: 'files' });
    const rows = await repo.openaiResponsesItems.lookupMany(API_KEY_ID, [item.id!], 0);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.payload.item, item);
    assertEquals((bodies[0]!.tools as Array<{ name?: string; function?: { name: string } }>).map(tool => tool.name ?? tool.function?.name), ['files_edit', 'files_edit_2']);
    assertEquals(bodies[0]!.tool_choice, target === 'openaiChatCompletions' ? { type: 'function', function: { name: 'files_edit_2' } } : { type: 'tool', name: 'files_edit_2' });

    queueResolution([translatedNamespaceCandidate(target, body => bodies.push(structuredClone(body)))]);
    const second = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', previous_response_id: firstBody.id, tools: [flat, { ...flat, name: 'files_edit_2' }], input: [{ type: 'custom_tool_call_output', call_id: item.call_id, output: 'done' }, { role: 'user', content: 'continue' }] }),
    });
    assertEquals(second.status, 200);
    await second.json();
    assertEquals(bodies.length, 2);
    const serializedHistory = JSON.stringify(bodies[1]!.messages);
    assert(serializedHistory.includes('files_edit_3'), 'hydrated custom history must allocate against the new collision set');
    assert(!serializedHistory.includes('"name":"files_edit_2"'), 'persisted history must not retain the first attempt wire name');

    let native: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
    queueResolution([makeCandidate({
      callOpenAIResponses: async (_model, body) => {
        native = body as Omit<CanonicalOpenAIResponsesPayload, 'model'>;
        return { action: 'generate', ok: true, modelKey: 'test-model-key', events: makeProviderEvents(completedEvents()) };
      },
    })]);
    const third = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', tools: [namespace], input: [{ type: 'item_reference', id: item.id }, { type: 'custom_tool_call_output', call_id: item.call_id, output: 'done' }] }),
    });
    assertEquals(third.status, 200);
    await third.json();
    assertEquals(native?.input[0], item);
    assertEquals(native?.tools, [namespace]);
  });

  test(`Responses Lite ${target} projects stored Standard carriers after hydration`, async () => {
    const repo = installRepo();
    const carrier = {
      type: 'additional_tools', role: 'developer', id: 'at_standard_source',
      tools: [{ type: 'namespace', name: 'files', description: 'File policy', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }],
    };
    queueCompletedResponse();
    const seed = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', store: true, input: [carrier, { role: 'user', content: 'original' }] }),
    });
    assertEquals(seed.status, 200);
    const previous = await seed.json() as OpenAIResponsesResult;
    await flushAsyncWork();
    const originalSnapshot = await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, previous.id, 0);
    assert(originalSnapshot !== null);
    assertEquals(originalSnapshot.sourceItemIds, undefined);
    assert(originalSnapshot.itemIds.includes(carrier.id));
    const bodies: Record<string, unknown>[] = [];
    for (const source of [
      { input: [{ type: 'item_reference', id: carrier.id }, { role: 'user', content: 'follow-up' }] },
      { input: [carrier, { role: 'user', content: 'follow-up' }] },
      { previous_response_id: previous.id, input: [{ role: 'user', content: 'follow-up' }] },
    ]) {
      queueResolution([translatedNamespaceCandidate(target, body => bodies.push(structuredClone(body)))]);
      const response = await makeApp().request('/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
        body: JSON.stringify({ model: 'test-model', store: true, ...source }),
      });
      const result = await response.json() as OpenAIResponsesResult;
      assertEquals(response.status, 200, JSON.stringify(result));
      await flushAsyncWork();
      const snapshot = await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, result.id, 0);
      assertEquals(snapshot?.sourceItemIds, [carrier.id]);
      const [storedCarrier] = await repo.openaiResponsesItems.lookupMany(API_KEY_ID, [carrier.id], 0);
      assertEquals(storedCarrier?.payload.item, carrier);
      const referencedRows = await repo.openaiResponsesItems.lookupMany(
        API_KEY_ID,
        [...(snapshot?.itemIds ?? []), ...(snapshot?.sourceItemIds ?? [])],
        0,
      );
      assert(referencedRows.every(row => row.payload.private === undefined), 'source context must use ordinary item rows');
      const body = bodies.at(-1)!;
      assertEquals((body.tools as Array<{ name?: string; function?: { name: string } }>).map(tool => tool.name ?? tool.function?.name), ['files_read']);
      assert(!JSON.stringify(body.messages).includes('additional_tools'));
    }
    assertEquals(bodies[0]!.tools, bodies[1]!.tools);
    assertEquals(bodies[0]!.messages, bodies[1]!.messages);
  });

  test(`Responses Lite ${target} API-error candidate cannot contaminate a native failover payload`, async () => {
    installRepo();
    const namespace = { type: 'namespace', name: 'files', description: '', tools: [{ type: 'function', name: 'read' }] };
    let translatedCalls = 0;
    let nativeCalls = 0;
    const bad = translatedNamespaceCandidate(target, body => {
      translatedCalls++;
      assert(JSON.stringify(body.tools).includes('files_read'));
      body.tools = [];
    }, undefined, true);
    const good = makeCandidate({
      callOpenAIResponses: async (_model, body) => {
        nativeCalls++;
        const request = body as Omit<CanonicalOpenAIResponsesPayload, 'model'>;
        assertEquals(request.tools, [namespace]);
        assertEquals(request.instructions, 'base');
        assertEquals(request.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'files' }] });
        assertEquals(request.input.some(item => item.type === 'additional_tools'), false);
        return { action: 'generate', ok: true, modelKey: 'test-model-key', events: makeProviderEvents(completedEvents()) };
      },
    });
    queueResolution([bad, good]);
    const response = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'test-model', instructions: 'base', tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'files' }] }, input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }, { role: 'user', content: 'hello' }] }),
    });
    assertEquals(response.status, 200);
    await response.json();
    assertEquals([translatedCalls, nativeCalls], [1, 1]);
  });
}

for (const transport of ['json', 'stream', 'compact'] as const) {
  test(`Responses Lite HTTP ${transport} is Standard before ctx/store construction and serve, retaining raw dump bytes`, async () => {
    installRepo();
    const dumps = installDumpStubs(initDumpStore, initDumpBroker);
    const namespace = { type: 'namespace', name: 'files', description: 'Files', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] };
    const caller = {
      model: 'test-model', stream: transport === 'stream',
      client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: 'true', retain: 'caller' },
      input: [
        { type: 'additional_tools', role: 'developer', tools: [namespace] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'base rules' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
        { role: 'user', content: 'hello' },
      ],
    };
    const raw = JSON.stringify(caller, null, 2);
    let normalized: ReturnType<typeof liteCodec.normalizeResponsesIngress> | undefined;
    const normalize = liteCodec.normalizeResponsesIngress;
    const normalization = vi.spyOn(liteCodec, 'normalizeResponsesIngress').mockImplementation((request, headers) => {
      normalized = normalize(request, headers);
      return normalized;
    });
    const createCtx = chatContext.createChatGatewayCtxFromHono;
    const creation = vi.spyOn(chatContext, 'createChatGatewayCtxFromHono').mockImplementation((...args) => {
      assert(normalized !== undefined, 'normalization must precede context and store construction');
      assertEquals(normalized.payload.tools, [namespace]);
      assertEquals(normalized.payload.instructions, 'base rules');
      assertEquals(normalized.payload.input, [{ type: 'message', role: 'user', content: 'hello' }]);
      assertEquals(new TextDecoder().decode(args[1].requestBody.bytes), raw);
      return createCtx(...args);
    });
    const action = transport === 'compact' ? 'compact' : 'generate';
    const serve = openaiResponsesServe[action];
    const serving = vi.spyOn(openaiResponsesServe, action).mockImplementation(async args => {
      assert(args.payload === normalized?.payload, 'serve must receive the normalized payload itself');
      assertEquals(args.headers.get('x-openai-internal-codex-responses-lite'), null);
      assertEquals((args.payload as unknown as Record<string, unknown>).client_metadata, { retain: 'caller' });
      return await serve(args);
    });
    const called = vi.fn(async (_model: unknown, body: unknown, upstreamAction: OpenAIResponsesAction): Promise<ProviderOpenAIResponsesResult> => {
      const standard = body as CanonicalOpenAIResponsesPayload;
      assertEquals(standard.instructions, 'base rules');
      assertEquals(standard.tools, [namespace]);
      assertEquals(standard.input.some(item => item.type === 'additional_tools'), false);
      const resource = { ...makeOpenAIResponsesResult(), tools: standard.tools ?? undefined, instructions: standard.instructions, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
      return upstreamAction === 'compact'
        ? { action: 'compact', ok: true, result: { ...resource, object: 'response.compaction' }, modelKey: 'test-model-key' }
        : { action: 'generate', ok: true, events: makeProviderEvents(openaiResponsesResultToEvents(resource).map(frame => frame.event)), modelKey: 'test-model-key' };
    });
    queueResolution([makeCandidate({ callOpenAIResponses: called })]);
    try {
      const response = await makeApp({ dumpRetentionSeconds: 3600 }).request(transport === 'compact' ? '/v1/responses/compact' : '/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' }, body: raw,
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-openai-internal-codex-responses-lite'), 'true');
      if (transport === 'stream') {
        const text = await response.text();
        const resources = text.split('\n\n').filter(part => part.includes('data: {')).map(part => JSON.parse(part.split('data: ')[1]!) as { response?: Record<string, unknown> }).flatMap(event => event.response === undefined ? [] : [event.response]);
        assert(resources.length > 0);
        for (const resource of resources) {
          assertEquals(missingRequiredResourceKeys(resource), []);
          assertEquals(resource.tools, []);
          assertEquals(resource.instructions, null);
        }
      } else {
        const body = await response.json() as Record<string, unknown>;
        assertEquals(transport === 'compact' ? missingRequiredCompactionKeys(body) : missingRequiredResourceKeys(body), []);
        assertEquals(body.tools, transport === 'compact' ? undefined : []);
        assertEquals(body.instructions, transport === 'compact' ? undefined : null);
      }
      await flushAsyncWork();
      assertEquals(called.mock.calls.length, 1);
      assertEquals(creation.mock.calls.length, 1);
      assertEquals(serving.mock.calls.length, 1);
      assertEquals(dumps.stored.length, 1);
      assertEquals(new TextDecoder().decode(dumps.stored[0]!.record.request.body), raw);
      assert(dumps.stored[0]!.record.request.headers.some(([name, value]) => name === 'x-openai-internal-codex-responses-lite' && value === 'true'));
    } finally {
      serving.mockRestore();
      creation.mockRestore();
      normalization.mockRestore();
    }
  });
}

test('Responses Lite HTTP persists context per branch and preserves source history for Standard requests', async () => {
  const repo = installRepo();
  const bodies: Omit<CanonicalOpenAIResponsesPayload, 'model'>[] = [];
  const tools = [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }];
  const addedTools = [{ type: 'namespace', name: 'database', description: '', tools: [{ type: 'function', name: 'query', parameters: { type: 'object' } }] }];
  const prefix = (declarations: unknown[], instructions: string) => [
    { type: 'additional_tools', role: 'developer', tools: declarations },
    {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    },
  ];
  const create = async (input: unknown[], previous_response_id?: string, lite = true): Promise<OpenAIResponsesResult> => {
    queueResolution([makeCandidate({
      callOpenAIResponses: async (_model, body) => {
        bodies.push(structuredClone(body) as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
        return { action: 'generate', ok: true, modelKey: 'test-model-key', events: makeProviderEvents(completedEvents()) };
      },
    })]);
    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(lite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {}) },
      body: JSON.stringify({ model: 'test-model', store: true, instructions: '', input, previous_response_id }),
    });
    assertEquals(response.status, 200);
    const result = await response.json() as OpenAIResponsesResult;
    await flushAsyncWork();
    assert((await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, result.id, 0)) !== null);
    return result;
  };

  const first = await create([...prefix(tools, 'Read files first.'), { role: 'user', content: 'first' }]);
  const branch = await create([...prefix(addedTools, 'Query the database first.'), { role: 'user', content: 'branch' }], first.id);
  await create([{ role: 'user', content: 'continue branch' }], branch.id);
  await create([{ role: 'user', content: 'continue original' }], first.id);
  await create([{ role: 'user', content: 'Standard follow-up' }], first.id, false);

  assertEquals(bodies.map(body => body.tools), [tools, [...tools, ...addedTools], [...tools, ...addedTools], tools, undefined]);
  assertEquals(bodies.map(body => body.instructions), [
    'Read files first.', 'Query the database first.', 'Query the database first.', 'Read files first.', '',
  ]);
  assertEquals(bodies[3]!.input.flatMap(item => item.type === 'message' && item.role === 'user' ? [item.content] : []), ['first', 'continue original']);
  assert(bodies.slice(0, 4).every(body => body.input.every(item => item.type !== 'additional_tools')), 'Lite dispatch must use the projected history');
  assertEquals(bodies[4]!.input.slice(0, 2), prefix(tools, 'Read files first.'));
});

for (const identified of [false, true]) {
  test(`Responses Lite HTTP preserves ${identified ? 'supplied' : 'generated'} source item identities across SQL reopen`, async () => {
    initFileStore(new MemoryFileStore());
    let database = await createSqlJsDatabase();
    for (const [, sql] of migrationSqlByFilename) database.run(sql);
    let repo = new SqlRepo(wrapSqlJsDatabase(database));
    await repo.apiKeys.save(buildApiKey());
    initRepo(repo);
    const tools = [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }];
    const input = [
      { type: 'additional_tools', role: 'developer', tools, ...(identified ? { id: 'at_source' } : {}) },
      {
        type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Retain these base instructions.' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] }, ...(identified ? { id: 'msg_source' } : {}),
      },
      { type: 'message', role: 'user', content: 'first' },
    ];
    const bodies: Array<Omit<CanonicalOpenAIResponsesPayload, 'model'>> = [];
    const effectiveReasoning = { effort: 'high', summary: 'detailed', context: 'all_turns' } as const;
    const candidate = makeCandidate({
      callOpenAIResponses: async (_model, body) => {
        bodies.push(structuredClone(body) as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
        return {
          action: 'generate', ok: true, modelKey: 'test-model-key',
          events: makeProviderEvents(openaiResponsesResultToEvents({ ...makeOpenAIResponsesResult(), output: [], reasoning: effectiveReasoning, parallel_tool_calls: false }).map(frame => frame.event)),
        };
      },
    });
    const send = async (items: unknown[], previous_response_id?: string, lite = true) => {
      queueResolution([candidate]);
      const response = await makeApp().request('/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(lite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {}) },
        body: JSON.stringify({ model: 'test-model', store: true, input: items, previous_response_id }),
      });
      const result = await response.json() as OpenAIResponsesResult;
      assertEquals(response.status, 200, JSON.stringify(result));
      assertEquals(result.reasoning, effectiveReasoning);
      assertEquals(result.parallel_tool_calls, false);
      await flushAsyncWork();
      return result;
    };
    try {
      const first = await send(input);
      const snapshot = await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, first.id, 0);
      assert(snapshot !== null);
      const sourceIds = snapshot.sourceItemIds;
      assert(sourceIds !== undefined);
      assertEquals(snapshot.itemIds.slice(0, 2), sourceIds);
      if (identified) assertEquals(sourceIds, ['at_source', 'msg_source']);
      const rows = await repo.openaiResponsesItems.lookupMany(API_KEY_ID, sourceIds, 0);
      for (const [index, id] of sourceIds.entries()) assertEquals(rows.find(row => row.id === id)?.payload.item, input[index]);
      const snapshotRows = await repo.openaiResponsesItems.lookupMany(
        API_KEY_ID,
        [...snapshot.itemIds, ...sourceIds],
        0,
      );
      assert(snapshotRows.every(row => row.payload.private === undefined), 'source context must not create a private item row');

      const image = database.export();
      database.close();
      database = await createSqlJsDatabase(image);
      repo = new SqlRepo(wrapSqlJsDatabase(database));
      initRepo(repo);
      assertEquals(await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, first.id, 0), snapshot);
      await send([{ type: 'message', role: 'user', content: 'continue' }], first.id);
      assertEquals(bodies.at(-1)?.tools, tools);
      assertEquals(bodies.at(-1)?.instructions, 'Retain these base instructions.');
      for (const id of sourceIds) {
        for (const previous of [undefined, first.id]) await send([{ type: 'item_reference', id }], previous);
      }
      await send(sourceIds.map(id => ({ type: 'item_reference', id })));
      assertEquals(bodies.at(-1)?.tools, tools);
      assertEquals(bodies.at(-1)?.instructions, 'Retain these base instructions.');
      assertEquals(bodies.at(-1)?.input, []);
      const standardSeed = await send(input, undefined, false);
      await send([{ type: 'message', role: 'user', content: 'Lite continuation of Standard history' }], standardSeed.id);
      assertEquals(bodies.at(-1)?.tools, tools);
      assertEquals(bodies.at(-1)?.instructions, undefined);
      assertEquals(bodies.at(-1)?.input.find(item => item.type === 'message' && item.role === 'developer'), input[1]);
      await send([{ type: 'message', role: 'user', content: 'Standard continuation' }], first.id, false);
      assertEquals(bodies.at(-1)?.input.slice(0, 2), input.slice(0, 2));
      assertEquals(bodies.at(-1)?.tools, undefined);
    } finally {
      await flushAsyncWork();
      database.close();
    }
  });
}

test('Responses Lite client echoes run after item persistence and before required resource completion', async () => {
  const repo = installRepo();
  const originalWrap = responseResource.wrapResponseResourceCompletion;
  let checked = 0;
  const completion = vi.spyOn(responseResource, 'wrapResponseResourceCompletion').mockImplementation((frames, sources) => {
    assertEquals(sources.request.instructions, undefined, 'schema fallback must use the caller view, not lifted instructions');
    assertEquals(sources.request.tools, undefined);
    const observed = (async function* () {
      for await (const frame of frames) {
        if (frame.type === 'event' && frame.event.type === 'response.completed') {
          assertEquals(frame.event.response.instructions, undefined, 'Lite echoes must already be restored');
          assertEquals(frame.event.response.tools, undefined);
          assertEquals(frame.event.response.created_at, undefined, 'resource completion must still be pending');
          const rows = await repo.openaiResponsesItems.lookupMany(API_KEY_ID, ['fc_lite'], 0);
          assertEquals(rows.length, 1);
          assertEquals(rows[0]?.payload.item, { type: 'function_call', id: 'fc_lite', name: 'read', namespace: 'files', call_id: 'call_lite', arguments: '{}', status: 'completed' });
          const snapshot = await repo.openaiResponsesSnapshots.lookup(API_KEY_ID, frame.event.response.id, 0);
          assert(snapshot !== null, 'snapshot must commit before client echo/schema egress');
          checked++;
        }
        yield frame;
      }
    })();
    return originalWrap(observed, sources);
  });
  queueResolution([makeCandidate({
    callOpenAIResponses: async () => ({
      action: 'generate', ok: true, modelKey: 'test-model-key',
      events: makeProviderEvents(openaiResponsesResultToEvents({
        ...makeOpenAIResponsesResult(), tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'function', name: 'read' }] }], instructions: 'lifted',
        output: [{ type: 'function_call', id: 'fc_lite', name: 'read', namespace: 'files', call_id: 'call_lite', arguments: '{}', status: 'completed' }],
      }).map(frame => frame.event)),
    }),
  })]);
  try {
    const response = await makeApp().request('/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'test-model', input: [{ type: 'additional_tools', role: 'developer', tools: [] }, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'lifted' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } }] }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assertEquals(missingRequiredResourceKeys(body), []);
    assertEquals(body.tools, []);
    assertEquals(body.instructions, null);
    assertEquals(checked, 1);
  } finally { completion.mockRestore(); }
});

for (const action of ['generate', 'compact'] as const) {
  test(`Responses Lite ${action} preserves upstream API-error status, bytes and headers without a success marker`, async () => {
    installRepo();
    const bytes = new Uint8Array([0, 255, 31, 10, 128]);
    queueResolution([makeCandidate({
      callOpenAIResponses: async () => ({
        action, ok: false, response: new Response(bytes, { status: 409, headers: { 'content-type': 'application/octet-stream', 'x-upstream-error': 'kept' } }), modelKey: 'test-model-key',
      }),
    })]);
    const response = await makeApp().request(action === 'compact' ? '/v1/responses/compact' : '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'test-model', input: [{ type: 'additional_tools', role: 'developer', tools: [] }] }),
    });
    assertEquals(response.status, 409);
    assertEquals(response.headers.get('x-upstream-error'), 'kept');
    assertEquals(response.headers.get('content-type'), 'application/octet-stream');
    assertEquals(response.headers.get('x-openai-internal-codex-responses-lite'), null);
    assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
  });
}
