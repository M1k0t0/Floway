import { test, vi } from 'vitest';

import { createStoredResponsesItemId } from './items/format.ts';
import { createResponsesHttpStore, MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem, StoredResponsesSnapshot } from '../../../repo/types.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { directFetcher, FLOWAY_CODEX_SESSION_ID_HEADER, FLOWAY_CODEX_THREAD_ID_HEADER, FLOWAY_CODEX_TURN_ID_HEADER, FLOWAY_CODEX_WINDOW_ID_HEADER, type ProviderStreamResult, type UpstreamCallOptions, type UpstreamProviderKind } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

// `enumerateProviderCandidates` is the only seam between serve and the
// provider registry — mocking it directly keeps the serve tests narrow
// (no fake fetch, no repo upstream rows for provider catalogs) and lets
// each test hand the serve exactly the candidates it wants to exercise.
// `sawModel` defaults to true when at least one candidate was queued; the
// `model-missing` failure tests queue an empty list and expect `sawModel:
// false` so the serve renders 404 rather than 400.
const candidatesQueue: { readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }[] = [];
vi.mock('../shared/candidates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../shared/candidates.ts')>();
  return {
    ...original,
    enumerateProviderCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('serve_test: no candidates enqueued');
      return next;
    }),
  };
});

const { responsesServe } = await import('./serve.ts');
const { expandPreviousResponseId } = await import('./serve-prep.ts');

const API_KEY_ID = 'key_serve_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (): GatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
});

const makePayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'test-model',
  input: 'hello',
  ...overrides,
});

const makeResponsesResult = (id = 'resp_test'): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi' }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProtocolFrames = async function* <E>(events: readonly E[]): AsyncGenerator<ProtocolFrame<E>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  providerKind?: UpstreamProviderKind;
  targetApi?: ProviderCandidate['targetApi'];
  callResponses?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  callResponsesCompact?: (...args: unknown[]) => Promise<unknown>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const providerKind = overrides.providerKind ?? 'custom';
  const targetApi = overrides.targetApi ?? 'responses';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callResponses: overrides.callResponses,
    ...(overrides.callResponsesCompact !== undefined ? { callResponsesCompact: overrides.callResponsesCompact as never } : {}),
  });
  return {
    provider: {
      upstream,
      providerKind,
      name: upstream,
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream,
      upstreamName: upstream,
      providerKind,
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi,
    fetcher: directFetcher,
  };
};

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate routes a native Responses candidate end to end', async () => {
  installRepo();
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([completed]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callResponses });
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  assert(events.length >= 1);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('compact returns a result envelope from the wrapped attempt', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponsesCompact = vi.fn(async () => ({
    ok: true as const,
    result: compactionResult,
    modelKey: 'test-model-key',
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callResponsesCompact });
  queueCandidates([candidate]);

  const result = await responsesServe.compact({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'kept' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(callResponsesCompact.mock.calls.length, 1);
});

test('generate stops at the first candidate even when it yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult('resp_second'),
  };
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames([completed]), modelKey: 'second-key', headers: new Headers(),
  }));
  const first = makeCandidate({ upstream: 'up_a', callResponses: firstCall });
  const second = makeCandidate({ upstream: 'up_b', callResponses: secondCall });
  queueCandidates([first, second]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  // An upstream error from the first candidate IS the final answer — the
  // gateway does not retry on a different upstream just because the first one
  // produced an HTTP error.
  assertEquals(result.type, 'api-error');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 0);
});

