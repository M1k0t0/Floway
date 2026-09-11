import { test, vi } from 'vitest';

import { normalizeResponsesIngress, responsesLiteSuccessHeaders, restoreResponsesLiteEchoes, wrapResponsesLiteClientEchoes } from '../../../src/data-plane/codex/responses-lite.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesResult, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const functionTool: OpenAIResponsesTool = { type: 'function', name: 'read', parameters: { type: 'object' } };
const toolsItem: OpenAIResponsesInputItem = { type: 'additional_tools', role: 'developer', tools: [functionTool] };
const baseMessage = (text = 'base rules'): OpenAIResponsesInputItem => ({
  type: 'message', role: 'developer', content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
} as OpenAIResponsesInputItem);
const makeRequest = (overrides: Record<string, unknown> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'test-model', input: [toolsItem, baseMessage(), { type: 'message', role: 'user', content: 'hello' }], ...overrides,
} as CanonicalOpenAIResponsesPayload);
const liteHeaders = (): Headers => new Headers({ 'x-openai-internal-codex-responses-lite': 'true' });

test('Responses Lite ingress recognizes only literal explicit controls and consumes reserved markers on copies', () => {
  for (const [header, metadata, enabled] of [
    ['true', undefined, true], [' TRUE ', undefined, true], ['false', 'true', true], [undefined, 'true', true],
    [undefined, true, false], [undefined, 'TRUE', false], ['1', undefined, false], ['false', 'false', false], [undefined, undefined, false],
  ] as const) {
    const request = makeRequest({ client_metadata: { keep: { nested: true }, ws_request_header_x_openai_internal_codex_responses_lite: metadata }, metadata: { untouched: true }, extension: { vendor: true } });
    const original = structuredClone(request);
    const headers = new Headers({ 'x-request-id': 'caller' });
    if (header !== undefined) headers.set('x-openai-internal-codex-responses-lite', header);
    const originalHeaders = [...headers];
    const normalized = normalizeResponsesIngress(request, headers);
    assertEquals(normalized.clientView !== undefined, enabled);
    assertEquals(normalized.payload.input.some(item => item.type === 'additional_tools'), !enabled);
    assertEquals(normalized.payload.instructions, enabled ? 'base rules' : undefined);
    assertEquals((normalized.payload as unknown as Record<string, unknown>).client_metadata, { keep: { nested: true } });
    assertEquals(normalized.payload.metadata, { untouched: true });
    assertEquals((normalized.payload as unknown as Record<string, unknown>).extension, { vendor: true });
    assertEquals(normalized.headers.get('x-openai-internal-codex-responses-lite'), null);
    assertEquals(normalized.headers.get('x-request-id'), 'caller');
    assertEquals(request, original);
    assertEquals([...headers], originalHeaders);
  }
});

test('Responses Lite ingress does not infer format from additional_tools or change marker-free Standard payloads', () => {
  const request = makeRequest({ client_metadata: { future: 'kept' } });
  const result = normalizeResponsesIngress(request, new Headers());
  assert(result.payload === request);
  assertEquals(result.clientView, undefined);
  const noTools = makeRequest({ input: [], tools: null, instructions: null });
  assertEquals(normalizeResponsesIngress(noTools, liteHeaders()).payload, noTools);
});

test('Responses Lite ingress collects top tools and every carrier in order without deduplicating declarations', () => {
  const future = { type: 'future_tool', extension: { opaque: true } } as unknown as OpenAIResponsesTool;
  const namespace: OpenAIResponsesTool = { type: 'namespace', name: 'files', description: 'Files', tools: [functionTool, { type: 'custom', name: 'edit', format: { type: 'text' } }] };
  const input: OpenAIResponsesInputItem[] = [
    { ...toolsItem, tools: [namespace, functionTool] }, baseMessage(),
    { type: 'message', role: 'user', content: 'hello' },
    { ...toolsItem, tools: [future, namespace] },
  ];
  const result = normalizeResponsesIngress(makeRequest({ input, tools: [functionTool, future] }), liteHeaders());
  assertEquals(result.payload.tools, [functionTool, future, namespace, functionTool, future, namespace]);
  assertEquals(result.payload.input, [input[2]]);
  assertEquals(result.payload.instructions, 'base rules');
  assertEquals(namespace.tools[0]?.name, 'read');
});

