import { expect, test } from 'vitest';

import { projectCallables } from '../../../../../src/data-plane/chat/openai-responses/interceptors/callable-projection.ts';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { canonicalizeOpenAIResponsesPayload, TranslatorInputError, translateOpenAIResponsesViaAnthropicMessages, translateOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const namespace = (name: string): OpenAIResponsesTool => ({ type: 'namespace', name: 'files', description: 'File policy.', tools: [{ type: 'function', name }] });
const freeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

for (const target of ['chat', 'messages'] as const) {
  const translate = async (source: OpenAIResponsesRequestPayload) => {
    const { payload } = projectCallables(canonicalizeOpenAIResponsesPayload(source));
    if (target === 'chat') {
      const { target: request } = await translateOpenAIResponsesViaOpenAIChatCompletions(payload, { model: 'm' });
      return {
        tools: request.tools?.map(tool => tool.type === 'function' ? tool.function.name : ''),
        calls: request.messages.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []),
      };
    }
    const { target: request } = await translateOpenAIResponsesViaAnthropicMessages(payload, { model: 'm', loadRemoteImage: async () => { throw new Error('Unexpected image in callable identity fixture'); } });
    return {
      tools: request.tools?.map(tool => tool.name),
      calls: request.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool_use' ? [block.name] : []) : []),
    };
  };

  test.each(['function', 'custom'] as const)(`${target} selects a same-name %s without widening the subset`, async kind => {
    const source: OpenAIResponsesRequestPayload = { model: 'm', input: [], tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }], tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: kind, name: 'read' }] } };
    expect(await translate(source)).toEqual({ tools: [kind === 'function' ? 'read' : 'read_2'], calls: [] });
    source.tool_choice = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'read' }, { type: 'custom', name: 'read' }] };
    expect(await translate(source)).toEqual({ tools: ['read', 'read_2'], calls: [] });
  });

  test(`${target} separates historical function and current custom without a namespace trigger`, async () => {
    const source = freeze<OpenAIResponsesRequestPayload>({
      model: 'm', tools: [{ type: 'custom', name: 'read' }],
      input: [{ type: 'function_call', name: 'read', call_id: 'old', arguments: '{}', status: 'completed' }],
    });
    expect(await translate(source)).toEqual({ tools: ['read'], calls: ['read_2'] });
    expect(await translate(source)).toEqual({ tools: ['read'], calls: ['read_2'] });
  });

  test(`${target} maps all declaration carriers and replay through the same inventory`, async () => {
    const source = freeze<OpenAIResponsesRequestPayload>({
      model: 'm', tools: [namespace('read')],
      input: [
        { type: 'tool_search_output', tools: [namespace('write')] },
        { type: 'additional_tools', role: 'developer', tools: [namespace('inspect')] },
        { type: 'function_call', name: 'write', namespace: 'files', call_id: 'old', arguments: '{}', status: 'completed' },
      ],
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'namespace', name: 'files' }] },
    });
    expect(await translate(source)).toEqual({ tools: ['files_read', 'files_write', 'files_inspect'], calls: ['files_write'] });
  });

  test(`${target} rejects a namespace selector even when history allocated its missing declaration`, async () => {
    const source: OpenAIResponsesRequestPayload = {
      model: 'm', tools: [namespace('read')],
      input: [{ type: 'function_call', name: 'missing', namespace: 'files', call_id: 'old', arguments: '{}', status: 'completed' }],
      tool_choice: { type: 'function', namespace: 'files', name: 'missing' },
    };
    await expect(translate(source)).rejects.toBeInstanceOf(TranslatorInputError);
    source.tool_choice = { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', namespace: 'files', name: 'missing' }] };
    await expect(translate(source)).rejects.toBeInstanceOf(TranslatorInputError);
  });

  test.each(['.', '__'])(`${target} preserves literal historical names containing %s beside a namespaced custom tool`, async separator => {
    const name = `files${separator}read`;
    const source: OpenAIResponsesRequestPayload = {
      model: 'm', tools: [{ type: 'namespace', name: 'files', description: '', tools: [{ type: 'custom', name: 'read' }] }],
      input: [{ type: 'function_call', name, call_id: 'old', arguments: '{}', status: 'completed' }],
    };
    expect(await translate(source)).toEqual({ tools: ['files_read'], calls: [name] });
    source.tool_choice = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'custom', name }] };
    await expect(translate(source)).rejects.toBeInstanceOf(TranslatorInputError);
  });
}
