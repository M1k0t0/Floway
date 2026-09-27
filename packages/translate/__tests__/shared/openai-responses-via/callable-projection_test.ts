import { expect, test, vi } from 'vitest';

import { flattenNamespaceTools, restoreNamespaceEvents } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import { TranslatorInputError } from '../../../src/translator-input-error.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

const functionTool = (name: string): Extract<OpenAIResponsesTool, { type: 'function' }> => ({ type: 'function', name, parameters: { type: 'object' } });
const emptyResult = (): OpenAIResponsesResult => ({ id: 'resp', object: 'response', model: 'model', status: 'completed', output: [], output_text: '', error: null, incomplete_details: null });
const framesOf = async function* (events: OpenAIResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

for (const [namespace, reservePreferred] of [['n'.repeat(64), false], ['n'.repeat(59), true]] as const) {
  test(`callable projection bounds collision lookups for ${namespace.length}-character namespaces`, () => {
    const count = 1000;
    const children = Array.from({ length: count }, (_, index) => functionTool(String(index).padStart(4, '0')));
    const reserved = reservePreferred ? children.map(child => functionTool(`${namespace}_${'name' in child ? child.name : ''}`)) : [];
    const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [...reserved, { type: 'namespace', name: namespace, description: '', tools: children }] };
    let call: ReturnType<typeof flattenNamespaceTools>;
    const has = vi.spyOn(Set.prototype, 'has');
    let checks = 0;
    try {
      call = flattenNamespaceTools(request);
      checks = has.mock.calls.length;
    } finally { has.mockRestore(); }
    const names = call.payload.tools!.slice(reserved.length).map(tool => 'name' in tool ? tool.name : '');
    assertEquals(names.length, count);
    assertEquals(new Set(names).size, count);
    assert(names.every(name => typeof name === 'string' && name.length <= 64));
    assert(checks >= count, 'instrument must observe collision membership checks');
    assert(checks <= 2 * count + reserved.length, `expected bounded lookup count, observed ${checks}`);
  });
}

test('callable projection preserves suffix ordering across digit widths, invalid characters and duplicates', () => {
  const namespace = 'n'.repeat(59);
  const prefix = `${namespace}_`;
  const children = ['aaaa', 'aaab', 'aaac', 'a', 'aa', 'aaaa'];
  const reserved = [...children.slice(0, -1).map(name => `${prefix}${name}`), ...Array.from({ length: 8 }, (_, i) => `${prefix}aa_${i + 2}`), `${prefix}a_10`, `${prefix}a_12`];
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [...reserved.map(functionTool), { type: 'namespace', name: namespace, description: '', tools: children.map(functionTool) }, { type: 'namespace', name: 'bad.ns', description: '', tools: [functionTool('bad/name')] }] });
  assertEquals(call.payload.tools?.slice(reserved.length).map(tool => 'name' in tool ? tool.name : null), [`${prefix}a_11`, `${prefix}a_13`, `${prefix}a_14`, `${prefix}a_2`, `${prefix}a_15`, `${prefix}a_11`, 'bad_ns_bad_name']);
});

test('callable projection restores item lifecycle, function/custom types, and resource echoes before outer readers', async () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'edit' }, functionTool('read')] }], tool_choice: { type: 'custom', name: 'edit', namespace: 'files' } as CanonicalOpenAIResponsesPayload['tool_choice'] };
  const call = flattenNamespaceTools(request);
  const output = [
    { type: 'function_call' as const, name: 'files_edit', id: 'fc1', call_id: 'a', arguments: 'patch', status: 'completed' as const },
    { type: 'custom_tool_call' as const, name: 'files_read', id: 'fc2', call_id: 'b', input: '{}' },
  ];
  const upstream = { ...emptyResult(), output, tools: [functionTool('files_edit')], tool_choice: { type: 'function' as const, name: 'files_edit' }, extension: 'kept' };
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item: output[0]! },
    { type: 'response.output_item.done', output_index: 0, item: output[0]! },
    { type: 'response.completed', response: upstream },
  ]), call.names);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response) frames.push(frame);
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
  test(`callable projection restores ${type} argument event types along with callable items`, async () => {
    const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type, name: 'read' }] }] });
    const sourceIsFunction = type === 'function';
    const item = sourceIsFunction
      ? { type: 'custom_tool_call' as const, id: 'item', name: 'files_read', call_id: 'call', input: '{}' }
      : { type: 'function_call' as const, id: 'item', name: 'files_read', call_id: 'call', arguments: '{}', status: 'completed' as const };
    const unknown = { type: 'future.event', opaque: { retained: true } } as unknown as OpenAIResponsesStreamEvent;
    const response = restoreNamespaceEvents(framesOf([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: sourceIsFunction ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', item_id: 'item', output_index: 0, delta: '{}' },
      sourceIsFunction
        ? { type: 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, input: '{}' }
        : { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, arguments: '{}', name: 'files_read' } as OpenAIResponsesStreamEvent,
      unknown,
    ]), call.names);
    const events: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of response) if (frame.type === 'event') events.push(frame.event);
    assertEquals(events[1], { type: sourceIsFunction ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'item', output_index: 0, delta: '{}' });
    assertEquals(events[2], { type: sourceIsFunction ? 'response.function_call_arguments.done' : 'response.custom_tool_call_input.done', item_id: 'item', output_index: 0, [sourceIsFunction ? 'arguments' : 'input']: '{}', ...(sourceIsFunction ? { name: 'read' } : {}) });
    assert(events[3] === unknown);
  });
}

