import { expect, test } from 'vitest';

import { canonicalizeOpenAIResponsesPayload } from '../../../src/canonicalize-openai-responses-payload.ts';
import { buildTargetRequest as messagesRequest } from '../../../src/openai-responses-via-anthropic-messages/request.ts';
import { translateOpenAIResponsesViaAnthropicMessages } from '../../../src/openai-responses-via-anthropic-messages/translate.ts';
import { buildTargetRequest as chatRequest } from '../../../src/openai-responses-via-openai-chat-completions/request.ts';
import { translateOpenAIResponsesViaOpenAIChatCompletions } from '../../../src/openai-responses-via-openai-chat-completions/translate.ts';
import { flattenNamespaceTools, restoreNamespaceEvents } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const payload = (): OpenAIResponsesRequestPayload => ({
  model: 'm',
  tools: [
    { type: 'function', name: 'agents_spawn' },
    {
      type: 'namespace', name: 'agents', description: '', tools: [
        { type: 'function', name: 'spawn', parameters: { type: 'object' } },
        { type: 'function', name: 'wait', parameters: { type: 'object' } },
        { type: 'custom', name: 'audit' },
      ],
    },
  ],
  input: [{ type: 'function_call', namespace: 'agents', name: 'wait', call_id: 'old', arguments: '{}', status: 'completed' }],
  tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', namespace: 'agents', name: 'spawn' }] },
});

test('both targets preserve namespace subsets and excluded replay identities', async () => {
  const source = payload();
  const chat = chatRequest(source);
  const messages = await messagesRequest(source);
  expect(chat.target.tools?.map(tool => tool.type === 'function' ? tool.function.name : '')).toEqual(['agents_spawn_2']);
  expect(messages.target.tools?.map(tool => tool.name)).toEqual(['agents_spawn_2']);
  expect(chat.target.messages[0].tool_calls?.[0].function.name).toBe('agents_wait');
  expect(messages.target.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_use', name: 'agents_wait' })]));
  expect(chat.target.tool_choice).toBe('required');
  expect(messages.target.tool_choice).toEqual({ type: 'any' });
});

test('expands namespace selectors and includes deferred declarations on both targets', async () => {
  const source = payload();
  source.tool_choice = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'agents' }] };
  source.input = [{ type: 'additional_tools', role: 'developer', tools: source.tools! }];
  source.tools = undefined;
  expect(chatRequest(source).target.tools).toHaveLength(3);
  expect((await messagesRequest(source)).target.tools).toHaveLength(3);
});

test('history-only namespace calls reserve names without inventing declarations', async () => {
  const source = payload();
  source.tools = undefined;
  source.tool_choice = undefined;
  const chat = chatRequest(source);
  const messages = await messagesRequest(source);
  expect(chat.target.tools).toBeUndefined();
  expect(messages.target.tools).toBeUndefined();
  expect(chat.target.messages[0].tool_calls?.[0].function.name).toBe('agents_wait');
  expect(chat.namespaceToolNames.targetToSource.get('agents_wait')).toEqual({ namespace: 'agents', name: 'wait', type: 'function_call' });
});

test('forced namespace choices use the declaration mapping', async () => {
  const source = payload();
  source.tool_choice = { type: 'function', namespace: 'agents', name: 'spawn' };
  expect(chatRequest(source).target.tool_choice).toEqual({ type: 'function', function: { name: 'agents_spawn_2' } });
  expect((await messagesRequest(source)).target.tool_choice).toEqual({ type: 'tool', name: 'agents_spawn_2' });
});

test('restores function and custom calls across item events and terminal snapshots', async () => {
  const prepared = flattenNamespaceTools(canonicalizeOpenAIResponsesPayload(payload()));
  const output = [
    { type: 'function_call' as const, name: 'agents_spawn_2', call_id: 'spawn', arguments: '{"name":"agents_spawn_2"}', status: 'completed' },
    { type: 'custom_tool_call' as const, name: 'agents_audit', call_id: 'audit', input: 'agents_audit' },
  ];
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: output[0] });
    yield eventFrame({ type: 'response.completed', response: { id: 'r', object: 'response', model: 'm', status: 'completed', error: null, incomplete_details: null, output } });
  })();
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of restoreNamespaceEvents(frames, prepared.names)) if (frame.type === 'event') events.push(frame.event);
  expect(events[0]).toMatchObject({ item: { namespace: 'agents', name: 'spawn', arguments: '{"name":"agents_spawn_2"}' } });
  expect(events[1]).toMatchObject({
    response: {
      output: [
        { namespace: 'agents', name: 'spawn' }, { namespace: 'agents', name: 'audit', input: 'agents_audit' },
      ],
    },
  });
});

