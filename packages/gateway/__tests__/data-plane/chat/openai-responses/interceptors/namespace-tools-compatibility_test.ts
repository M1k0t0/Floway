import { test, vi } from 'vitest';

import { withOpenAIResponsesNamespaceToolsCompatibility } from '../../../../../src/data-plane/chat/openai-responses/interceptors/namespace-tools-compatibility.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { eventResult, readUpstreamApiError } from '@floway-dev/provider';
import { assert, assertEquals, assertRejects, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const invocation = (payload: CanonicalOpenAIResponsesPayload, targetApi: OpenAIResponsesInvocation['targetApi'] = 'openaiChatCompletions'): OpenAIResponsesInvocation => ({
  payload, targetApi, candidate: stubModelCandidate(), action: 'generate', headers: new Headers(),
});
const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });
const emptyResult = (): OpenAIResponsesResult => ({ id: 'resp', object: 'response', model: 'model', status: 'completed', output: [], output_text: '', error: null, incomplete_details: null });
const result = (events: OpenAIResponsesStreamEvent[] = []) => eventResult((async function* () {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
})(), testTelemetryModelIdentity);
const run = async (call: OpenAIResponsesInvocation) => await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => result());

test('namespace compatibility leaves native Responses and ordinary flat requests untouched', async () => {
  const payload: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] };
  const native = invocation(payload, 'openaiResponses');
  await run(native);
  assert(native.payload === payload);
  const flat = { ...payload, tools: [functionTool('read')] };
  const translated = invocation(flat);
  await run(translated);
  assert(translated.payload === flat);
});

test('namespace compatibility maps declarations, custom history, choices and duplicate declarations without mutation', async () => {
  const custom = { type: 'custom' as const, name: 'edit', format: { type: 'text' as const }, description: 'custom tool' };
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [functionTool('files_read'), { type: 'namespace', name: 'files', description: '', tools: [functionTool('read'), custom, functionTool('read')] }],
    input: [
      { type: 'function_call', name: 'read', namespace: 'files', call_id: 'a', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', name: 'edit', namespace: 'files', call_id: 'b', input: 'patch' },
      { type: 'function_call_output', call_id: 'a', output: 'result' },
      { type: 'custom_tool_call_output', call_id: 'b', output: 'done' },
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'files' }, { type: 'custom', name: 'edit', namespace: 'files' }, { type: 'future', extra: true }] },
  };
  const original = structuredClone(request);
  const call = invocation(request);
  await run(call);
  assertEquals(call.payload.tools?.map(tool => 'name' in tool ? tool.name : null), ['files_read', 'files_read_2', 'files_edit', 'files_read_2']);
  assertEquals(call.payload.input.slice(0, 2).map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? [item.name, item.namespace] : null), [['files_read_2', undefined], ['files_edit', undefined]]);
  assertEquals(call.payload.input.slice(2), request.input.slice(2));
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'files_read_2' }, { type: 'custom', name: 'files_edit' }, { type: 'future', extra: true }] });
  assertEquals(request, original);
  const forced = invocation({ ...request, tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } } as CanonicalOpenAIResponsesPayload);
  await run(forced);
  assertEquals(forced.payload.tool_choice, { type: 'custom', name: 'files_edit' });
});

test('namespace compatibility allocates replay-only identities against the current flat collision set', async () => {
  const call = invocation({
    model: 'm', tools: [functionTool('files_read'), functionTool('files_read_2')],
    input: [{ type: 'function_call', name: 'read', namespace: 'files', call_id: 'past', arguments: '{}', status: 'completed' }],
  });
  await run(call);
  assertEquals(call.payload.input, [{ type: 'function_call', name: 'files_read_3', call_id: 'past', arguments: '{}', status: 'completed' }]);
  assertEquals(call.payload.tools, [functionTool('files_read'), functionTool('files_read_2')]);
});

