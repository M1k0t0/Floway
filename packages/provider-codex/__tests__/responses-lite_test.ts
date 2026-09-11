import { describe, expect, test } from 'vitest';

import {
  encodeCodexResponsesLiteRequest,
  restoreCodexResponsesCompactionResult,
  restoreCodexResponsesEvent,
  restoreCodexResponsesFrames,
  restoreCodexResponsesResult,
  type CodexResponsesBody,
} from '../src/responses-lite.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesInputAdditionalToolsItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const requestBody = (overrides: Partial<CodexResponsesBody> = {}): CodexResponsesBody => ({
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});
const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({
  type: 'function', name, description: `${name} description`, parameters: { type: 'object' },
});
const customTool = (name: string): Extract<OpenAIResponsesTool, { type: 'custom' }> => ({
  type: 'custom', name, description: `${name} description`,
});
const additionalTools = (id: string, tools: OpenAIResponsesTool[]): OpenAIResponsesInputAdditionalToolsItem => ({
  type: 'additional_tools', role: 'developer', id, tools,
});
const itemId = (item: OpenAIResponsesInputItem | undefined): string | null | undefined =>
  item !== undefined && 'id' in item ? item.id : undefined;
const response = (overrides: Partial<OpenAIResponsesResult> = {}): OpenAIResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'model', output: [], status: 'completed', incomplete_details: null, error: null,
  ...overrides,
});

