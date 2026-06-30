import { test } from 'vitest';

import { withPromoteSystemToDeveloper } from './promote-system-to-developer.ts';
import type { ResponsesInvocation } from './types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import { eventResult } from '@floway-dev/provider';
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

const invocation = (payload: CanonicalResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['promote-system-to-developer'])): ResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'responses',
  headers: new Headers(),
  action: 'generate',
});

test('rewrites system role to developer on input messages', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'system', content: 'inline instructions' },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ role: string; content: unknown }>;
  assertEquals(items[0].role, 'developer');
  assertEquals(items[0].content, 'inline instructions');
  assertEquals(items[1].role, 'user');
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
      { type: 'message', role: 'system', content: 'instructions' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  });

  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  const items = input.payload.input as Array<{ type: string; role?: string }>;
  assertEquals(items[0].type, 'message');
  assertEquals(items[0].role, 'developer');
  assertEquals(items[1].type, 'function_call_output');
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
