import { describe, expect, test } from 'vitest';

import {
  bridgeCodexResponsesRequest,
  downstreamRequestsCodexResponsesLite,
  restoreCodexResponsesCompactionResult,
  restoreCodexResponsesEvent,
  restoreCodexResponsesFrames,
  restoreCodexResponsesResult,
  type CodexResponsesBody,
} from '../src/responses-lite.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesCompactionResult,
  OpenAIResponsesInputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const requestBody = (overrides: Partial<CodexResponsesBody> = {}): CodexResponsesBody => ({
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

const functionTool = (name: string): OpenAIResponsesTool => ({
  type: 'function',
  name,
  description: `${name} description`,
  parameters: { type: 'object' },
});

const customTool = (name: string): OpenAIResponsesTool => ({
  type: 'custom',
  name,
  description: `${name} description`,
});

const additionalTools = (
  id: string,
  tools: OpenAIResponsesTool[],
): OpenAIResponsesInputItem => ({
  type: 'additional_tools',
  role: 'developer',
  id,
  tools,
});

const itemId = (item: OpenAIResponsesInputItem | undefined): string | null | undefined =>
  item !== undefined && 'id' in item ? item.id : undefined;

const taggedInstructions = (id: string, text: string): OpenAIResponsesInputItem => ({
  type: 'message',
  role: 'developer',
  id,
  content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: ['model.base_instructions'],
  },
});

describe('Responses Lite intent', () => {
  test('recognizes explicit HTTP and WebSocket Lite markers', () => {
    expect(downstreamRequestsCodexResponsesLite(
      new Headers({ 'x-openai-internal-codex-responses-lite': ' true ' }),
      requestBody(),
    )).toBe(true);
    expect(downstreamRequestsCodexResponsesLite(new Headers(), requestBody({
      client_metadata: {
        ws_request_header_x_openai_internal_codex_responses_lite: 'true',
      },
    } as Partial<CodexResponsesBody>))).toBe(true);
    expect(downstreamRequestsCodexResponsesLite(new Headers(), requestBody())).toBe(false);
  });

  test.each([undefined, 'false'])('keeps generic leading tools in standard mode with header %s', header => {
    const body = requestBody({
      instructions: 'Standard base',
      input: [additionalTools('at_existing', []), { type: 'message', role: 'user', content: 'hello' }],
    });
    const downstreamUsesLite = downstreamRequestsCodexResponsesLite(
      new Headers(header === undefined ? {} : { 'x-openai-internal-codex-responses-lite': header }),
      body,
    );
    expect(downstreamUsesLite).toBe(false);
    expect(bridgeCodexResponsesRequest(body, {
      threadId: 'thread', downstreamUsesLite, upstreamUsesLite: false,
    }).body).toEqual(body);
  });
});

describe('standard to Responses Lite', () => {
  test('relocates every tool and instruction carrier without losing declaration order', () => {
    const body = requestBody({
      instructions: 'Base instructions',
      tools: [
        { type: 'web_search', external_web_access: true },
        functionTool('flat_function'),
        customTool('flat_custom'),
        {
          type: 'namespace',
          name: 'functions',
          description: 'Caller functions',
          tools: [functionTool('nested_function') as Extract<OpenAIResponsesTool, { type: 'function' }>],
        },
        {
          type: 'namespace',
          name: 'database',
          description: 'Database tools',
          tools: [customTool('query') as Extract<OpenAIResponsesTool, { type: 'custom' }>],
        },
      ],
      input: [
        additionalTools('at_later', [functionTool('additional_function')]),
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,x', detail: 'high' }],
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,y', detail: 'low' }],
        },
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'concise' },
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: '11111111-2222-4333-8444-555555555555',
      downstreamUsesLite: true,
      upstreamUsesLite: true,
    }).body;

    expect(bridged.tools).toBeUndefined();
    expect(bridged.instructions).toBeUndefined();
    expect(bridged.parallel_tool_calls).toBe(false);
    expect(bridged.reasoning).toEqual({ effort: 'high', summary: 'concise', context: 'all_turns' });
    expect(bridged.input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' });
    expect((bridged.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>).id).toMatch(/^at_[0-9a-f-]{36}$/);
    expect(bridged.input[1]).toEqual(expect.objectContaining({
      type: 'message',
      role: 'developer',
      id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      content: [{ type: 'input_text', text: 'Base instructions' }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['model.base_instructions'],
      },
    }));

    const liteTools = (bridged.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>).tools;
    expect(liteTools.map(tool => tool.type)).toEqual(['web_search', 'namespace', 'namespace']);
    expect(liteTools[1]).toEqual({
      type: 'namespace',
      name: 'functions',
      description: 'Caller functions',
      tools: [
        functionTool('flat_function'),
        customTool('flat_custom'),
        functionTool('nested_function'),
        functionTool('additional_function'),
      ],
    });
    expect(liteTools[2]).toEqual({
      type: 'namespace',
      name: 'database',
      description: 'Database tools',
      tools: [customTool('query')],
    });
    expect(bridged.input).not.toContainEqual(expect.objectContaining({ type: 'additional_tools', id: 'at_later' }));
    expect(bridged.input[2]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }],
    });
    expect(bridged.input[3]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,y' }],
    });
  });

  test('normalizes image content without rewriting image-looking tool data or metadata', () => {
    const schemaImage = { type: 'input_image', detail: 'schema-value' };
    const metadataImage = { type: 'input_image', detail: 'metadata-value' };
    const body = requestBody({
      tools: [{
        type: 'function',
        name: 'inspect',
        parameters: {
          type: 'object',
          examples: [schemaImage],
        },
      }],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,x', detail: 'high' }],
          internal_chat_message_metadata_passthrough: {
            image: metadataImage,
          },
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,y', detail: 'low' }],
        },
      ],
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: false,
      upstreamUsesLite: true,
    }).body;
    const carrier = bridged.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>;
    const namespace = carrier.tools[0] as Extract<OpenAIResponsesTool, { type: 'namespace' }>;
    expect(namespace.tools[0]).toMatchObject({
      parameters: { examples: [schemaImage] },
    });
    expect(bridged.input[1]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }],
      internal_chat_message_metadata_passthrough: {
        image: metadataImage,
      },
    });
    expect(bridged.input[2]).toEqual({
      type: 'custom_tool_call_output',
      call_id: 'call_1',
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,y' }],
    });
  });

  test('keeps unchanged content containers and only copies image-detail paths', () => {
    const text = { type: 'input_text' as const, text: 'hello' };
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,x', detail: 'high' as const };
    const input: OpenAIResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [text] },
      { type: 'function_call_output', call_id: 'c1', output: [text] },
      { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: 'data:image/png;base64,x' }] },
      { type: 'message', role: 'user', content: [text, image] },
      { type: 'function_call_output', call_id: 'c3', output: [image] },
      { type: 'custom_tool_call_output', call_id: 'c4', output: [image] },
    ];
    const bridged = bridgeCodexResponsesRequest(requestBody({ input }), {
      threadId: 'thread', downstreamUsesLite: false, upstreamUsesLite: true,
    }).body;
    expect(input).toHaveLength(6);
    for (let index = 0; index < 3; index++) expect(bridged.input[index + 1]).toBe(input[index]);
    for (let index = 3; index < 6; index++) expect(bridged.input[index + 1]).not.toBe(input[index]);
    const changed = bridged.input[4] as Extract<OpenAIResponsesInputItem, { type: 'message' }>;
    expect(changed.content).toEqual([text, { type: 'input_image', image_url: image.image_url }]);
    if (!Array.isArray(changed.content)) throw new Error('expected array content');
    expect(changed.content[0]).toBe(text);
    expect(changed.content[1]).not.toBe(image);
    expect(image.detail).toBe('high');
  });

  test.each(['function', 'custom'] as const)('preserves historical %s call input across Lite turns', type => {
    const tool = type === 'function' ? functionTool('lookup') : customTool('lookup');
    const call: OpenAIResponsesInputItem = type === 'function'
      ? { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' }
      : { type: 'custom_tool_call', call_id: 'c1', name: 'lookup', input: 'hello' };
    const output: OpenAIResponsesInputItem = type === 'function'
      ? { type: 'function_call_output', call_id: 'c1', output: 'done' }
      : { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' };
    const body = requestBody({ tools: [tool] });
    const first = bridgeCodexResponsesRequest(body, {
      threadId: 'thread', downstreamUsesLite: false, upstreamUsesLite: true,
    });
    const second = bridgeCodexResponsesRequest({ ...body, input: [...body.input, call, output] }, {
      threadId: 'thread', downstreamUsesLite: false, upstreamUsesLite: true,
    });
    expect(second.body.input[0]).toEqual(first.body.input[0]);
    expect(second.body.input[2]).toBe(call);
    expect(second.body.input[3]).toBe(output);
  });

  test('generates stable thread-scoped IDs', () => {
    const body = requestBody({ instructions: 'Stable', tools: [functionTool('lookup')] });
    const first = bridgeCodexResponsesRequest(body, { threadId: 'thread-a', downstreamUsesLite: false, upstreamUsesLite: true }).body.input;
    const retry = bridgeCodexResponsesRequest(body, { threadId: 'thread-a', downstreamUsesLite: false, upstreamUsesLite: true }).body.input;
    const otherThread = bridgeCodexResponsesRequest(body, { threadId: 'thread-b', downstreamUsesLite: false, upstreamUsesLite: true }).body.input;

    expect(retry.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(itemId(otherThread[0])).not.toBe(itemId(first[0]));
    expect(itemId(otherThread[1])).not.toBe(itemId(first[1]));
  });

  test('preserves an existing valid Lite prefix and IDs while enforcing Lite controls', () => {
    const body = requestBody({
      input: [
        additionalTools('at_existing', [{ type: 'web_search', external_web_access: false }]),
        taggedInstructions('msg_existing', 'Existing base'),
        { type: 'message', role: 'user', content: 'hello' },
      ],
      reasoning: { effort: 'medium' },
      parallel_tool_calls: true,
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: true,
    }).body;
    expect(bridged.input[0]).toEqual(body.input[0]);
    expect(bridged.input[1]).toEqual(body.input[1]);
    expect(bridged.parallel_tool_calls).toBe(false);
    expect(bridged.reasoning).toEqual({ effort: 'medium', context: 'all_turns' });
  });

  test('keeps duplicate declarations when rebuilding a mixed standard/Lite request', () => {
    const duplicate = functionTool('duplicate');
    const body = requestBody({
      tools: [duplicate],
      input: [
        additionalTools('at_one', [duplicate]),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_two', [duplicate]),
      ],
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: true,
    }).body;
    const tools = (bridged.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>).tools;
    const namespace = tools[0] as Extract<OpenAIResponsesTool, { type: 'namespace' }>;
    expect(namespace.tools).toEqual([duplicate, duplicate, duplicate]);
    expect(bridged.input.filter(item => item.type === 'additional_tools')).toHaveLength(1);
  });

  test('consolidates later additional-tools carriers without top-level tools', () => {
    const first = functionTool('first');
    const second = customTool('second');
    const body = requestBody({
      input: [
        additionalTools('at_one', [first]),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_two', [second]),
      ],
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: true,
    }).body;
    const carriers = bridged.input.filter(item => item.type === 'additional_tools');
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
      tools: [{
        type: 'namespace',
        name: 'functions',
        tools: [first, second],
      }],
    });
    expect(bridged.input[1]).toEqual({ type: 'message', role: 'user', content: 'hello' });
  });
});

