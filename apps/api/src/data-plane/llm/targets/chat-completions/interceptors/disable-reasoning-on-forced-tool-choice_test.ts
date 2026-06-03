import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { chatCompletionsInvocation, stubRequestContext } from './test-helpers.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const emitInput = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice'])): ReturnType<typeof chatCompletionsInvocation> =>
  chatCompletionsInvocation(payload, enabledFlags);

test('chat completions required tool_choice sets reasoning_effort to none', async () => {
  const input = emitInput({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

  assertEquals(input.payload.reasoning_effort, 'none');
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
  assertEquals(out.enable_thinking, undefined);
});

test('chat completions object tool_choice is forced', async () => {
  const input = emitInput({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: { type: 'function', function: { name: 'x' } },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

  assertEquals(input.payload.reasoning_effort, 'none');
});

test('chat completions non-forced tool_choice leaves reasoning untouched', async () => {
  for (const tool_choice of ['auto', 'none', null] as const) {
    const input = emitInput({
      model: 'm',
      messages: [],
      reasoning_effort: 'high',
      tool_choice,
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubRequestContext, okEvents);

    assertEquals(input.payload.reasoning_effort, 'high');
  }
});
