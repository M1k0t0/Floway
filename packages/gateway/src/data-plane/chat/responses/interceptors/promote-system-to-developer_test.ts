import { test } from 'vitest';

import { withPromoteSystemToDeveloper } from './promote-system-to-developer.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  responseHeaders: new Headers(),
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (
  payload: CanonicalResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set<FlagId>(['promote-system-to-developer']),
  targetApi: ResponsesInvocation['targetApi'] = 'responses',
): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi,
  headers: new Headers(),
  action: 'generate',
});

test('rewrites inline system role to developer on input messages', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content: 'inline instructions' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string; content: unknown }>;
  assertEquals(items[0].role, 'user');
  assertEquals(items[1].role, 'developer');
  assertEquals(items[1].content, 'inline instructions');
});

test('promotes every system message for non-native Responses targets', async () => {
  const input = invocation(
    {
      model: 'gpt-5.4',
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
    },
    new Set<FlagId>(['promote-system-to-developer']),
    'chat-completions',
  );

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string; content: unknown }>;
  assertEquals(items[0].role, 'developer');
  assertEquals(items[0].content, 'base instructions');
  assertEquals(items[1].role, 'user');
});

test('preserves leading system prefix for native Responses targets', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'system', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content: 'inline instructions' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string; content: unknown }>;
  assertEquals(items[0].role, 'system');
  assertEquals(items[0].content, 'base instructions');
  assertEquals(items[1].role, 'user');
  assertEquals(items[2].role, 'developer');
  assertEquals(items[2].content, 'inline instructions');
});

test('leaves developer role untouched on input messages', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'developer', content: 'developer instructions' },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string }>;
  assertEquals(items[0].role, 'developer');
});

test('leaves non-message input items untouched', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content: 'instructions' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ type: string; role?: string }>;
  assertEquals(items[0].type, 'message');
  assertEquals(items[0].role, 'user');
  assertEquals(items[1].type, 'message');
  assertEquals(items[1].role, 'developer');
  assertEquals(items[2].type, 'function_call_output');
});

test('early-returns when flag is not set', async () => {
  const input = invocation(
    {
      model: 'gpt-5.4',
      input: [
        { type: 'message', role: 'system', content: 'instructions' },
      ],
    },
    new Set(),
  );

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string }>;
  assertEquals(items[0].role, 'system');
});