for (const kind of ['function', 'custom'] as const) {
  test.each(['.', '__'])(`resolves qualified ${kind} selectors containing %s on both targets`, async separator => {
    const source = payload();
    const child = kind === 'function' ? 'spawn' : 'audit';
    const name = kind === 'function' ? 'agents_spawn_2' : 'agents_audit';
    const selector = { type: kind, name: `agents${separator}${child}` };
    source.tool_choice = selector;
    expect(chatRequest(source).target.tool_choice).toEqual({ type: 'function', function: { name } });
    expect((await messagesRequest(source)).target.tool_choice).toEqual({ type: 'tool', name });
    source.tool_choice = { type: 'allowed_tools', mode: 'required', tools: [selector] };
    expect(chatRequest(source).target.tools?.map(tool => tool.type === 'function' ? tool.function.name : '')).toEqual([name]);
    expect((await messagesRequest(source)).target.tools?.map(tool => tool.name)).toEqual([name]);
  });

  test.each(['.', '__'])(`flat ${kind} declarations take priority over qualified %s selectors without history`, async separator => {
    const name = `files${separator}read`;
    const selector = { type: kind, name };
    const source: OpenAIResponsesRequestPayload = {
      model: 'm', input: [], tools: [
        { type: 'namespace', name: 'files', description: '', tools: [{ type: kind, name: 'read' }] },
        { type: kind, name },
      ],
      tool_choice: selector,
    };
    expect(chatRequest(source).target.tool_choice).toEqual({ type: 'function', function: { name } });
    expect((await messagesRequest(source)).target.tool_choice).toEqual({ type: 'tool', name });
    source.tool_choice = { type: 'allowed_tools', mode: 'required', tools: [selector] };
    expect(chatRequest(source).target.tools?.map(tool => tool.type === 'function' ? tool.function.name : '')).toEqual([name]);
    expect((await messagesRequest(source)).target.tools?.map(tool => tool.name)).toEqual([name]);
  });
}

test.each(['function', 'custom'] as const)('rejects ambiguous qualified namespace identities with a %s child on both targets', async kind => {
  const tools: OpenAIResponsesRequestPayload['tools'] = [
    { type: 'namespace', name: 'x.y', description: '', tools: [{ type: 'function', name: 'f' }] },
    { type: 'namespace', name: 'x', description: '', tools: [{ type: kind, name: 'y.f' }] },
  ];
  for (const inventory of [tools, [...tools].reverse()]) {
    const source = { model: 'm', input: [], tools: inventory };
    expect(() => chatRequest(source)).toThrow("Cannot translate ambiguous namespace tool 'x.y.f'.");
    await expect(messagesRequest(source)).rejects.toThrow("Cannot translate ambiguous namespace tool 'x.y.f'.");
  }
});

test('rejects ambiguous double-underscore selectors on both targets', async () => {
  const source: OpenAIResponsesRequestPayload = {
    model: 'm', input: [], tools: [
      { type: 'namespace', name: 'a__b', description: '', tools: [{ type: 'function', name: 'c' }] },
      { type: 'namespace', name: 'a', description: '', tools: [{ type: 'function', name: 'b__c' }] },
    ],
  };
  const selector = { type: 'function' as const, name: 'a__b__c' };
  for (const tool_choice of [selector, { type: 'allowed_tools' as const, mode: 'auto' as const, tools: [selector] }]) {
    expect(() => chatRequest({ ...source, tool_choice })).toThrow("Cannot select ambiguous qualified tool 'a__b__c'.");
    await expect(messagesRequest({ ...source, tool_choice })).rejects.toThrow("Cannot select ambiguous qualified tool 'a__b__c'.");
  }
});

test('the complete Chat Completions trip restores the namespace after target tool calls', async () => {
  const trip = await translateOpenAIResponsesViaOpenAIChatCompletions(payload(), { model: 'm' });
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
    yield eventFrame({ id: 'chat1', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'agents_spawn_2', arguments: '{}' } }] }, finish_reason: null }] });
    yield eventFrame({ id: 'chat1', object: 'chat.completion.chunk', model: 'm', created: 0, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    yield doneFrame();
  })();
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of trip.events(frames)) if (frame.type === 'event') events.push(frame.event);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ namespace: 'agents', name: 'spawn', arguments: '{}' }) })]));
  expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [expect.objectContaining({ namespace: 'agents', name: 'spawn' })] } });
});

test('the complete Anthropic Messages trip restores the namespace after target tool calls', async () => {
  const trip = await translateOpenAIResponsesViaAnthropicMessages(payload(), { model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected remote image'); } });
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {
    yield eventFrame({ type: 'message_start', message: { id: 'msg1', type: 'message', model: 'm', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call1', name: 'agents_spawn_2', input: {} } });
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
    yield eventFrame({ type: 'content_block_stop', index: 0 });
    yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
    yield eventFrame({ type: 'message_stop' });
  })();
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of trip.events(frames)) if (frame.type === 'event') events.push(frame.event);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ namespace: 'agents', name: 'spawn', arguments: '{}' }) })]));
  expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [expect.objectContaining({ namespace: 'agents', name: 'spawn' })] } });
});