test('Responses Lite ingress collects a large repeated carrier without spreading it into function arguments', () => {
  const count = 150_000;
  const top = { type: 'function', name: 'first' };
  const last = { type: 'custom', name: 'last' };
  const request = makeRequest({ tools: [top], input: [{ ...toolsItem, tools: Array.from({ length: count }, () => functionTool) }, { ...toolsItem, tools: [last] }] });
  const result = normalizeResponsesIngress(request, liteHeaders());
  assertEquals(result.payload.tools?.length, count + 2);
  assert(result.payload.tools?.[0] === top);
  assert(result.payload.tools?.[1] === functionTool);
  assert(result.payload.tools?.[count] === functionTool);
  assert(result.payload.tools?.[count + 1] === last);
  assertEquals(result.payload.input, []);
});

test('Responses Lite ingress promotes only a nonempty exact base carrier immediately after leading tools', () => {
  for (const instructions of [undefined, null, '', 'top rules', ' ']) {
    const request = makeRequest({ instructions });
    const result = normalizeResponsesIngress(request, liteHeaders());
    const promoted = instructions === undefined || instructions === null || instructions === '';
    assertEquals(result.payload.instructions, promoted ? 'base rules' : instructions);
    assertEquals(result.payload.input.includes(request.input[1]!), !promoted);
  }
  const exact = baseMessage();
  const invalid: OpenAIResponsesInputItem[] = [
    baseMessage(''),
    { ...exact, content: [{ type: 'input_text', text: 'base' }, { type: 'input_text', text: 'extra' }] } as OpenAIResponsesInputItem,
    { ...exact, content: 'base' } as OpenAIResponsesInputItem,
    { ...exact, role: 'system' } as OpenAIResponsesInputItem,
    { ...exact, internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions', 'other'] } } as OpenAIResponsesInputItem,
    { ...exact, internal_chat_message_metadata_passthrough: { content_item_kinds: ['other'] } } as OpenAIResponsesInputItem,
  ];
  for (const message of invalid) {
    const result = normalizeResponsesIngress(makeRequest({ input: [toolsItem, message] }), liteHeaders());
    assertEquals(result.payload.input, [message]);
    assertEquals(result.payload.instructions, undefined);
  }
  for (const input of [[exact, toolsItem], [toolsItem, { type: 'message', role: 'user', content: 'first' }, exact]]) {
    const result = normalizeResponsesIngress(makeRequest({ input }), liteHeaders());
    assertEquals(result.payload.input, input.filter(item => item !== toolsItem));
    assertEquals(result.payload.instructions, undefined);
  }
});

test('Responses Lite ingress preserves malformed and future carriers rather than consuming unknown history', () => {
  const input = [
    { type: 'additional_tools', role: 'user', tools: [functionTool] },
    { type: 'additional_tools', role: 'developer', tools: [functionTool], id: 42 },
    { type: 'additional_tools', role: 'developer', tools: null },
    { type: 'future_context', value: 'opaque' },
  ];
  const result = normalizeResponsesIngress(makeRequest({ input }), liteHeaders());
  assertEquals(result.payload.input, input);
  assertEquals(result.payload.tools, undefined);
});

test('Responses Lite ingress makes implicit namespace identities explicit without allocating wire names', () => {
  const namespace = { type: 'namespace', name: 'functions', description: '', tools: [functionTool] };
  const request = makeRequest({
    input: [{ ...toolsItem, tools: [namespace] },
      { type: 'function_call', name: 'read', call_id: 'call_1', arguments: '{}', status: 'completed' },
      { type: 'function_call', name: 'functions.read', call_id: 'call_2', arguments: '{}', status: 'completed' }],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read' }, { type: 'future', name: 'other', extra: true }] },
  });
  const result = normalizeResponsesIngress(request, liteHeaders());
  assertEquals(result.payload.input.map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? [item.name, item.namespace] : null), [['read', 'functions'], ['read', 'functions']]);
  assertEquals(result.payload.tools, [namespace]);
  assertEquals(result.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'functions' }, { type: 'future', name: 'other', extra: true }] });
  assertEquals(result.clientView?.toolChoiceChanged, true);
  const withFlat = normalizeResponsesIngress({ ...request, tools: [functionTool] }, liteHeaders());
  assertEquals((withFlat.payload.input[0] as { namespace?: string }).namespace, undefined);
});

