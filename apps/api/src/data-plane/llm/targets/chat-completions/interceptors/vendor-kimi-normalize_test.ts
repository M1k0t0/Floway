import { test } from 'vitest';

import { chatCompletionsInvocation, stubRequestContext } from './test-helpers.ts';
import { withVendorKimiChatCompletionsNormalize } from './vendor-kimi-normalize.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageRecord = (usage: NonNullable<ChatCompletionsStreamEvent['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

const exchangeCtx = (enabledFlags: ReadonlySet<string> = new Set(['vendor-kimi'])) => chatCompletionsInvocation({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] }, enabledFlags);

test('vendor-kimi rewrites flat cached_tokens into prompt_tokens_details.cached_tokens', async () => {
  const ctx = exchangeCtx();
  const result = await withVendorKimiChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame({
            id: 'x',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'kimi-test',
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cached_tokens: 50,
            } as unknown as ChatCompletionsStreamEvent['usage'],
          });
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 50 });
  assertEquals('cached_tokens' in usage, false);
});

test('vendor-kimi early-returns when its flag is not set on the binding', async () => {
  const ctx = exchangeCtx(new Set());
  const result = await withVendorKimiChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame({
            id: 'x',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'kimi-test',
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              cached_tokens: 50,
            } as unknown as ChatCompletionsStreamEvent['usage'],
          });
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.cached_tokens, 50);
  assertEquals('prompt_tokens_details' in usage, false);
});