describe('Responses Lite to standard', () => {
  test('promotes all additional tools after top-level tools and lifts tagged base instructions', () => {
    const body = requestBody({
      tools: [functionTool('top')],
      input: [
        additionalTools('at_one', [customTool('first')]),
        taggedInstructions('msg_base', 'Lite base'),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_two', [functionTool('second')]),
      ],
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
      client_metadata: {
        ws_request_header_x_openai_internal_codex_responses_lite: 'true',
        retained: 'value',
      },
    } as Partial<CodexResponsesBody>);

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: false,
    }).body;
    expect(bridged.tools).toEqual([functionTool('top'), customTool('first'), functionTool('second')]);
    expect(bridged.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
    expect(bridged.instructions).toBe('Lite base');
    expect(bridged.parallel_tool_calls).toBe(false);
    expect(bridged.reasoning).toEqual({ effort: 'low', context: 'all_turns' });
    expect((bridged as unknown as Record<string, unknown>).client_metadata).toEqual({ retained: 'value' });
  });

  test('retains a tagged message when nonempty top-level instructions already exist', () => {
    const tagged = taggedInstructions('msg_base', 'Lite base');
    const body = requestBody({
      instructions: 'Top-level base',
      input: [
        additionalTools('at_one', []),
        tagged,
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: false,
    }).body;
    expect(bridged.instructions).toBe('Top-level base');
    expect(bridged.input).toEqual([tagged, { type: 'message', role: 'user', content: 'hello' }]);
  });

  test('does not consume a mixed classified developer message as base instructions', () => {
    const mixed: OpenAIResponsesInputItem = {
      type: 'message',
      role: 'developer',
      id: 'msg_mixed',
      content: [
        { type: 'input_text', text: 'Base' },
        { type: 'input_text', text: 'Other context' },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['model.base_instructions', 'generic.other'],
      },
    };
    const body = requestBody({
      input: [
        additionalTools('at_one', []),
        mixed,
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });

    const bridged = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: false,
    }).body;
    expect(bridged.instructions).toBeUndefined();
    expect(bridged.input).toEqual([
      mixed,
      { type: 'message', role: 'user', content: 'hello' },
    ]);
  });

  test('leaves an ordinary standard request in standard form', () => {
    const body = requestBody({
      instructions: 'Base',
      tools: [functionTool('lookup')],
      reasoning: { effort: 'medium' },
      parallel_tool_calls: true,
    });

    expect(bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: false,
      upstreamUsesLite: false,
    }).body).toEqual(body);
  });

  test('does not lift a non-leading additional-tools item for a standard caller', () => {
    const body = requestBody({
      tools: [functionTool('top')],
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_history', [customTool('historical')]),
      ],
    });

    expect(bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: false,
      upstreamUsesLite: false,
    }).body).toEqual(body);
  });
});

