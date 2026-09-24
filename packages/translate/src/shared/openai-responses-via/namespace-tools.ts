import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent, type OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

export interface NamespaceToolNames {
  targetToSource: ReadonlyMap<string, CallableIdentity>;
  request: CanonicalOpenAIResponsesPayload;
  toolsChanged: boolean;
  toolChoiceChanged: boolean;
}

export interface CallableIdentity {
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

export const flattenNamespaceTools = (request: CanonicalOpenAIResponsesPayload): {
  payload: CanonicalOpenAIResponsesPayload;
  names: NamespaceToolNames;
} => {
  // additional_tools is a Standard input item as well as a persisted source
  // carrier. Translated targets need its declarations at request level, but
  // canonical/native history must retain the original item and its position.
  // https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L4265-L4285
  const carriers = request.input.filter(item => item.type === 'additional_tools' || item.type === 'tool_search_output');
  for (const carrier of carriers) {
    if ((carrier.type === 'additional_tools' && carrier.role !== 'developer') || !Array.isArray(carrier.tools)
      || carrier.tools.some(tool => typeof tool !== 'object' || typeof tool?.type !== 'string'
        || ((tool.type === 'function' || tool.type === 'custom') && !isCallableTool(tool)))) {
      throw new TranslatorInputError(`Cannot project a malformed OpenAI Responses ${carrier.type} item`);
    }
  }
  const declared = carriers.length === 0 ? request.tools ?? [] : [...(request.tools ?? []), ...carriers.flatMap(carrier => carrier.tools)];
  const choice = request.tool_choice;
  if (typeof choice === 'object' && choice !== null && choice.type === 'allowed_tools' && !Array.isArray(choice.tools)) {
    throw new TranslatorInputError('Cannot translate malformed allowed_tools tools array.');
  }
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
  const namespaceLengths = new Set<number>();
  const identities = new Map<string, CallableIdentity>();
  const allocate = (source: CallableIdentity): string => {
    let scope = scopes.get(source.namespace);
    if (scope === undefined) {
      scope = new Map();
      scopes.set(source.namespace, scope);
      if (source.namespace !== undefined) namespaceLengths.add(source.namespace.length);
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
  const namespaceSelectors = choices.some(selector => selector?.type === 'namespace')
    ? new Map<string, Array<{ type: 'function' | 'custom'; name: string }>>() : undefined;
  for (const tool of declared) {
    if (tool.type !== 'namespace') {
      const name = isCallableTool(tool) ? allocate(toolIdentity(tool)) : undefined;
      tools.push(name !== undefined && isCallableTool(tool) && name !== tool.name ? { ...tool, name } : tool);
      continue;
    }
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new TranslatorInputError('Cannot flatten a malformed OpenAI Responses namespace');
    const selectors = namespaceSelectors?.get(tool.name) ?? [];
    namespaceSelectors?.set(tool.name, selectors);
    for (const child of tool.tools) {
      if (!isCallableTool(child)) throw new TranslatorInputError(`Cannot flatten a non-callable tool in namespace ${tool.name}`);
      const name = allocate(toolIdentity(child, tool.name));
      if (namespaceSelectors !== undefined) selectors.push({ type: child.type, name });
      tools.push({
        ...child,
        name,
        ...(tool.description ? { description: child.description ? `${tool.description}\n\n${child.description}` : tool.description } : {}),
      });
    }
  }
  const declaredNames = new Set(identities.keys());
  // Qualified Standard names are already accepted by the translators. Resolve
  // them through the same structured scope index rather than storing repeated
  // `namespace.child` strings; explicit flat declarations retain priority.
  const canonicalIdentity = (source: CallableIdentity): CallableIdentity => {
    if (typeof source.name !== 'string' || (source.namespace !== undefined && typeof source.namespace !== 'string')) {
      throw new TranslatorInputError('Cannot flatten a malformed OpenAI Responses callable identity');
    }
    if (source.namespace !== undefined || flatNames.has(source.name)) return source;
    let qualified: CallableIdentity | undefined;
    // Only registered scope lengths can split a qualified name, including
    // explicit scopes from replay-only history. Scanning every dot would
    // repeatedly hash growing, undeclared prefixes of long names.
    for (const length of namespaceLengths) {
      const separatorLength = source.name[length] === '.' ? 1 : source.name.startsWith('__', length) ? 2 : 0;
      if (separatorLength === 0) continue;
      const namespace = source.name.slice(0, length);
      const name = source.name.slice(length + separatorLength);
      if (!scopes.get(namespace)?.has(name)) continue;
      if (qualified !== undefined) throw new TranslatorInputError(`Ambiguous qualified OpenAI Responses callable name '${source.name}'`);
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
  const input = request.input.filter(item => item.type !== 'additional_tools' && item.type !== 'tool_search_output').map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? rename(item, item.type) : item);
  const renameChoice = <T>(value: T): T => {
    if (!isCallableTool(value)) return value;
    const callable = value as T & { name: string; namespace?: string };
    const source = canonicalIdentity({ name: callable.name, namespace: callable.namespace, type: value.type === 'function' ? 'function_call' : 'custom_tool_call' });
    const name = scopes.get(source.namespace)?.get(source.name)?.get(source.type);
    // Replay may allocate an identity without declaring it callable this turn.
    // Selectors must resolve through the declaration set, never allocate names.
    if (source.namespace !== undefined && (name === undefined || !declaredNames.has(name))) {
      throw new TranslatorInputError(`Cannot translate tool_choice / allowed_tools selector for undeclared namespace tool '${source.namespace}.${source.name}'.`);
    }
    if (name === undefined || !declaredNames.has(name)) return value;
    const next = { ...callable, name };
    delete next.namespace;
    return next;
  };
  let toolChoice = request.tool_choice;
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    if (toolChoice.type === 'function' || toolChoice.type === 'custom') toolChoice = renameChoice(toolChoice);
    else if (toolChoice.type === 'allowed_tools') {
      const originalTools = toolChoice.tools;
      const mapped = originalTools.flatMap(tool => {
        if (typeof tool !== 'object' || tool === null) throw new TranslatorInputError('Cannot translate malformed allowed_tools selector.');
        if (tool.type !== 'namespace') return [renameChoice(tool)];
        const selectors = typeof tool.name === 'string' ? namespaceSelectors?.get(tool.name) : undefined;
        if (selectors === undefined) throw new TranslatorInputError(`Cannot select undeclared namespace '${String(tool.name)}'.`);
        if (Object.keys(tool).some(key => key !== 'type' && key !== 'name')) {
          throw new TranslatorInputError('Cannot translate namespace selector extensions.');
        }
        return selectors;
      });
      if (mapped.length !== originalTools.length || mapped.some((tool, index) => tool !== originalTools[index])) toolChoice = { ...toolChoice, tools: mapped };
    }
  }
  return {
    payload: { ...request, input, ...(request.tools == null && carriers.length === 0 ? {} : { tools }), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) },
    names: { targetToSource: identities, request, toolsChanged: carriers.length > 0 || request.tools?.some(tool => tool.type === 'namespace') === true || tools.some((tool, index) => tool !== request.tools?.[index]), toolChoiceChanged: toolChoice !== request.tool_choice },
  };
};

// Restore source identity at the translation boundary so callers, persistence,
// and gateway shims only observe Standard callable names and kinds.
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

export const restoreNamespaceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  names: NamespaceToolNames,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const { targetToSource: identities, request, toolsChanged, toolChoiceChanged } = names;
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
        ...(event.response.tool_choice === undefined || !toolChoiceChanged ? {} : { tool_choice: request.tool_choice }),
      };
      if (toolsChanged && event.response.tools !== undefined) {
        if (request.tools == null) delete response.tools;
        else response.tools = request.tools;
      }
      yield { ...frame, event: { ...event, response } } as ProtocolFrame<OpenAIResponsesStreamEvent>;
    } else yield frame;
  }
};