test('namespace compatibility preserves qualified Standard names and gives explicit flat declarations priority', async () => {
  const namespace: OpenAIResponsesTool = { type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] };
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [namespace],
    input: [{ type: 'function_call', name: 'files.read', call_id: 'past', arguments: '{}', status: 'completed' }],
    tool_choice: { type: 'function', name: 'files.read' },
  };
  const call = invocation(payload);
  await run(call);
  assertEquals(call.payload.tool_choice, { type: 'function', name: 'files_read' });
  assertEquals(call.payload.input, [{ type: 'function_call', name: 'files_read', call_id: 'past', arguments: '{}', status: 'completed' }]);
  const flat = invocation({ ...payload, tools: [functionTool('files.read'), namespace] });
  await run(flat);
  assertEquals(flat.payload.tool_choice, payload.tool_choice);
  assertEquals(flat.payload.input, payload.input);
});

test('namespace compatibility resolves qualified historical names independently of the current callable kind', async () => {
  const call = invocation({ model: 'm', tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'read' }] }], input: [{ type: 'function_call', name: 'files.read', call_id: 'old', arguments: '{}', status: 'completed' }] });
  await run(call);
  assertEquals(call.payload.input, [{ type: 'function_call', name: 'files_read_2', call_id: 'old', arguments: '{}', status: 'completed' }]);
});

test('namespace compatibility never applies a vendor default namespace to Standard history or tool choice', async () => {
  const call = invocation({
    model: 'm', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('read')] }],
    input: [{ type: 'function_call', name: 'read', call_id: 'flat', arguments: '{}', status: 'completed' }],
    tool_choice: { type: 'function', name: 'read' },
  });
  await run(call);
  assertEquals(call.payload.input[0], { type: 'function_call', name: 'read', call_id: 'flat', arguments: '{}', status: 'completed' });
  assertEquals(call.payload.tool_choice, { type: 'function', name: 'read' });
});

for (const [namespace, reservePreferred] of [['n'.repeat(64), false], ['n'.repeat(59), true]] as const) {
  test(`namespace compatibility bounds collision lookups for ${namespace.length}-character namespaces`, async () => {
    const count = 1000;
    const children = Array.from({ length: count }, (_, index) => functionTool(String(index).padStart(4, '0')));
    const reserved = reservePreferred ? children.map(child => functionTool(`${namespace}_${'name' in child ? child.name : ''}`)) : [];
    const call = invocation({ model: 'm', input: [], tools: [...reserved, { type: 'namespace', name: namespace, description: '', tools: children }] });
    const has = vi.spyOn(Set.prototype, 'has');
    let checks = 0;
    try {
      await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => {
        checks = has.mock.calls.length;
        has.mockRestore();
        return result();
      });
    } finally { has.mockRestore(); }
    const names = call.payload.tools!.slice(reserved.length).map(tool => 'name' in tool ? tool.name : '');
    assertEquals(names.length, count);
    assertEquals(new Set(names).size, count);
    assert(names.every(name => typeof name === 'string' && name.length <= 64));
    assert(checks >= count, 'instrument must observe collision membership checks');
    assert(checks <= 2 * count + reserved.length, `expected bounded lookup count, observed ${checks}`);
  });
}

test('namespace compatibility preserves suffix ordering across digit widths, invalid characters and duplicates', async () => {
  const namespace = 'n'.repeat(59);
  const prefix = `${namespace}_`;
  const children = ['aaaa', 'aaab', 'aaac', 'a', 'aa', 'aaaa'];
  const reserved = [...children.slice(0, -1).map(name => `${prefix}${name}`), ...Array.from({ length: 8 }, (_, i) => `${prefix}aa_${i + 2}`), `${prefix}a_10`, `${prefix}a_12`];
  const call = invocation({ model: 'm', input: [], tools: [...reserved.map(functionTool), { type: 'namespace', name: namespace, description: '', tools: children.map(functionTool) }, { type: 'namespace', name: 'bad.ns', description: '', tools: [functionTool('bad/name')] }] });
  await run(call);
  assertEquals(call.payload.tools?.slice(reserved.length).map(tool => 'name' in tool ? tool.name : null), [`${prefix}a_11`, `${prefix}a_13`, `${prefix}a_14`, `${prefix}a_2`, `${prefix}a_15`, `${prefix}a_11`, 'bad_ns_bad_name']);
});