describe('Responses request echo restoration', () => {
  const response = (overrides: Partial<OpenAIResponsesResult> = {}): OpenAIResponsesResult => ({
    id: 'resp_1',
    object: 'response',
    model: 'model',
    output: [],
    status: 'completed' as const,
    incomplete_details: null,
    error: null,
    ...overrides,
  });

  test('restores standard request fields after lowering to Lite', () => {
    const tools = [functionTool('lookup')];
    const body = requestBody({
      tools,
      instructions: 'Base',
      parallel_tool_calls: true,
      reasoning: { effort: 'low', context: 'current_turn' },
    });
    const bridge = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: false,
      upstreamUsesLite: true,
    });
    const liteTools = (bridge.body.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>).tools;
    const restored = restoreCodexResponsesResult(response({
      tools: liteTools,
      instructions: null,
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
    }), bridge.callableIdentities, bridge.requestEchoes);

    expect(restored.tools).toEqual(tools);
    expect(restored.instructions).toBe('Base');
    expect(restored.parallel_tool_calls).toBe(true);
    expect(restored.reasoning).toEqual({ effort: 'low', context: 'current_turn' });
  });

  test('restores mixed Lite declarations without hiding effective Lite controls', () => {
    const tools = [functionTool('lookup')];
    const bridge = bridgeCodexResponsesRequest(requestBody({
      tools,
      instructions: 'Base',
      parallel_tool_calls: true,
      reasoning: { effort: 'low', context: 'current_turn' },
    }), { threadId: 'thread', downstreamUsesLite: true, upstreamUsesLite: true });
    const wire = response({
      tools: (bridge.body.input[0] as Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>).tools,
      instructions: null,
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
    });
    expect(bridge.requestEchoes).toEqual({ tools, instructions: 'Base' });
    const restored = restoreCodexResponsesResult(wire, bridge.callableIdentities, bridge.requestEchoes);
    expect(restored.tools).toBe(tools);
    expect(restored.instructions).toBe('Base');
    expect(restored.parallel_tool_calls).toBe(false);
    expect(restored.reasoning).toEqual(wire.reasoning);
    expect(restoreCodexResponsesEvent({ type: 'response.completed', response: wire } as OpenAIResponsesStreamEvent,
      bridge.callableIdentities, bridge.requestEchoes)).toMatchObject({ response: restored });
  });

  test('does not restore unchanged declaration fields on a native Lite request', () => {
    const bridge = bridgeCodexResponsesRequest(requestBody({
      input: [additionalTools('at_client', []), taggedInstructions('msg_client', 'Base')],
      parallel_tool_calls: true,
    }), { threadId: 'thread', downstreamUsesLite: true, upstreamUsesLite: true });
    expect(bridge.requestEchoes).toBeUndefined();
  });

  test('removes lifted standard request fields from a Lite-facing response', () => {
    const body = requestBody({
      input: [
        additionalTools('at_client', [functionTool('lookup')]),
        taggedInstructions('msg_client', 'Lite base'),
        { type: 'message', role: 'user', content: 'hello' },
      ],
    });
    const bridge = bridgeCodexResponsesRequest(body, {
      threadId: 'thread',
      downstreamUsesLite: true,
      upstreamUsesLite: false,
    });
    const restored = restoreCodexResponsesResult(response({
      tools: bridge.body.tools ?? undefined,
      instructions: bridge.body.instructions,
      parallel_tool_calls: false,
      reasoning: { effort: 'medium' },
    }), bridge.callableIdentities, bridge.requestEchoes);

    expect(restored).not.toHaveProperty('tools');
    expect(restored).not.toHaveProperty('instructions');
    expect(restored).not.toHaveProperty('parallel_tool_calls');
    expect(restored).not.toHaveProperty('reasoning');
  });
});