test('generate carries Floway-owned Codex session and window ids across previous_response_id snapshots', async () => {
  const repo = installRepo();
  let turn = 0;
  const sessionIds: string[] = [];
  const threadIds: string[] = [];
  const turnIds: string[] = [];
  const windowIds: string[] = [];
  const callResponses = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    const sessionId = opts?.headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
    if (sessionId === null || !UUID_V7_RE.test(sessionId)) throw new Error(`expected internal Codex session id, got ${sessionId}`);
    const threadId = opts?.headers.get(FLOWAY_CODEX_THREAD_ID_HEADER);
    if (threadId !== sessionId) throw new Error(`expected generated Codex thread id ${sessionId}, got ${threadId}`);
    const turnId = opts?.headers.get(FLOWAY_CODEX_TURN_ID_HEADER);
    if (turnId === null || !UUID_V7_RE.test(turnId)) throw new Error(`expected internal Codex turn id, got ${turnId}`);
    const windowId = opts?.headers.get(FLOWAY_CODEX_WINDOW_ID_HEADER);
    if (windowId === null || !windowId.startsWith(`${threadId}:`)) throw new Error(`expected internal Codex window id for ${threadId}, got ${windowId}`);
    if (opts?.headers.get('x-codex-window-id') !== null) throw new Error('expected downstream x-codex-window-id marker to be scrubbed before provider dispatch');
    sessionIds.push(sessionId);
    threadIds.push(threadId);
    turnIds.push(turnId);
    windowIds.push(windowId);
    turn += 1;
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_upstream_${turn}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn1 = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'first turn' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({
      [FLOWAY_CODEX_SESSION_ID_HEADER]: 'forged-downstream-session',
      [FLOWAY_CODEX_THREAD_ID_HEADER]: 'forged-downstream-thread',
      [FLOWAY_CODEX_WINDOW_ID_HEADER]: 'forged-downstream-window',
      'x-codex-window-id': 'downstream-window-a',
    }),
  });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn1Snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, turn1ResponseId);
  assertEquals(turn1Snapshot?.metadata.codex_session_id, sessionIds[0]);
  assertEquals(turn1Snapshot?.metadata.codex_thread_id, threadIds[0]);
  assertEquals(windowIds[0], `${threadIds[0]}:0`);
  assertEquals(turn1Snapshot?.metadata.codex_window_id, windowIds[0]);
  assertEquals(turn1Snapshot?.metadata.codex_downstream_window_id, 'downstream-window-a');

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn2 = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: turn1ResponseId,
      input: [{ type: 'message', role: 'user', content: 'second turn' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({ 'x-codex-window-id': 'downstream-window-a' }),
  });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  const turn2Events = await collectEvents(turn2.events);
  const turn2ResponseId = (turn2Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn2Snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, turn2ResponseId);

  assertEquals(sessionIds.length, 2);
  assertEquals(sessionIds[1], sessionIds[0]);
  assertEquals(threadIds[1], threadIds[0]);
  assertEquals(windowIds[1], windowIds[0]);
  assertEquals(turn2Snapshot?.metadata.codex_window_id, windowIds[0]);
  assertEquals(turn2Snapshot?.metadata.codex_downstream_window_id, 'downstream-window-a');

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn3 = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: turn2ResponseId,
      input: [{ type: 'message', role: 'user', content: 'third turn' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({ 'x-codex-window-id': 'downstream-window-b' }),
  });
  if (turn3.type !== 'events') throw new Error('turn 3: expected events');
  const turn3Events = await collectEvents(turn3.events);
  const turn3ResponseId = (turn3Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn3Snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, turn3ResponseId);

  assertEquals(sessionIds.length, 3);
  assertEquals(sessionIds[2], sessionIds[0]);
  assertEquals(threadIds[2], threadIds[0]);
  assertEquals(turnIds.length, 3);
  assertEquals(windowIds[2], `${threadIds[0]}:1`);
  assertEquals(turn3Snapshot?.metadata.codex_window_id, windowIds[2]);
  assertEquals(turn3Snapshot?.metadata.codex_downstream_window_id, 'downstream-window-b');
});