test('namespace compatibility restores item lifecycle, function/custom types, and resource echoes before outer readers', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit' }, functionTool('read')] }], tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } as CanonicalOpenAIResponsesPayload['tool_choice'] };
  const call = invocation(request);
  const output = [
    { type: 'function_call' as const, name: 'files_edit', id: 'fc1', call_id: 'a', arguments: 'patch', status: 'completed' as const },
    { type: 'custom_tool_call' as const, name: 'files_read', id: 'fc2', call_id: 'b', input: '{}' },
  ];
  const upstream = { ...emptyResult(), output, tools: [functionTool('files_edit')], tool_choice: { type: 'function' as const, name: 'files_edit' }, extension: 'kept' };
  const response = await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => result([
    { type: 'response.output_item.added', output_index: 0, item: output[0]! },
    { type: 'response.output_item.done', output_index: 0, item: output[0]! },
    { type: 'response.completed', response: upstream },
  ]));
  assert(response.type === 'events');
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response.events) frames.push(frame);
  const expected = [
    { type: 'custom_tool_call', name: 'edit', namespace: 'files', id: 'fc1', call_id: 'a', input: 'patch', status: 'completed' },
    { type: 'function_call', name: 'read', namespace: 'files', id: 'fc2', call_id: 'b', arguments: '{}', status: 'completed' },
  ];
  assertEquals(frames[0], eventFrame({ type: 'response.output_item.added', output_index: 0, item: expected[0] } as OpenAIResponsesStreamEvent));
  assertEquals(frames[1], eventFrame({ type: 'response.output_item.done', output_index: 0, item: expected[0] } as OpenAIResponsesStreamEvent));
  assertEquals(frames[2], eventFrame({ type: 'response.completed', response: { ...upstream, output: expected, tools: request.tools, tool_choice: request.tool_choice } } as OpenAIResponsesStreamEvent));
  assertEquals(frames[3], doneFrame());
  assertEquals(upstream.output, output);
});

for (const type of ['function', 'custom'] as const) {
  test(`namespace compatibility restores ${type} argument event types along with callable items`, async () => {
    const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type, name: 'read' }] }] });
    const sourceIsFunction = type === 'function';
    const item = sourceIsFunction
      ? { type: 'custom_tool_call' as const, id: 'item', name: 'files_read', call_id: 'call', input: '{}' }
      : { type: 'function_call' as const, id: 'item', name: 'files_read', call_id: 'call', arguments: '{}', status: 'completed' as const };
    const unknown = { type: 'future.event', opaque: { retained: true } } as unknown as OpenAIResponsesStreamEvent;
    const response = await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => result([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: sourceIsFunction ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: 'item', output_index: 0, delta: '{}' },
      sourceIsFunction
        ? { type: 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, input: '{}' }
        : { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, arguments: '{}', name: 'files_read' } as OpenAIResponsesStreamEvent,
      unknown,
    ]));
    assert(response.type === 'events');
    const events: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of response.events) if (frame.type === 'event') events.push(frame.event);
    assertEquals(events[1], { type: sourceIsFunction ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'item', output_index: 0, delta: '{}' });
    assertEquals(events[2], { type: sourceIsFunction ? 'response.function_call_arguments.done' : 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, [sourceIsFunction ? 'arguments' : 'input']: '{}', ...(sourceIsFunction ? { name: 'read' } : {}) });
    assert(events[3] === unknown);
  });
}

test('namespace compatibility restores function arguments.done names without adding a namespace field', async () => {
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const response = await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => result([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'files_read', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'files_read', arguments: '{}' } as OpenAIResponsesStreamEvent,
  ]));
  assert(response.type === 'events');
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of response.events) if (frame.type === 'event') events.push(frame.event);
  assertEquals(events[1], { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' });
});