describe('Responses Lite callable identity restoration', () => {
  test('restores default-namespace function and custom calls in added, terminal, and compact output', async () => {
    const bridge = bridgeCodexResponsesRequest(requestBody({
      tools: [functionTool('lookup'), customTool('shell')],
    }), { threadId: 'thread', downstreamUsesLite: false, upstreamUsesLite: true });
    const functionItem = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      namespace: 'functions',
      arguments: '{}',
      status: 'completed',
    } as const;
    const customItem = {
      type: 'custom_tool_call',
      id: 'ct_1',
      call_id: 'call_2',
      name: 'shell',
      namespace: 'functions',
      input: 'ls',
      status: 'completed',
    } as const;
    const response: OpenAIResponsesResult = {
      id: 'resp_1',
      object: 'response',
      model: 'model',
      output: [functionItem, customItem],
      status: 'completed',
      incomplete_details: null,
      error: null,
    };

    const added = restoreCodexResponsesEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: functionItem,
    }, bridge.callableIdentities);
    expect(added).toMatchObject({ item: { name: 'lookup' } });
    expect((added as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>).item).not.toHaveProperty('namespace');

    const completed = restoreCodexResponsesEvent({
      type: 'response.completed',
      response,
    } as OpenAIResponsesStreamEvent, bridge.callableIdentities);
    const completedOutput = (completed as Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' }>).response.output;
    expect(completedOutput[0]).not.toHaveProperty('namespace');
    expect(completedOutput[1]).toMatchObject({ type: 'custom_tool_call', name: 'shell', input: 'ls' });
    expect(completedOutput[1]).not.toHaveProperty('namespace');

    const compact = restoreCodexResponsesCompactionResult({
      id: 'cmp_1',
      object: 'response.compaction',
      output: [functionItem],
    } as OpenAIResponsesCompactionResult, bridge.callableIdentities);
    expect(compact.output[0]).not.toHaveProperty('namespace');

    const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: functionItem } };
      yield { type: 'done' };
    })();
    const restoredFrames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
    for await (const frame of restoreCodexResponsesFrames(frames, bridge.callableIdentities)) restoredFrames.push(frame);
    expect(restoredFrames[0]).toMatchObject({ type: 'event', event: { item: { name: 'lookup' } } });
    expect((restoredFrames[0] as { type: 'event'; event: Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }> }).event.item).not.toHaveProperty('namespace');
    expect(restoredFrames[1]).toEqual({ type: 'done' });
  });

  test.each(['function', 'custom'] as const)('rejects a flat callable colliding with a namespaced %s', type => {
    const child = (type === 'function' ? functionTool('same') : customTool('same')) as
      Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>;
    expect(() => bridgeCodexResponsesRequest(requestBody({
      tools: [
        functionTool('same'),
        { type: 'namespace', name: 'functions', description: '', tools: [child] },
      ],
    }), { threadId: 'thread', downstreamUsesLite: false, upstreamUsesLite: true })).toThrow(
      'Codex Responses Lite cannot preserve distinct callable identities for ["functions","same"]',
    );
  });
});
