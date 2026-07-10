import { test } from 'vitest';

import { hoistLeadingDeveloperToInstructions } from './hoist-leading-developer-to-instructions.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test', headers: new Headers() });

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

test('hoists leading developer messages into instructions and removes them from input', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'developer', content: 'base A' },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'base B' }, { type: 'input_text', text: 'base C' }],
      },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await hoistLeadingDeveloperToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'base A\n\nbase B\n\nbase C');
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'hello' },
  ]);
});

test('appends hoisted developer prefix after existing instructions', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    instructions: 'canonical instructions',
    input: [
      { type: 'message', role: 'developer', content: 'source prefix' },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await hoistLeadingDeveloperToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'canonical instructions\n\nsource prefix');
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'hello' },
  ]);
});

test('leaves non-leading developer messages in the input history', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'developer', content: 'inline instruction' },
    ],
  });

  await hoistLeadingDeveloperToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, undefined);
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'developer', content: 'inline instruction' },
  ]);
});

test('stops before leading developer content that cannot be represented as instructions text', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' }],
      },
      { type: 'message', role: 'user', content: 'hello' },
    ],
  });

  await hoistLeadingDeveloperToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, undefined);
  assertEquals(ctx.payload.input, [
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' }],
    },
    { type: 'message', role: 'user', content: 'hello' },
  ]);
});

test('leaves string input payloads unchanged', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello' });

  await hoistLeadingDeveloperToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: 'hello' });
});