test('generate preserves real Codex downstream session and thread ids for upstream prompt cache scope', async () => {
  const repo = installRepo();
  const sessionIds: string[] = [];
  const threadIds: string[] = [];
  const windowIds: string[] = [];
  const callResponses = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    const sessionId = opts?.headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
    const threadId = opts?.headers.get(FLOWAY_CODEX_THREAD_ID_HEADER);
    const windowId = opts?.headers.get(FLOWAY_CODEX_WINDOW_ID_HEADER);
    if (sessionId === null || threadId === null || windowId === null) throw new Error('expected internal Codex scope headers');
    if (opts?.headers.get('x-codex-window-id') !== null) throw new Error('expected downstream x-codex-window-id marker to be scrubbed before provider dispatch');
    sessionIds.push(sessionId);
    threadIds.push(threadId);
    windowIds.push(windowId);
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_codex_${sessionIds.length}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn1 = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'first Codex turn' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({
      'session-id': 'codex-client-session',
      'thread-id': 'codex-client-thread',
      'x-codex-window-id': 'codex-client-thread:0',
    }),
  });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn1Snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, turn1ResponseId);

  assertEquals(sessionIds[0], 'codex-client-session');
  assertEquals(threadIds[0], 'codex-client-thread');
  assertEquals(windowIds[0], 'codex-client-thread:0');
  assertEquals(turn1Snapshot?.metadata.codex_session_id, 'codex-client-session');
  assertEquals(turn1Snapshot?.metadata.codex_thread_id, 'codex-client-thread');
  assertEquals(turn1Snapshot?.metadata.codex_window_id, 'codex-client-thread:0');

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn2 = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: turn1ResponseId,
      input: [{ type: 'message', role: 'user', content: 'second Codex turn' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({
      'session-id': 'codex-client-session',
      'thread-id': 'codex-client-thread',
      'x-codex-window-id': 'codex-client-thread:0',
    }),
  });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  await collectEvents(turn2.events);

  assertEquals(sessionIds, ['codex-client-session', 'codex-client-session']);
  assertEquals(threadIds, ['codex-client-thread', 'codex-client-thread']);
  assertEquals(windowIds, ['codex-client-thread:0', 'codex-client-thread:0']);
});

test('generate ignores per-request x-client-request-id when no Codex thread-id is supplied', async () => {
  installRepo();
  const sessionIds: string[] = [];
  const threadIds: string[] = [];
  const windowIds: string[] = [];
  const callResponses = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    const sessionId = opts?.headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
    const threadId = opts?.headers.get(FLOWAY_CODEX_THREAD_ID_HEADER);
    const windowId = opts?.headers.get(FLOWAY_CODEX_WINDOW_ID_HEADER);
    if (sessionId === null || threadId === null || windowId === null) throw new Error('expected internal Codex scope headers');
    sessionIds.push(sessionId);
    threadIds.push(threadId);
    windowIds.push(windowId);
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_request_id_${sessionIds.length}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn1 = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'first request-id turn' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({
      'session-id': 'request-id-client-session',
      'x-client-request-id': 'request-id-1',
    }),
  });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn2 = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: turn1ResponseId,
      input: [{ type: 'message', role: 'user', content: 'second request-id turn' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers({
      'session-id': 'request-id-client-session',
      'x-client-request-id': 'request-id-2',
    }),
  });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  await collectEvents(turn2.events);

  assertEquals(sessionIds, ['request-id-client-session', 'request-id-client-session']);
  assertEquals(threadIds, ['request-id-client-session', 'request-id-client-session']);
  assertEquals(windowIds, ['request-id-client-session:0', 'request-id-client-session:0']);
});

