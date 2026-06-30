import { test } from 'vitest';

import { withPromoteSystemToDeveloper } from './promote-system-to-developer.ts';
import type { ChatCompletionsInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

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

const invocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['promote-system-to-developer'])): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

test('rewrites system role to developer on messages', async () => {
  const ctx = invocation({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'inline instructions' },
      { role: 'user', content: 'hello' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withPromoteSystemToDeveloper(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'developer');
  assertEquals(observed!.messages[0].content, 'inline instructions');
  assertEquals(observed!.messages[1].role, 'user');
});

test('leaves developer role untouched', async () => {
  const ctx = invocation({
    model: 'gpt-5.4',
    messages: [
      { role: 'developer', content: 'developer instructions' },
      { role: 'user', content: 'hello' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withPromoteSystemToDeveloper(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'developer');
  assertEquals(observed!.messages[0].content, 'developer instructions');
});

test('leaves assistant and tool roles untouched', async () => {
  const ctx = invocation({
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withPromoteSystemToDeveloper(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'user');
  assertEquals(observed!.messages[1].role, 'assistant');
  assertEquals(observed!.messages[2].role, 'tool');
});

test('early-returns when flag is not set', async () => {
  const ctx = invocation(
    {
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'inline instructions' },
        { role: 'user', content: 'hello' },
      ],
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withPromoteSystemToDeveloper(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.messages[0].role, 'system');
});