test('Responses Lite qualification preserves historical kinds when default-namespace declarations change kind', () => {
  const request = makeRequest({
    input: [
      { type: 'function_call', name: 'read', call_id: 'old', arguments: '{}', status: 'completed' },
      { type: 'function_call', name: 'functions.read', call_id: 'qualified', arguments: '{}', status: 'completed' },
    ],
    tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'custom', name: 'read' }] }],
  });
  const result = normalizeResponsesIngress(request, liteHeaders());
  assertEquals(result.payload.input, [
    { type: 'function_call', name: 'read', namespace: 'functions', call_id: 'old', arguments: '{}', status: 'completed' },
    { type: 'function_call', name: 'read', namespace: 'functions', call_id: 'qualified', arguments: '{}', status: 'completed' },
  ]);
});

test('Responses Lite qualification preserves named MCP and future allowed-tool selectors', () => {
  const selectors = [{ type: 'mcp', server_label: 'remote', name: 'functions.search' }, { type: 'future', name: 'functions.search' }];
  const request = makeRequest({
    tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'search' }] }],
    input: [],
    tool_choice: { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'search' }] },
  });
  const normalized = normalizeResponsesIngress(request, liteHeaders());
  assertEquals(normalized.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [...selectors, { type: 'function', name: 'search', namespace: 'functions' }] });
});

test('Responses Lite qualification stores a long namespace once rather than once per child', () => {
  const namespace = 'n'.repeat(4096);
  const count = 32;
  const request = makeRequest({ input: [], tools: [{ type: 'namespace', name: namespace, description: '', tools: Array.from({ length: count }, (_, index) => ({ type: 'function', name: `tool${index}` })) }] });
  const headers = liteHeaders();
  const keys = vi.spyOn(Map.prototype, 'set');
  let keyBytes: number;
  try {
    normalizeResponsesIngress(request, headers);
    keyBytes = keys.mock.calls.reduce((total, [key]) => total + (typeof key === 'string' ? key.length : 0), 0);
  } finally { keys.mockRestore(); }
  assert(keyBytes >= namespace.length, 'instrument must observe the qualification registry');
  assert(keyBytes <= namespace.length + count * 64, `qualification repeated the full namespace: ${keyBytes} key bytes`);
});

test('Responses Lite echoes keep caller omissions and extensions while leaving events and successful headers immutable', async () => {
  const request = makeRequest({ reasoning: { effort: 'future' }, parallel_tool_calls: true });
  const { clientView } = normalizeResponsesIngress(request, liteHeaders());
  assert(clientView !== undefined);
  const resource = { id: 'r', object: 'response', model: 'm', status: 'completed', output: [], output_text: '', error: null, incomplete_details: null, tools: [functionTool], instructions: 'lifted', reasoning: { context: 'all_turns' }, parallel_tool_calls: false, future: 'kept' } as OpenAIResponsesResult;
  const expected = { ...resource, reasoning: request.reasoning, parallel_tool_calls: true };
  delete expected.tools;
  delete expected.instructions;
  assertEquals(restoreResponsesLiteEchoes(resource, clientView), expected);
  assertEquals(resource.tools, [functionTool]);
  const done = doneFrame();
  const event = eventFrame({ type: 'response.completed' as const, response: resource });
  const frames = await Array.fromAsync(wrapResponsesLiteClientEchoes((async function* () { yield event; yield done; })(), clientView));
  assertEquals(frames[0], { ...event, event: { ...event.event, response: expected } });
  assert(frames[1] === done);
  const headers = new Headers({ 'x-request-id': 'upstream' });
  const marked = responsesLiteSuccessHeaders(headers, clientView);
  assertEquals(marked?.get('x-openai-internal-codex-responses-lite'), 'true');
  assertEquals(headers.get('x-openai-internal-codex-responses-lite'), null);
  assert(responsesLiteSuccessHeaders(headers, undefined) === headers);
});