test('generate synthesizes stable Codex scope for a generic Responses downstream without Codex headers', async () => {
  installRepo();
  const sessionIds: string[] = [];
  const threadIds: string[] = [];
  const windowIds: string[] = [];
  const callResponses = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    const sessionId = opts?.headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
    const threadId = opts?.headers.get(FLOWAY_CODEX_THREAD_ID_HEADER);
    const windowId = opts?.headers.get(FLOWAY_CODEX_WINDOW_ID_HEADER);
    if (sessionId === null || !UUID_V7_RE.test(sessionId)) throw new Error(`expected generated Codex session id, got ${sessionId}`);
    if (threadId !== sessionId) throw new Error(`expected generated Codex thread id ${sessionId}, got ${threadId}`);
    if (windowId !== `${threadId}:0`) throw new Error(`expected generated Codex window id ${threadId}:0, got ${windowId}`);
    sessionIds.push(sessionId);
    threadIds.push(threadId);
    windowIds.push(windowId);
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_generic_${sessionIds.length}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn1 = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'first generic turn' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;

  queueCandidates([makeCandidate({ providerKind: 'codex', callResponses })]);
  const turn2 = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: turn1ResponseId,
      input: [{ type: 'message', role: 'user', content: 'second generic turn' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  await collectEvents(turn2.events);

  assertEquals(sessionIds.length, 2);
  assertEquals(sessionIds[1], sessionIds[0]);
  assertEquals(threadIds, [sessionIds[0], sessionIds[0]]);
  assertEquals(windowIds, [`${threadIds[0]}:0`, `${threadIds[0]}:0`]);
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await responsesServe.generate({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('generate renders routing-unavailable as a 400 when a forcing item names an absent upstream', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  const row: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([row]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('compact renders routing-unavailable when no candidate exposes the responses endpoint', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  await repo.responsesItems.insertMany([{
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.compact({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('expandPreviousResponseId prepends snapshot items and strips the previous_response_id field', async () => {
  const repo = installRepo();
  const previousMessageId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: previousMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id: previousMessageId, role: 'user', content: 'first turn' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_prev',
    apiKeyId: API_KEY_ID,
    itemIds: [previousMessageId],
    metadata: {},
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesSnapshots.insert(snapshot);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const expanded = await expandPreviousResponseId(
    makePayload({
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'second turn' }],
    }),
    store,
  );

  assertEquals(expanded.previous_response_id, undefined);
  if (!Array.isArray(expanded.input)) throw new Error('expected expanded input array');
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id: previousMessageId });
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'second turn' });
});

// In-memory store backed by the layered implementation but with no repo
// behind it, so an `expandPreviousResponseId` test can sit on a snapshot
// that lives nowhere else.
const memoryStore = async (snapshots: readonly StoredResponsesSnapshot[], items: readonly StoredResponsesItem[]) => {
  const backing = new MemoryStatefulResponsesBacking();
  for (const item of items) await backing.insertItems([item], { durable: true });
  for (const snapshot of snapshots) await backing.insertSnapshot(snapshot);
  return new LayeredStatefulResponsesStore({
    apiKeyId: API_KEY_ID,
    reads: [backing],
    itemWrites: [{ backing, durable: true }],
    snapshotWrites: [{ backing, durable: true }],
    stageInputs: true,
    shouldStorePayload: true,
  });
};

test('expandPreviousResponseId resolves snapshots from a non-repo-backed store', async () => {
  installRepo(); // affinity lookups in the wider flow still need a repo, but here the helper only touches the store.
  const id = createStoredResponsesItemId('message');
  const item: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id, role: 'user', content: 'remembered' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_mem',
    apiKeyId: API_KEY_ID,
    itemIds: [id],
    metadata: {},
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const store = await memoryStore([snapshot], [item]);

  const expanded = await expandPreviousResponseId(
    makePayload({ previous_response_id: 'resp_mem', input: [{ type: 'message', role: 'user', content: 'new turn' }] }),
    store,
  );

  if (!Array.isArray(expanded.input)) throw new Error('expected expanded input array');
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id });
});

test('generate falls through translate-out to messages target', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        type: 'message_start',
        message: {
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
    modelKey: 'messages-key',
    headers: new Headers(),
  }));
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({ callMessages });
  const candidate: ProviderCandidate = {
    provider: {
      upstream: 'up_m', providerKind: 'custom', name: 'up_m',
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_m', upstreamName: 'up_m', providerKind: 'custom',
      provider, upstreamModel, enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'messages',
    fetcher: directFetcher,
  };
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate falls through translate-out to chat-completions target', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]),
    modelKey: 'chat-completions-key',
    headers: new Headers(),
  }));
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({ callChatCompletions });
  const candidate: ProviderCandidate = {
    provider: {
      upstream: 'up_c', providerKind: 'custom', name: 'up_c',
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_c', upstreamName: 'up_c', providerKind: 'custom',
      provider, upstreamModel, enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'chat-completions',
    fetcher: directFetcher,
  };
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate reuses an existing input row when a later turn echoes the same user message', async () => {
  const repo = installRepo();
  let turn = 0;
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    turn += 1;
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_turn_${turn}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const payload = makePayload({ input: [{ type: 'message', role: 'user', content: 'hello' }] });

  queueCandidates([makeCandidate({ callResponses })]);
  const turn1 = await responsesServe.generate({ payload, ctx: makeGatewayCtx(), store, headers: new Headers() });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);

  queueCandidates([makeCandidate({ callResponses })]);
  const turn2 = await responsesServe.generate({ payload, ctx: makeGatewayCtx(), store, headers: new Headers() });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  const turn2Events = await collectEvents(turn2.events);

  // Both snapshots' first item id is the staged user message; a working
  // content-hash preload makes turn 2 reuse turn 1's row instead of minting
  // a fresh one. Look up by the Floway-minted response id wrap puts on
  // each terminal event — the upstream's `resp_turn_N` id is discarded.
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn2ResponseId = (turn2Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const snap1 = await repo.responsesSnapshots.lookup(API_KEY_ID, turn1ResponseId);
  const snap2 = await repo.responsesSnapshots.lookup(API_KEY_ID, turn2ResponseId);
  if (snap1 === null || snap2 === null) throw new Error('expected both snapshots to be persisted');
  const turn1InputId = snap1.itemIds[0];
  const turn2InputId = snap2.itemIds[0];
  if (turn1InputId === undefined || turn2InputId === undefined) throw new Error('expected each snapshot to start with a staged input item');
  assertEquals(turn2InputId, turn1InputId);
});

test('generate treats compaction_trigger-bearing input as compaction: snapshot replaces prior history with the compaction output alone, trigger reaches the wire but never stores a row', async () => {
  const repo = installRepo();

  // Seed a prior conversation: one user message + a snapshot pointing at it.
  // The compacting turn references that snapshot via previous_response_id, so
  // generate without the trigger would normally append [prior items + this
  // turn's input + output] into the new snapshot. The trigger flips that to
  // 'replace' so the new snapshot only carries the compaction blob — the
  // whole point of compaction is to drop the prior history.
  const priorMessageId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: priorMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id: priorMessageId, role: 'user', content: 'old turn' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);
  await repo.responsesSnapshots.insert({
    id: 'resp_before_compact',
    apiKeyId: API_KEY_ID,
    itemIds: [priorMessageId],
    metadata: {},
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  let receivedInput: unknown = null;
  const callResponses = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    receivedInput = (body as { input: unknown }).input;
    return {
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: {
          ...makeResponsesResult(),
          output: [{ type: 'compaction', id: 'upstream_cmp_id', encrypted_content: 'ENC' }] as unknown as ResponsesResult['output'],
        },
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueCandidates([makeCandidate({ upstream: 'up_a', callResponses })]);

  const result = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: 'resp_before_compact',
      input: [{ type: 'compaction_trigger' }],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    headers: new Headers(),
  });

  if (result.type !== 'events') throw new Error('expected events');
  const events = await collectEvents(result.events);
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  const responseId = completed.response.id;

  // 'replace' semantics: only the new compaction row, no item_reference to
  // priorMessageId and no row for the trigger. (The test would also throw
  // outright at `stageInputItem` if the trigger early-return regressed,
  // since createStoredResponsesItemId('compaction_trigger') has no prefix.)
  const snap = await repo.responsesSnapshots.lookup(API_KEY_ID, responseId);
  if (snap === null) throw new Error('expected snapshot to be persisted');
  assertEquals(snap.itemIds.length, 1);
  const onlyItemId = snap.itemIds[0];
  if (onlyItemId === undefined) throw new Error('unreachable');
  assertEquals(onlyItemId.startsWith('cmp_'), true);

  // The trigger still reaches the upstream — the gateway only intercepts at
  // the storage seam, not on the wire. The expanded prefix puts item_reference
  // first, the trigger last.
  if (!Array.isArray(receivedInput)) throw new Error('expected the wire input to be an array');
  assertEquals((receivedInput.at(-1) as { type?: unknown })?.type, 'compaction_trigger');
});
