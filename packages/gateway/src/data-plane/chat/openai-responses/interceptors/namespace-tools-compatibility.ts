import type { OpenAIResponsesInterceptor } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent, type OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

interface CallableIdentity {
  readonly name: string;
  readonly namespace?: string;
  readonly type: 'function_call' | 'custom_tool_call';
}

const isCallableTool = (value: unknown): value is Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }> =>
  typeof value === 'object' && value !== null && 'type' in value && 'name' in value
  && (value.type === 'function' || value.type === 'custom') && typeof value.name === 'string';
const toolIdentity = (tool: Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>, namespace?: string): CallableIdentity =>
  ({ name: tool.name, ...(namespace === undefined ? {} : { namespace }), type: tool.type === 'function' ? 'function_call' : 'custom_tool_call' });

// Both translated targets accept this common callable-name alphabet; Chat's
// 64-character bound also limits names allocated for Anthropic Messages.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/shared.ts
const MAX_FLAT_TOOL_NAME_LENGTH = 64;

const flattenNamespaces = (request: CanonicalOpenAIResponsesPayload): {
  payload: CanonicalOpenAIResponsesPayload;
  identities: ReadonlyMap<string, CallableIdentity>;
} => {
  const declared = request.tools ?? [];
  const choice = request.tool_choice;
  const choices = typeof choice === 'object' && choice !== null ? choice.type === 'allowed_tools' ? choice.tools : [choice] : [];
  const history = request.input.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call');
  // Reserve flat history/choices too: a continuation can change or omit its tool
  // declarations, but a past callable must never alias a newly declared one.
  const flatNames = new Set(declared.filter(isCallableTool).map(tool => tool.name));
  const reserved = new Set(flatNames);
  for (const item of [...history, ...choices.filter(isCallableTool)]) {
    if ('name' in item && typeof item.name === 'string' && (!('namespace' in item) || item.namespace === undefined)) reserved.add(item.name);
  }
  const nextSuffixes = new Map<string, number>();
  // Scope text is stored once, not serialized into a key for every child.
  // Kind is part of identity: a historical function may share namespace/name
  // with a current custom declaration without borrowing its wire identity.
  const scopes = new Map<string | undefined, Map<string, Map<CallableIdentity['type'], string>>>();
  const identities = new Map<string, CallableIdentity>();
  const allocate = (source: CallableIdentity): string => {
    let scope = scopes.get(source.namespace);
    if (scope === undefined) {
      scope = new Map();
      scopes.set(source.namespace, scope);
    }
    let kinds = scope.get(source.name);
    if (kinds === undefined) {
      kinds = new Map();
      scope.set(source.name, kinds);
    }
    const existing = kinds.get(source.type);
    if (existing !== undefined) return existing;

    // Keep a flat spelling when no other callable owns it. Only allocated
    // aliases use the common alphabet; do not rewrite unrelated flat tools.
    let name = source.name;
    if (source.namespace !== undefined || identities.has(name)) {
      // Bound the input before concatenating or sanitizing. A long shared scope
      // must not be scanned/copied once per child just to discard its tail.
      const scopePrefix = source.namespace === undefined ? '' : `${source.namespace.slice(0, MAX_FLAT_TOOL_NAME_LENGTH)}_`.slice(0, MAX_FLAT_TOOL_NAME_LENGTH);
      const preferred = `${scopePrefix}${source.name.slice(0, MAX_FLAT_TOOL_NAME_LENGTH - scopePrefix.length)}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
      name = preferred;
      if (reserved.has(name)) {
        let index = 2;
        for (;;) {
          const suffix = `_${index}`;
          const prefix = preferred.slice(0, MAX_FLAT_TOOL_NAME_LENGTH - suffix.length);
          // A shorter preferred name can still have unused one-digit suffixes.
          // Share cursors by the actual truncated prefix and suffix width.
          const cursorKey = `${suffix.length}:${prefix}`;
          const next = nextSuffixes.get(cursorKey);
          if (next !== undefined && next > index) {
            index = next;
            continue;
          }
          name = `${prefix}${suffix}`;
          nextSuffixes.set(cursorKey, index + 1);
          if (!reserved.has(name)) break;
          index++;
        }
      }
    }
    reserved.add(name);
    kinds.set(source.type, name);
    identities.set(name, source);
    return name;
  };
  const tools: OpenAIResponsesTool[] = [];
  for (const tool of declared) {
    if (tool.type !== 'namespace') {
      tools.push(isCallableTool(tool) ? { ...tool, name: allocate(toolIdentity(tool)) } : tool);
      continue;
    }
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new TypeError('Cannot flatten a malformed OpenAI Responses namespace');
    for (const child of tool.tools) {
      if (!isCallableTool(child)) throw new TypeError(`Cannot flatten a non-callable tool in namespace ${tool.name}`);
      tools.push({ ...child, name: allocate(toolIdentity(child, tool.name)) });
    }
  }
  // Qualified Standard names are already accepted by the translators. Resolve
  // them through the same structured scope index rather than storing repeated
  // `namespace.child` strings; explicit flat declarations retain priority.
  const canonicalIdentity = (source: CallableIdentity): CallableIdentity => {
    if (source.namespace !== undefined || flatNames.has(source.name)) return source;
    let qualified: CallableIdentity | undefined;
    for (let dot = source.name.indexOf('.'); dot !== -1; dot = source.name.indexOf('.', dot + 1)) {
      const namespace = source.name.slice(0, dot);
      const name = source.name.slice(dot + 1);
      if (!scopes.get(namespace)?.has(name)) continue;
      if (qualified !== undefined) throw new TypeError(`Ambiguous qualified OpenAI Responses callable name '${source.name}'`);
      qualified = { ...source, namespace, name };
    }
    return qualified ?? source;
  };
  const rename = <T extends { name: string; namespace?: string }>(value: T, type: CallableIdentity['type']): T => {
    const source = canonicalIdentity({ name: value.name, namespace: value.namespace, type });
    const name = allocate(source);
    if (name === value.name && value.namespace === undefined) return value;
    const next = { ...value, name };
    delete next.namespace;
    return next;
  };
  const input = request.input.map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? rename(item, item.type) : item);
  const renameChoice = <T>(value: T): T => {
    if (!isCallableTool(value)) return value;
    return rename(value as T & { name: string; namespace?: string }, value.type === 'function' ? 'function_call' : 'custom_tool_call');
  };
  let toolChoice = request.tool_choice;
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    if (toolChoice.type === 'function' || toolChoice.type === 'custom') toolChoice = renameChoice(toolChoice);
    else if (toolChoice.type === 'allowed_tools') {
      const originalTools = toolChoice.tools;
      const mapped = originalTools.map(renameChoice);
      if (mapped.some((tool, index) => tool !== originalTools[index])) toolChoice = { ...toolChoice, tools: mapped };
    }
  }
  return {
    payload: { ...request, input, ...(request.tools == null ? {} : { tools }), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) },
    identities,
  };
};

// Restore Standard identity before the outer shims inspect events or the source
// edge persists them. No representation-specific names survive into history.
const restoreItem = (item: OpenAIResponsesOutputItem, identities: ReadonlyMap<string, CallableIdentity>, status: 'in_progress' | 'completed'): OpenAIResponsesOutputItem => {
  if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.namespace !== undefined) return item;
  const identity = identities.get(item.name);
  if (identity === undefined) return item;
  const restored = { ...item, name: identity.name, type: identity.type } as Record<string, unknown>;
  if (identity.namespace !== undefined) restored.namespace = identity.namespace;
  if (identity.type === 'function_call' && item.type === 'custom_tool_call') {
    restored.arguments = item.input;
    delete restored.input;
    restored.status ??= status;
  } else if (identity.type === 'custom_tool_call' && item.type === 'function_call') {
    restored.input = item.arguments;
    delete restored.arguments;
  }
  return restored as unknown as OpenAIResponsesOutputItem;
};

const restoreFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  identities: ReadonlyMap<string, CallableIdentity>,
  request: CanonicalOpenAIResponsesPayload,
  toolChoiceChanged: boolean,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const items = new Map<string, CallableIdentity>();
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    const identity = 'item_id' in event ? items.get(event.item_id) : undefined;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = restoreItem(event.item, identities, event.type === 'response.output_item.added' ? 'in_progress' : 'completed');
      if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.id === 'string') items.set(item.id, { name: item.name, namespace: item.namespace, type: item.type });
      yield { ...frame, event: { ...event, item } };
    } else if (event.type === 'response.function_call_arguments.delta' && identity?.type === 'custom_tool_call') {
      yield { ...frame, event: { ...event, type: 'response.custom_tool_call_input.delta' } };
    } else if (event.type === 'response.function_call_arguments.done' && identity !== undefined) {
      // Function arguments.done requires a bare name, not a namespace. Custom
      // input.done has neither field; changing families must not leak a wire name.
      // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts
      if (identity.type === 'function_call') {
        yield { ...frame, event: { ...event, name: identity.name } } as ProtocolFrame<OpenAIResponsesStreamEvent>;
      } else {
        const { arguments: input, name: _name, ...rest } = event as typeof event & { name?: string };
        yield { ...frame, event: { ...rest, type: 'response.custom_tool_call_input.done', input } };
      }
    } else if (event.type === 'response.custom_tool_call_input.delta' && identity?.type === 'function_call') {
      yield { ...frame, event: { ...event, type: 'response.function_call_arguments.delta' } };
    } else if (event.type === 'response.custom_tool_call_input.done' && identity?.type === 'function_call') {
      const { input: args, ...rest } = event;
      yield { ...frame, event: { ...rest, type: 'response.function_call_arguments.done', arguments: args, name: identity.name } } as ProtocolFrame<OpenAIResponsesStreamEvent>;
    } else if ('response' in event && Array.isArray(event.response?.output)) {
      const response: OpenAIResponsesResult = {
        ...event.response,
        output: event.response.output.map(item => restoreItem(item, identities, isOpenAIResponsesTerminalEvent(event) ? 'completed' : 'in_progress')),
        // Preserve absent echoes; only undo fields actually stated by the
        // translated result. The outer shim must not observe invented tools.
        ...(event.response.tools === undefined || !request.tools?.some(tool => tool.type === 'namespace') ? {} : { tools: request.tools }),
        ...(event.response.tool_choice === undefined || !toolChoiceChanged ? {} : { tool_choice: request.tool_choice }),
      };
      yield { ...frame, event: { ...event, response } } as ProtocolFrame<OpenAIResponsesStreamEvent>;
    } else yield frame;
  }
};

// Runs on a private invocation at the final Standard -> translated-protocol
// boundary, after history hydration and compact expansion. It is not a Lite or
// provider adapter, and native Responses retains its own namespace surface.
export const withOpenAIResponsesNamespaceToolsCompatibility: OpenAIResponsesInterceptor = async (invocation, _ctx, run) => {
  if (invocation.targetApi === 'openaiResponses') return await run();
  const request = invocation.payload;
  const choice = request.tool_choice;
  const hasNamespacedChoice = typeof choice === 'object' && choice !== null
    && ((isCallableTool(choice) && 'namespace' in choice) || (choice.type === 'allowed_tools' && choice.tools.some(tool => isCallableTool(tool) && 'namespace' in tool)));
  if (!request.tools?.some(tool => tool.type === 'namespace')
    && !request.input.some(item => (item.type === 'function_call' || item.type === 'custom_tool_call') && item.namespace !== undefined)
    && !hasNamespacedChoice) return await run();
  const bridge = flattenNamespaces(request);
  invocation.payload = bridge.payload;
  const result = await run();
  return result.type === 'events' ? { ...result, events: restoreFrames(result.events, bridge.identities, request, bridge.payload.tool_choice !== request.tool_choice) } : result;
};