describe('Standard to Responses Lite encoder', () => {
  test('relocates all declarations in order, retains duplicates and leaves the original request intact', () => {
    const duplicate = functionTool('flat_function');
    const body = requestBody({
      instructions: 'Base instructions',
      tools: [
        { type: 'web_search', external_web_access: true },
        duplicate,
        customTool('flat_custom'),
        { type: 'namespace', name: 'functions', description: 'Caller functions', tools: [functionTool('nested_function')] },
        { type: 'namespace', name: 'database', description: 'Database tools', tools: [customTool('query')] },
      ],
      input: [
        additionalTools('at_first', [duplicate]),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_later', [functionTool('additional_function')]),
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'concise' },
    });
    const original = structuredClone(body);
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread').body;
    expect(encoded).not.toHaveProperty('tools');
    expect(encoded).not.toHaveProperty('instructions');
    expect(encoded.parallel_tool_calls).toBe(false);
    expect(encoded.reasoning).toEqual({ effort: 'high', summary: 'concise', context: 'all_turns' });
    expect(encoded.input[0]).toEqual({
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [
        body.tools![0],
        {
          type: 'namespace', name: 'functions', description: 'Caller functions',
          tools: [duplicate, customTool('flat_custom'), functionTool('nested_function'), duplicate, functionTool('additional_function')],
        },
        body.tools![4],
      ],
    });
    expect(encoded.input[1]).toEqual({
      type: 'message', role: 'developer', id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      content: [{ type: 'input_text', text: 'Base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect(encoded.input.slice(2)).toEqual([body.input[1]]);
    expect(body).toEqual(original);
  });

  test('encodes a leading Standard additional_tools carrier rather than inferring native Lite', () => {
    const body = requestBody({ input: [additionalTools('at_standard', [functionTool('lookup')])] });
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
    expect(encoded.body.input).toEqual([{
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('lookup')] }],
    }]);
    expect(itemId(encoded.body.input[0])).not.toBe('at_standard');
    expect(encoded.callableIdentities.byWireName.size).toBe(1);
  });

  test.each([undefined, null, ''])('emits an empty tools carrier without empty instructions %s', instructions => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ instructions }), 'thread').body;
    expect(encoded.input).toHaveLength(2);
    expect(encoded.input[0]).toMatchObject({ type: 'additional_tools', tools: [] });
    expect(encoded).not.toHaveProperty('instructions');
  });

  test('generates stable thread-scoped IDs and keeps historical calls unchanged', () => {
    const body = requestBody({ instructions: 'Stable', tools: [functionTool('lookup'), customTool('shell')] });
    const history: OpenAIResponsesInputItem[] = [
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'shell', namespace: 'functions', input: 'ls' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' },
    ];
    const first = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input;
    const retry = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input;
    const nextTurn = encodeCodexResponsesLiteRequest({ ...body, input: [...body.input, ...history] }, 'thread-a').body.input;
    const otherThread = encodeCodexResponsesLiteRequest(body, 'thread-b').body.input;
    expect(retry.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(nextTurn.slice(0, 2)).toEqual(first.slice(0, 2));
    history.forEach((item, index) => expect(nextTurn[index + 3]).toBe(item));
    expect(itemId(otherThread[0])).not.toBe(itemId(first[0]));
    expect(itemId(otherThread[1])).not.toBe(itemId(first[1]));
    const changed = encodeCodexResponsesLiteRequest({ ...body, instructions: 'Changed' }, 'thread-a').body.input;
    expect(itemId(changed[0])).toBe(itemId(first[0]));
    expect(itemId(changed[1])).not.toBe(itemId(first[1]));
  });

  test('only strips image detail on message and callable-output content paths', () => {
    const text = { type: 'input_text' as const, text: 'hello' };
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,x', detail: 'high' as const };
    const schemaImage = { type: 'input_image', detail: 'schema-value' };
    const metadataImage = { type: 'input_image', detail: 'metadata-value' };
    const message = {
      type: 'message' as const, role: 'user' as const, content: [text, image],
      internal_chat_message_metadata_passthrough: { image: metadataImage },
    };
    const opaque = { type: 'future_item', image: metadataImage, encrypted_content: 'opaque' } as unknown as OpenAIResponsesInputItem;
    const input: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [text] },
      { type: 'function_call_output', call_id: 'c1', output: [text] },
      { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: image.image_url }] },
      message,
      { type: 'function_call_output', call_id: 'c3', output: [image] },
      { type: 'custom_tool_call_output', call_id: 'c4', output: [image] },
      opaque,
    ];
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input, tools: [{ ...functionTool('inspect'), parameters: { examples: [schemaImage] } }],
    }), 'thread').body;
    for (let index = 0; index < 3; index++) expect(encoded.input[index + 1]).toBe(input[index]);
    for (let index = 3; index < 6; index++) expect(encoded.input[index + 1]).not.toBe(input[index]);
    expect(encoded.input[4]).toEqual({
      ...message, content: [text, { type: 'input_image', image_url: image.image_url }],
    });
    expect(encoded.input[5]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.input[6]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] });
    expect(encoded.input[7]).toBe(opaque);
    expect(encoded.input[0]).toMatchObject({ tools: [{ tools: [{ parameters: { examples: [schemaImage] } }] }] });
    expect(image.detail).toBe('high');
  });

  test.each([
    'auto', 'required', 'future_choice',
    { type: 'function', name: 'lookup' },
    { type: 'custom', name: 'query', namespace: 'database' },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'query', namespace: 'database' }] },
  ] as CodexResponsesBody['tool_choice'][])('preserves tool_choice without speculative wire rewrites: %j', tool_choice => {
    const body = requestBody({ tool_choice, tools: [functionTool('lookup')] });
    expect(encodeCodexResponsesLiteRequest(body, 'thread').body.tool_choice).toBe(tool_choice);
  });

  test.each(['function', 'custom'] as const)('rejects a flat callable colliding with a namespaced %s', type => {
    const child = type === 'function' ? functionTool('foo') : customTool('foo');
    expect(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('foo'), { type: 'namespace', name: 'functions', description: '', tools: [child] }],
    }), 'thread')).toThrow('Codex Responses Lite cannot preserve distinct callable identities for ["functions","foo"]');
  });
});

