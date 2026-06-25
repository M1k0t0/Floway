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
});

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('injects a UUIDv7 session-id header when none is set', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hi', instructions: 'You are helpful.' });

  await injectSessionId(ctx, stubRequest, okEvents);

  const sessionId = ctx.headers.get('session-id');
  assert(sessionId !== null && UUID_V7_RE.test(sessionId), `expected UUIDv7, got ${sessionId}`);
});

test('generates a fresh session-id when the caller does not provide one', async () => {
  const a = invocation({ model: 'gpt-test', input: 'first turn', instructions: 'Sys prompt.' });
  const b = invocation({
    model: 'gpt-test',
    instructions: 'Sys prompt.',
    input: [
      { type: 'message', role: 'user', content: 'first turn' },
      { type: 'message', role: 'assistant', content: 'something earlier' },
      { type: 'message', role: 'user', content: 'second turn' },
    ],
  });

  await injectSessionId(a, stubRequest, okEvents);
  await injectSessionId(b, stubRequest, okEvents);

  assert(a.headers.get('session-id')?.match(UUID_V7_RE));
  assert(b.headers.get('session-id')?.match(UUID_V7_RE));
  assert(a.headers.get('session-id') !== b.headers.get('session-id'), 'expected distinct session-ids');
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