test('namespace compatibility preserves named MCP and future selectors', async () => {
  const selectors = [{ type: 'mcp', server_label: 'remote', name: 'functions.search' }, { type: 'future', name: 'functions.search' }];
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('search')] }], tool_choice: { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'search', namespace: 'functions' }] } });
  await run(call);
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'functions_search' }] });
});

test('namespace compatibility bounds scanned prefixes and identity-key storage for a shared long namespace', async () => {
  const namespace = 'n'.repeat(4096);
  const count = 32;
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: namespace, description: '', tools: Array.from({ length: count }, (_, index) => functionTool(`tool${index}`)) }] });
  const ctx = mockChatGatewayCtx();
  const replacements = vi.spyOn(String.prototype, 'replaceAll');
  const keys = vi.spyOn(Map.prototype, 'set');
  let lengths: number[] = [];
  let keyBytes = 0;
  try {
    await withOpenAIResponsesNamespaceToolsCompatibility(call, ctx, async () => {
      lengths = replacements.mock.contexts.map(context => String(context).length);
      keyBytes = keys.mock.calls.reduce((total, [key]) => total + (typeof key === 'string' ? key.length : 0), 0);
      replacements.mockRestore();
      keys.mockRestore();
      return result();
    });
  } finally {
    replacements.mockRestore();
    keys.mockRestore();
  }
  assert(lengths.length > 0, 'instrument must observe the allocator sanitizing names');
  assert(Math.max(...lengths) <= 64, `allocator scanned an unbounded prefix: ${Math.max(...lengths)}`);
  assert(keyBytes > namespace.length, 'instrument must observe the actual identity registry');
  assert(keyBytes <= namespace.length + count * 300, `identity map repeated the full namespace: ${keyBytes} key bytes`);
  assertEquals(new Set(call.payload.tools!.map(tool => 'name' in tool ? tool.name : null)).size, count);
});

test('namespace compatibility restores lifecycle-appropriate function status from custom items', async () => {
  const call = invocation({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const item = { type: 'custom_tool_call' as const, id: 'item', call_id: 'call', name: 'files_read', input: '{}' };
  const response = await withOpenAIResponsesNamespaceToolsCompatibility(call, mockChatGatewayCtx(), async () => result([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.created', response: { ...emptyResult(), status: 'in_progress', output: [item] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...emptyResult(), output: [item] } },
  ]));
  assert(response.type === 'events');
  const statuses: unknown[] = [];
  for await (const frame of response.events) {
    if (frame.type !== 'event') continue;
    if ('item' in frame.event) statuses.push((frame.event.item as { status?: string }).status);
    else if ('response' in frame.event) statuses.push((frame.event.response.output[0] as { status?: string }).status);
  }
  assertEquals(statuses, ['in_progress', 'in_progress', 'completed', 'completed']);
});

test('namespace compatibility preserves error identity, distinguishes callable kinds and rejects ambiguous qualification', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] };
  const failure = await readUpstreamApiError(new Response('raw upstream failure', { status: 409, headers: { 'x-upstream': 'kept' } }));
  const actual = await withOpenAIResponsesNamespaceToolsCompatibility(invocation(request), mockChatGatewayCtx(), async () => failure);
  assert(actual === failure);
  const distinct = invocation({ ...request, tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read'), { type: 'custom', name: 'read' }] }] });
  await run(distinct);
  assertEquals(distinct.payload.tools?.map(tool => 'name' in tool ? tool.name : null), ['files_read', 'files_read_2']);
  const ambiguous = invocation({ ...request, tools: [{ type: 'namespace', name: 'a.b', description: '', tools: [functionTool('c')] }, { type: 'namespace', name: 'a', description: '', tools: [functionTool('b.c')] }], tool_choice: { type: 'function', name: 'a.b.c' } });
  await assertRejects(() => run(ambiguous), TypeError, 'Ambiguous qualified OpenAI Responses callable name');
});
