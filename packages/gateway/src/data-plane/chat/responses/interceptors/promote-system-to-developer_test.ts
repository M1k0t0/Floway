import { test } from 'vitest';

import { withPromoteSystemToDeveloper } from './promote-system-to-developer.ts';
import type { ResponsesInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import { MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from '../items/store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
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

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['promote-system-to-developer'])): ResponsesInvocation => ({
  payload,
  candidate: stubProviderCandidate({ model: { enabledFlags } }),
  targetApi: 'responses',
  store: new LayeredStatefulResponsesStore({
    apiKeyId: 'test-key',
    reads: [new MemoryStatefulResponsesBacking()],
    itemWrites: [],
    snapshotWrites: [],
    stageInputs: false,
  }),
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

test('passes string input through unchanged', async () => {
  const input = invocation({
    model: 'gpt-5.4',
    input: 'hello world',
  });

  const original = input.payload;
  await withPromoteSystemToDeveloper(input, stubCtx, okEvents);

  assertEquals(input.payload, original);
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