test('callable projection restores function arguments.done names without adding a namespace field', async () => {
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'files_read', arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'files_read', arguments: '{}' } as OpenAIResponsesStreamEvent,
  ]), call.names);
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of response) if (frame.type === 'event') events.push(frame.event);
  assertEquals(events[1], { type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' });
});

test('callable projection bounds sanitized flat-name prefixes for a shared long namespace', () => {
  const namespace = 'n'.repeat(4096);
  const count = 32;
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [{ type: 'namespace', name: namespace, description: '', tools: Array.from({ length: count }, (_, index) => functionTool(`tool${index}`)) }] };
  let call: ReturnType<typeof flattenNamespaceTools>;
  const replacements = vi.spyOn(String.prototype, 'replaceAll');
  let lengths: number[] = [];
  try {
    call = flattenNamespaceTools(request);
    lengths = replacements.mock.contexts.map(context => String(context).length);
  } finally {
    replacements.mockRestore();
  }
  assert(lengths.length > 0, 'instrument must observe the allocator sanitizing names');
  assert(Math.max(...lengths) <= 64, `allocator scanned an unbounded prefix: ${Math.max(...lengths)}`);
  assertEquals(new Set(call.payload.tools!.map(tool => 'name' in tool ? tool.name : null)).size, count);
});

test('callable projection restores lifecycle-appropriate function status from custom items', async () => {
  const call = flattenNamespaceTools({ model: 'm', input: [], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] });
  const item = { type: 'custom_tool_call' as const, id: 'item', call_id: 'call', name: 'files_read', input: '{}' };
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.created', response: { ...emptyResult(), status: 'in_progress', output: [item] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...emptyResult(), output: [item] } },
  ]), call.names);
  const statuses: unknown[] = [];
  for await (const frame of response) {
    if (frame.type !== 'event') continue;
    if ('item' in frame.event) statuses.push((frame.event.item as { status?: string }).status);
    else if ('response' in frame.event) statuses.push((frame.event.response.output[0] as { status?: string }).status);
  }
  assertEquals(statuses, ['in_progress', 'in_progress', 'completed', 'completed']);
});

test('callable projection retains parent and child descriptions for translated targets', () => {
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', input: [], tools: [
      { type: 'namespace', name: 'files', description: 'Read-only access. Never modify files.', tools: [{ ...functionTool('read'), description: 'Read a file.' }, { type: 'custom', name: 'inspect' }] },
      { type: 'namespace', name: 'empty', description: '', tools: [{ ...functionTool('read'), description: 'Child-only description.' }] },
    ],
  };
  const original = structuredClone(request);
  const call = flattenNamespaceTools(request);
  assertEquals(call.payload.tools?.map(tool => 'description' in tool ? tool.description : undefined), ['Read-only access. Never modify files.\n\nRead a file.', 'Read-only access. Never modify files.', 'Child-only description.']);
  assertEquals(request, original);
});

test('callable projection projects Standard carriers before namespace allocation without mutating history', async () => {
  const developer = { type: 'message' as const, role: 'developer' as const, content: 'Keep this ordinary developer instruction.' };
  const delayed = { type: 'tool_search_output' as const, tools: [functionTool('delayed')] };
  const request: CanonicalOpenAIResponsesPayload = {
    model: 'm', tools: [functionTool('files_edit')],
    input: [
      developer,
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'files', description: 'File policy.', tools: [{ type: 'custom', name: 'edit', description: 'Edit a file.' }] }] },
      { type: 'additional_tools', role: 'developer', tools: [functionTool('read')] },
      { type: 'custom_tool_call', namespace: 'files', name: 'edit', call_id: 'past', input: 'patch' },
      delayed,
    ],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'files', name: 'edit' }] },
  };
  const original = structuredClone(request);
  const call = flattenNamespaceTools(request);
  const response = restoreNamespaceEvents(framesOf([
    { type: 'response.completed', response: { ...emptyResult(), tools: call.payload.tools ?? undefined, tool_choice: call.payload.tool_choice, output: [{ type: 'function_call', name: 'files_edit_2', call_id: 'current', arguments: 'new patch', status: 'completed' }] } },
  ]), call.names);
  assertEquals(call.payload.tools?.map(tool => 'name' in tool ? tool.name : undefined), ['files_edit', 'files_edit_2', 'read', 'delayed']);
  assertEquals(call.payload.tools?.[1], { type: 'custom', name: 'files_edit_2', description: 'File policy.\n\nEdit a file.' });
  assertEquals(call.payload.input, [developer, { type: 'custom_tool_call', name: 'files_edit_2', call_id: 'past', input: 'patch' }]);
  assert(call.payload.input[0] === developer);
  assertEquals(call.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'files_edit_2' }] });
  assertEquals(request, original);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of response) frames.push(frame);
  const frame = frames[0];
  assert(frame.type === 'event' && frame.event.type === 'response.completed');
  assertEquals(frame.event.response.tools, request.tools);
  assertEquals(frame.event.response.tool_choice, request.tool_choice);
  assertEquals(frame.event.response.output, [{ type: 'custom_tool_call', name: 'edit', namespace: 'files', call_id: 'current', input: 'new patch', status: 'completed' }]);
});

