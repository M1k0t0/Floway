import { test } from 'vitest';

import { withImageGenerationStripped } from './strip-image-generation.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import { assertEquals, assertFalse, stubProviderModel } from '@floway-dev/test-utils';

const apply = async (payload: CanonicalResponsesPayload): Promise<void> => {
  const ctx: ResponsesBoundaryCtx = {
    payload,
    headers: new Headers(),
    model: stubProviderModel({ endpoints: { responses: {} } }),
    action: 'generate',
  };
  await withImageGenerationStripped(ctx, {}, async () => undefined);
};

test('removes image_generation tools', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [
      { type: 'image_generation' },
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
    ],
    tool_choice: 'auto',
  } as CanonicalResponsesPayload;

  await apply(payload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, 'function');
  assertEquals(payload.tool_choice, 'auto');
});

test('removes forced image_generation tool_choice', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: { type: 'image_generation' },
  } as CanonicalResponsesPayload;

  await apply(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('removes required tool_choice when no tools remain', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'draw this' }],
    tools: [{ type: 'image_generation' }],
    tool_choice: 'required',
  } as CanonicalResponsesPayload;

  await apply(payload);

  assertFalse('tools' in payload);
  assertFalse('tool_choice' in payload);
});

test('preserves Copilot-accepted hosted and deferred tools', async () => {
  // Codex uses `tool_search` and `namespace` for client-executed deferred tool
  // discovery and Copilot accepts `web_search`; the Copilot Responses target
  // must still see those entries even after image_generation is dropped.
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'search the web' }],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'web_search' },
      { type: 'tool_search', execution: 'x', description: 'y', parameters: {} },
      { type: 'namespace', name: 'ns', tools: [] },
      { type: 'image_generation', output_format: 'png' },
    ],
    tool_choice: 'auto',
  } as CanonicalResponsesPayload;

  await apply(payload);

  assertEquals(payload.tools?.map(tool => tool.type), ['function', 'web_search', 'tool_search', 'namespace']);
  assertEquals(payload.tool_choice, 'auto');
});

test('preserves forced non-image hosted and deferred tool_choices', async () => {
  for (const type of ['web_search', 'tool_search', 'namespace'] as const) {
    const payload = {
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: 'search' }],
      tools: [{ type }],
      tool_choice: { type },
    } as CanonicalResponsesPayload;

    await apply(payload);

    assertEquals(payload.tools, [{ type }]);
    assertEquals(payload.tool_choice, { type });
  }
});

test('preserves custom Freeform tools for downstream wrapping', async () => {
  const payload = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'do x' }],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
        strict: false,
      },
      { type: 'custom', name: 'freeform_other', description: 'x' },
    ],
    tool_choice: { type: 'custom', name: 'freeform_other' },
  } as CanonicalResponsesPayload;

  await apply(payload);

  assertEquals(payload.tools?.length, 2);
  assertEquals(payload.tools?.[1].type, 'custom');
  assertEquals(payload.tool_choice, { type: 'custom', name: 'freeform_other' });
});
