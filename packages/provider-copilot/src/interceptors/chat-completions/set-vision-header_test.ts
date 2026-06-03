import { test } from 'vitest';

import { withVisionHeaderSet } from './set-vision-header.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatCompletionsInvocation, InterceptorRequest, ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest: InterceptorRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('Chat Completions vision header set when an image_url content part is present', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['copilot-vision-request'], 'true');
});

test('Chat Completions vision header absent when content is pure text', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'plain string content' },
      { role: 'user', content: [{ type: 'text', text: 'array text only' }] },
    ],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals('copilot-vision-request' in ctx.headers, false);
});