for (const tools of [undefined, [], [functionTool('existing')]]) {
  for (const echo of [false, true]) {
    test(`carrier projection restores original tool echoes (${tools === undefined ? 'omitted' : tools.length} declarations, upstream echo ${echo})`, async () => {
      const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'additional_tools', role: 'developer', tools: [functionTool('read')] }], ...(tools === undefined ? {} : { tools }) };
      const call = flattenNamespaceTools(request);
      const response = restoreNamespaceEvents(framesOf([
        { type: 'response.completed', response: { ...emptyResult(), ...(echo ? { tools: call.payload.tools ?? undefined } : {}) } },
      ]), call.names);
      assertEquals(call.payload.input, []);
      assertEquals(call.payload.tools, [...(tools ?? []), functionTool('read')]);
      let completed = 0;
      for await (const frame of response) {
        if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
        completed++;
        assertEquals(frame.event.response.tools, echo ? tools : undefined);
        assertEquals(Object.hasOwn(frame.event.response, 'tools'), echo && tools !== undefined);
      }
      assertEquals(completed, 1);
    });
  }
}

for (const carrier of [
  { type: 'additional_tools', role: 'user', tools: [] },
  { type: 'additional_tools', role: 'developer', tools: null },
  { type: 'additional_tools', role: 'developer', tools: [null] },
  { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 42 }] },
]) {
  test(`callable projection typed-rejects malformed Standard carrier ${JSON.stringify(carrier)}`, () => {
    const request = { model: 'm', input: [carrier] } as unknown as CanonicalOpenAIResponsesPayload;
    const original = structuredClone(request);
    assertThrows(() => flattenNamespaceTools(request), TranslatorInputError, 'additional_tools');
    assertEquals(request, original);
  });
}

test('callable restoration retains only echo fields, not the source request or input', () => {
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [{ type: 'message', role: 'user', content: 'Long conversation' }], tools: [{ type: 'namespace', name: 'files', description: '', tools: [functionTool('read')] }] };
  const { names } = flattenNamespaceTools(request);
  const reachable = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null || reachable.has(value)) return;
    reachable.add(value);
    for (const child of value instanceof Map ? value.values() : Object.values(value)) visit(child);
  };
  visit(names);
  expect(reachable.has(request.tools)).toBe(true);
  expect(reachable.has(request)).toBe(false);
  expect(reachable.has(request.input)).toBe(false);
});

test.each(['forced', 'allowed_tools'] as const)('unchanged flat %s choices and response frames keep their references', async mode => {
  const selector = { type: 'function' as const, name: 'read' };
  const request: CanonicalOpenAIResponsesPayload = { model: 'm', input: [], tools: [functionTool('read')], tool_choice: mode === 'forced' ? selector : { type: 'allowed_tools', mode: 'auto', tools: [selector] } };
  const { payload, names } = flattenNamespaceTools(request);
  expect(payload.tool_choice).toBe(request.tool_choice);
  expect(names.toolChoiceChanged).toBe(false);
  const item = { type: 'function_call' as const, id: 'item', call_id: 'call', name: 'read', arguments: '{}', status: 'completed' as const };
  const source: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame({ type: 'response.output_item.added', output_index: 0, item }),
    eventFrame({ type: 'response.function_call_arguments.done', item_id: 'item', output_index: 0, name: 'read', arguments: '{}' } as OpenAIResponsesStreamEvent),
    eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
    eventFrame({ type: 'response.completed', response: { ...emptyResult(), output: [item], tools: request.tools ?? undefined, tool_choice: request.tool_choice } }),
    doneFrame(),
  ];
  const restored = [];
  for await (const frame of restoreNamespaceEvents((async function* () { yield* source; })(), names)) restored.push(frame);
  expect(restored).toHaveLength(source.length);
  restored.forEach((frame, index) => expect(frame).toBe(source[index]));
});
