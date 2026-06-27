import { test } from 'vitest';

import { injectSessionId } from './inject-session-id.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER } from '../../responses-state.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload, headers: Headers = new Headers()): ResponsesBoundaryCtx => ({
  payload,
  headers,
  model: stubUpstreamModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('derives a stable session-id from instructions and the first input item', async () => {
  // Two turns of the same conversation: the second carries the original
  // first user message plus more tail items. The derived id must stay put.
  const turn1 = invocation({
    model: 'gpt-test',
    instructions: 'You are helpful.',
    input: [{ type: 'message', role: 'user', content: 'hello' }],
  });
  const turn2 = invocation({
    model: 'gpt-test',
    instructions: 'You are helpful.',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'assistant', content: 'hi' },
      { type: 'message', role: 'user', content: 'continue' },
    ],
  });

  await injectSessionId(turn1, stubRequest, okEvents);
  await injectSessionId(turn2, stubRequest, okEvents);

  const sessionId = turn1.headers.get('session-id');
  assert(sessionId !== null && UUID_RE.test(sessionId), `expected UUID, got ${sessionId}`);
  assertEquals(turn2.headers.get('session-id'), sessionId);
});

test('derives different session-ids for different system instructions', async () => {
  const a = invocation({ model: 'gpt-test', input: 'hello', instructions: 'You are pirate.' });
  const b = invocation({ model: 'gpt-test', input: 'hello', instructions: 'You are scientist.' });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assert(a.headers.get('session-id') !== b.headers.get('session-id'), 'expected distinct session-ids');
});

test('derives different session-ids for different first input items', async () => {
  const a = invocation({ model: 'gpt-test', input: 'topic A', instructions: 'Sys.' });
  const b = invocation({ model: 'gpt-test', input: 'topic B', instructions: 'Sys.' });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assert(a.headers.get('session-id') !== b.headers.get('session-id'), 'expected distinct session-ids');
});

test('derives a stable session-id when the input leads with a non-message item (e.g. compaction snapshot)', async () => {
  // Post-compaction stateful flow: the snapshot's compaction blob lands at
  // position 0 with no preceding user message. Hashing must still produce
  // the same id on every subsequent turn that replays from the same
  // snapshot, otherwise the new window's prompt cache resets every turn.
  const turn1 = invocation({
    model: 'gpt-test',
    instructions: 'Sys.',
    input: [
      { type: 'compaction', id: 'cmp_a', encrypted_content: 'ENC' } as unknown as ResponsesPayload['input'] extends Array<infer X> ? X : never,
      { type: 'message', role: 'assistant', content: 'retained' },
      { type: 'message', role: 'user', content: 'first post-compact turn' },
    ],
  });
  const turn2 = invocation({
    model: 'gpt-test',
    instructions: 'Sys.',
    input: [
      { type: 'compaction', id: 'cmp_a', encrypted_content: 'ENC' } as unknown as ResponsesPayload['input'] extends Array<infer X> ? X : never,
      { type: 'message', role: 'assistant', content: 'retained' },
      { type: 'message', role: 'user', content: 'first post-compact turn' },
      { type: 'message', role: 'assistant', content: 'reply' },
      { type: 'message', role: 'user', content: 'second post-compact turn' },
    ],
  });

  await injectSessionId(turn1, stubRequest, okEvents);
  await injectSessionId(turn2, stubRequest, okEvents);

  const sessionId = turn1.headers.get('session-id');
  assert(sessionId !== null && UUID_RE.test(sessionId), `expected UUID, got ${sessionId}`);
  assertEquals(turn2.headers.get('session-id'), sessionId);
});

test('falls back to a fresh UUIDv7 when the input array is empty', async () => {
  const a = invocation({ model: 'gpt-test', input: [] });
  const b = invocation({ model: 'gpt-test', input: [] });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  const sessionA = a.headers.get('session-id');
  const sessionB = b.headers.get('session-id');
  assert(sessionA !== null && UUID_V7_RE.test(sessionA), `expected UUIDv7, got ${sessionA}`);
  assert(sessionB !== null && UUID_V7_RE.test(sessionB), `expected UUIDv7, got ${sessionB}`);
  assert(sessionA !== sessionB, 'expected fresh fallback ids to differ between requests');
});

test('honors a client-supplied session-id (hyphen form) without overwriting', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({ 'session-id': 'client-supplied' }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'client-supplied');
});

test('prefers a Floway-owned internal session id over downstream session headers', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({
    [FLOWAY_CODEX_SESSION_ID_HEADER]: 'floway-internal',
    'session-id': 'client-supplied',
    session_id: 'alias',
  }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'floway-internal');
  assertEquals(ctx.headers.get('session_id'), null);
});

test('canonicalizes a client-supplied session_id alias when session-id is absent', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({ session_id: 'client-supplied' }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'client-supplied');
  assertEquals(ctx.headers.get('session_id'), null);
});

test('prefers session-id over a client-supplied session_id alias', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi' }, new Headers({
    'session-id': 'canonical',
    session_id: 'alias',
  }));

  await injectSessionId(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('session-id'), 'canonical');
  assertEquals(ctx.headers.get('session_id'), null);
});