describe('Responses Lite inverse repair', () => {
  test.each(['response.queued', 'response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'] as const)(
    'restores Standard request echoes on %s without changing other fields', type => {
      const body = requestBody({
        tools: [functionTool('lookup')], instructions: 'Base', parallel_tool_calls: true,
        reasoning: { effort: 'future_effort', context: 'current_turn' }, tool_choice: 'auto',
      });
      const encoded = encodeCodexResponsesLiteRequest(body, 'thread');
      const wire = {
        ...response({
          tools: [], instructions: null, parallel_tool_calls: false, reasoning: { context: 'all_turns' }, tool_choice: 'auto',
          service_tier: 'future_tier',
        }),
        future: { untouched: true },
      };
      const restored = restoreCodexResponsesResult(wire, encoded.callableIdentities, encoded.requestEchoes);
      expect(restored).toEqual({ ...wire, ...encoded.requestEchoes });
      expect(restored.tools).toBe(body.tools);
      expect(restored.tool_choice).toBe('auto');
      expect(restoreCodexResponsesEvent({ type, response: wire }, encoded.callableIdentities, encoded.requestEchoes)).toEqual({ type, response: restored });
      expect(wire.parallel_tool_calls).toBe(false);
    },
  );

  test('removes only encoder-created echoes absent from the Standard request', () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody(), 'thread');
    const restored = restoreCodexResponsesResult(response({
      instructions: null, tools: [], parallel_tool_calls: false, reasoning: { context: 'all_turns' }, tool_choice: 'auto',
    }), encoded.callableIdentities, encoded.requestEchoes);
    for (const field of ['instructions', 'tools', 'parallel_tool_calls', 'reasoning']) expect(restored).not.toHaveProperty(field);
    expect(restored.tool_choice).toBe('auto');
  });

  test('repairs namespace and function/custom identity on items, results, compact and frames', async () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      tools: [
        functionTool('lookup'), customTool('shell'),
        { type: 'namespace', name: 'database', description: '', tools: [customTool('query')] },
      ],
    }), 'thread');
    const wire: OpenAIResponsesOutputItem[] = [
      { type: 'custom_tool_call', id: 'c1', call_id: 'c1', name: 'lookup', namespace: 'functions', input: '{}' },
      { type: 'function_call', id: 'c2', call_id: 'c2', name: 'shell', namespace: 'functions', arguments: 'ls', status: 'completed' },
      { type: 'function_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', arguments: 'select', status: 'completed' },
      { type: 'function_call', id: 'c4', call_id: 'c4', name: 'future', namespace: 'unknown', arguments: 'opaque', status: 'completed' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted+opaque==' },
      { type: 'future_output', encrypted_content: 'future+opaque==', extra: { value: true } } as unknown as OpenAIResponsesOutputItem,
    ];
    const expected = [
      { type: 'function_call', id: 'c1', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', id: 'c2', call_id: 'c2', name: 'shell', input: 'ls', status: 'completed' },
      { type: 'custom_tool_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', input: 'select', status: 'completed' },
      ...wire.slice(3),
    ];
    for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
      wire.forEach((item, output_index) => expect(restoreCodexResponsesEvent({ type, output_index, item }, encoded.callableIdentities)).toEqual({
        type, output_index, item: expected[output_index],
      }));
    }
    expect(restoreCodexResponsesResult(response({ output: wire }), encoded.callableIdentities).output).toEqual(expected);
    const compact = { id: 'cmp_1', object: 'response.compaction', output: wire, future: 'retained' };
    expect(restoreCodexResponsesCompactionResult(compact, encoded.callableIdentities)).toEqual({ ...compact, output: expected });
    const future = { type: 'response.future', response: { output: wire, tools: ['opaque'] }, extra: 'retained' } as unknown as OpenAIResponsesStreamEvent;
    expect(restoreCodexResponsesEvent(future, encoded.callableIdentities, encoded.requestEchoes)).toBe(future);
    const done = { type: 'done' } as const;
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: wire[0]! } };
      yield { type: 'event', event: future };
      yield done;
    })();
    const restored: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
    for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities, encoded.requestEchoes)) restored.push(frame);
    expect(restored[0]).toMatchObject({ type: 'event', event: { item: expected[0] } });
    expect(restored[1]).toEqual({ type: 'event', event: future });
    expect(restored[2]).toBe(done);
  });
});
