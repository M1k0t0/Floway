import { v5 as uuidV5 } from 'uuid';

import {
  CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY,
  CODEX_RESPONSES_LITE_HEADER,
} from './constants.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesCompactionResult,
  OpenAIResponsesInputAdditionalToolsItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesOutputItem,
  OpenAIResponsesResult,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

export type CodexResponsesBody = Omit<CanonicalOpenAIResponsesPayload, 'model'>;

interface CallableIdentity {
  name: string;
  namespace?: string;
  type: 'function_call' | 'custom_tool_call';
}

export interface CodexResponsesCallableIdentityMap {
  readonly byWireName: ReadonlyMap<string, CallableIdentity>;
}

export interface CodexResponsesRequestEchoes {
  readonly tools?: CodexResponsesBody['tools'];
  readonly tool_choice?: CodexResponsesBody['tool_choice'];
  readonly instructions?: CodexResponsesBody['instructions'];
  readonly parallel_tool_calls?: CodexResponsesBody['parallel_tool_calls'];
  readonly reasoning?: CodexResponsesBody['reasoning'];
}

export interface CodexResponsesBridgeResult {
  body: CodexResponsesBody;
  callableIdentities: CodexResponsesCallableIdentityMap;
  requestEchoes?: CodexResponsesRequestEchoes;
}

// Official Codex folds flat function/custom tools into this namespace and tags
// the following developer message with this content kind.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tools/src/tool_spec.rs#L95-L141
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/context/base_instructions.rs#L5-L12
const DEFAULT_FUNCTION_NAMESPACE = 'functions';
const BASE_INSTRUCTIONS_CONTENT_KIND = 'model.base_instructions';
// RFC 9562's namespace UUID for ISO object identifiers, matching
// `Uuid::NAMESPACE_OID` in official Codex's Responses Lite ID derivation.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L938-L965
// https://www.rfc-editor.org/rfc/rfc9562.html#name-namespace-id-usage-and-allo
const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCallableTool = (
  value: unknown,
): value is Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }> =>
  isRecord(value)
  && (value.type === 'function' || value.type === 'custom')
  && typeof value.name === 'string';

const isNamespaceTool = (
  value: unknown,
): value is Extract<OpenAIResponsesTool, { type: 'namespace' }> =>
  isRecord(value)
  && value.type === 'namespace'
  && typeof value.name === 'string'
  && typeof value.description === 'string'
  && Array.isArray(value.tools);

const isAdditionalToolsItem = (
  value: unknown,
): value is OpenAIResponsesInputAdditionalToolsItem =>
  isRecord(value)
  && value.type === 'additional_tools'
  && value.role === 'developer'
  && Array.isArray(value.tools)
  && (value.id === undefined || value.id === null || typeof value.id === 'string');

export const clientMetadataFrom = (body: CodexResponsesBody): Record<string, unknown> | undefined => {
  const metadata = (body as unknown as Record<string, unknown>).client_metadata;
  return isRecord(metadata) ? metadata : undefined;
};

export const downstreamRequestsCodexResponsesLite = (
  headers: Headers,
  body: CodexResponsesBody,
): boolean =>
  headers.get(CODEX_RESPONSES_LITE_HEADER)?.trim().toLowerCase() === 'true'
  || clientMetadataFrom(body)?.[CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY] === 'true';

const callableKey = (namespace: string | undefined, name: string): string =>
  JSON.stringify([namespace ?? null, name]);

const sameIdentity = (left: CallableIdentity, right: CallableIdentity): boolean =>
  left.name === right.name
  && left.namespace === right.namespace
  && left.type === right.type;

const registerCallable = (
  entries: Map<string, CallableIdentity>,
  wire: CallableIdentity,
  downstream: CallableIdentity,
): void => {
  const key = callableKey(wire.namespace, wire.name);
  const current = entries.get(key);
  if (current !== undefined && !sameIdentity(current, downstream)) {
    throw new TypeError(`Codex Responses Lite cannot preserve distinct callable identities for ${key}`);
  }
  entries.set(key, downstream);
};

const identityForTool = (
  tool: Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>,
  namespace?: string,
): CallableIdentity => ({
  name: tool.name,
  ...(namespace === undefined ? {} : { namespace }),
  type: tool.type === 'function' ? 'function_call' : 'custom_tool_call',
});

const registerUnchangedTool = (
  entries: Map<string, CallableIdentity>,
  tool: OpenAIResponsesTool,
): void => {
  if (isCallableTool(tool)) {
    const identity = identityForTool(tool);
    registerCallable(entries, identity, identity);
    return;
  }
  if (!isNamespaceTool(tool)) return;
  for (const child of tool.tools) {
    if (!isCallableTool(child)) continue;
    const identity = identityForTool(child, tool.name);
    registerCallable(entries, identity, identity);
  }
};

// Collect the same two Responses declaration surfaces, in wire order, that
// CLIProxyAPI inventories before translating tools.
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/util/responses_tools.go#L65-L73
const collectTools = (body: CodexResponsesBody): OpenAIResponsesTool[] => {
  const tools: OpenAIResponsesTool[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) tools.push(tool);
  }
  for (const item of body.input) {
    if (!isAdditionalToolsItem(item)) continue;
    for (const tool of item.tools) tools.push(tool);
  }
  return tools;
};

const toolsForLite = (
  tools: readonly OpenAIResponsesTool[],
  entries: Map<string, CallableIdentity>,
): OpenAIResponsesTool[] => {
  const output: OpenAIResponsesTool[] = [];
  const functionChildren: Array<Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>> = [];
  let functionDescription = '';
  let functionIndex: number | undefined;

  for (const tool of tools) {
    if (isCallableTool(tool)) {
      functionIndex ??= output.length;
      functionChildren.push(tool);
      registerCallable(
        entries,
        identityForTool(tool, DEFAULT_FUNCTION_NAMESPACE),
        identityForTool(tool),
      );
      continue;
    }
    if (isNamespaceTool(tool) && tool.name === DEFAULT_FUNCTION_NAMESPACE) {
      functionIndex ??= output.length;
      if (tool.description.trim() !== '') functionDescription = tool.description;
      for (const child of tool.tools) {
        functionChildren.push(child);
        if (!isCallableTool(child)) continue;
        const identity = identityForTool(child, DEFAULT_FUNCTION_NAMESPACE);
        registerCallable(entries, identity, identity);
      }
      continue;
    }

    output.push(tool);
    registerUnchangedTool(entries, tool);
  }

  if (functionIndex !== undefined && functionChildren.length > 0) {
    output.splice(functionIndex, 0, {
      type: 'namespace',
      name: DEFAULT_FUNCTION_NAMESPACE,
      description: functionDescription,
      tools: functionChildren,
    });
  }

  return output;
};

const registerUnchangedTools = (
  tools: readonly OpenAIResponsesTool[],
  entries: Map<string, CallableIdentity>,
): void => {
  for (const tool of tools) registerUnchangedTool(entries, tool);
};

// Only consume Codex's exact one-fragment carrier. A mixed developer message
// may contain other classified context and must remain in the input intact.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/context-fragments/src/fragment.rs#L35-L51
const isBaseInstructionsMessage = (
  value: unknown,
): value is OpenAIResponsesInputMessage => {
  if (!isRecord(value) || value.type !== 'message' || value.role !== 'developer') return false;
  const metadata = value.internal_chat_message_metadata_passthrough;
  if (!isRecord(metadata) || !Array.isArray(metadata.content_item_kinds)) return false;
  if (
    metadata.content_item_kinds.length !== 1
    || metadata.content_item_kinds[0] !== BASE_INSTRUCTIONS_CONTENT_KIND
  ) return false;
  return Array.isArray(value.content)
    && value.content.length === 1
    && isRecord(value.content[0])
    && value.content[0].type === 'input_text'
    && typeof value.content[0].text === 'string';
};

const baseInstructionsText = (message: OpenAIResponsesInputMessage): string => {
  if (!Array.isArray(message.content)) return '';
  const part = message.content[0];
  return part !== undefined && 'text' in part && typeof part.text === 'string'
    ? part.text
    : '';
};

const makeThreadNamespace = (threadId: string): string =>
  uuidV5(threadId, UUID_NAMESPACE_OID);

const makeAdditionalToolsItem = (
  tools: OpenAIResponsesTool[],
  threadNamespace: string,
): OpenAIResponsesInputAdditionalToolsItem => ({
  type: 'additional_tools',
  role: 'developer',
  tools,
  id: `at_${uuidV5(JSON.stringify(tools), threadNamespace)}`,
});

const makeBaseInstructionsMessage = (
  instructions: string,
  threadNamespace: string,
): OpenAIResponsesInputMessage => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: instructions }],
  id: `msg_${uuidV5(instructions, threadNamespace)}`,
  internal_chat_message_metadata_passthrough: {
    content_item_kinds: [BASE_INSTRUCTIONS_CONTENT_KIND],
  },
});

// Codex strips this field only from message and callable-output image content;
// do not recurse into tool schemas, metadata, or unrelated extension objects.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client_common.rs#L56-L105
const removeInputImageDetail = <T extends { type: string }>(part: T): T => {
  if (part.type !== 'input_image' || !('detail' in part)) return part;
  const next = { ...part };
  delete (next as { detail?: unknown }).detail;
  return next;
};

const removeInputImageDetails = <T extends { type: string }>(parts: T[]): T[] =>
  parts.some(part => part.type === 'input_image' && 'detail' in part)
    ? parts.map(removeInputImageDetail)
    : parts;

const removeLiteImageDetail = (
  item: OpenAIResponsesInputItem,
): OpenAIResponsesInputItem => {
  if (item.type === 'message' && Array.isArray(item.content)) {
    const content = removeInputImageDetails(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (
    (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
    && Array.isArray(item.output)
  ) {
    const output = removeInputImageDetails(item.output);
    return output === item.output ? item : { ...item, output };
  }
  return item;
};

const lowerToLite = (
  body: CodexResponsesBody,
  threadId: string,
): CodexResponsesBridgeResult => {
  const next: CodexResponsesBody = { ...body };
  const tools = collectTools(body);
  const entries = new Map<string, CallableIdentity>();
  const leadingTools = isAdditionalToolsItem(body.input[0]) ? body.input[0] : undefined;
  const hasTopLevelTools = Array.isArray(body.tools) && body.tools.length > 0;
  const rebuildTools = leadingTools === undefined
    || hasTopLevelTools
    || body.input.some((item, index) => index > 0 && isAdditionalToolsItem(item));
  const threadNamespace = makeThreadNamespace(threadId);
  const input = rebuildTools
    ? body.input.filter(item => !isAdditionalToolsItem(item))
    : [...body.input];

  if (rebuildTools) {
    input.unshift(makeAdditionalToolsItem(toolsForLite(tools, entries), threadNamespace));
  } else {
    registerUnchangedTools(tools, entries);
  }

  if (Array.isArray(body.tools) || body.tools === null) delete next.tools;

  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    input.splice(1, 0, makeBaseInstructionsMessage(body.instructions, threadNamespace));
    delete next.instructions;
  } else if (body.instructions === undefined || body.instructions === null || body.instructions === '') {
    delete next.instructions;
  }

  next.input = input.map(removeLiteImageDetail);
  // These are model-side Lite wire controls, not downstream preferences.
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L920-L924
  // https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L1014-L1021
  next.parallel_tool_calls = false;
  next.reasoning = {
    ...(isRecord(body.reasoning) ? body.reasoning : {}),
    context: 'all_turns',
  };

  return {
    body: next,
    callableIdentities: { byWireName: entries },
  };
};

const withoutLiteClientMetadata = (body: CodexResponsesBody): CodexResponsesBody => {
  const metadata = clientMetadataFrom(body);
  if (!metadata || !(CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY in metadata)) return body;

  const nextMetadata = { ...metadata };
  delete nextMetadata[CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY];
  return {
    ...body,
    client_metadata: nextMetadata,
  } as CodexResponsesBody;
};

const liftToStandard = (body: CodexResponsesBody): CodexResponsesBridgeResult => {
  const next = withoutLiteClientMetadata({ ...body });
  const tools = collectTools(body);
  const entries = new Map<string, CallableIdentity>();
  registerUnchangedTools(tools, entries);

  const leadingTools = isAdditionalToolsItem(body.input[0]);
  const baseMessageIndex = leadingTools && isBaseInstructionsMessage(body.input[1]) ? 1 : undefined;
  const topLevelInstructionsEmpty = body.instructions === undefined
    || body.instructions === null
    || body.instructions === '';
  const promotedInstructions = baseMessageIndex === undefined
    ? undefined
    : baseInstructionsText(body.input[baseMessageIndex] as OpenAIResponsesInputMessage);
  const promoteInstructions = topLevelInstructionsEmpty
    && promotedInstructions !== undefined
    && promotedInstructions.length > 0;

  let hasAdditionalTools = false;
  next.input = body.input.filter((item, index) => {
    if (isAdditionalToolsItem(item)) {
      hasAdditionalTools = true;
      return false;
    }
    return !promoteInstructions || index !== baseMessageIndex;
  });

  if (hasAdditionalTools || Array.isArray(body.tools)) {
    next.tools = tools;
  }
  if (promoteInstructions) next.instructions = promotedInstructions;

  return {
    body: next,
    callableIdentities: { byWireName: entries },
  };
};

const withRequestEchoes = (
  bridge: CodexResponsesBridgeResult,
  body: CodexResponsesBody,
): CodexResponsesBridgeResult => ({
  ...bridge,
  // Resource-bearing events echo request fields in the upstream representation.
  // https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go
  requestEchoes: {
    tools: body.tools,
    instructions: body.instructions,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning: body.reasoning,
    ...(body.tool_choice === bridge.body.tool_choice ? {} : { tool_choice: body.tool_choice }),
  },
});

// Chat Completions function names are limited to 64 letters, digits, '_' or '-'.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/shared.ts
const MAX_FLAT_TOOL_NAME_LENGTH = 64;

const flattenCallableNamespaces = (bridge: CodexResponsesBridgeResult): CodexResponsesBridgeResult => {
  const declared = bridge.body.tools ?? [];
  if (!declared.some(tool => tool.type === 'namespace')) return bridge;
  const flatNames = new Set(declared.filter(isCallableTool).map(tool => tool.name));
  const reservedNames = new Set(flatNames);
  const nextSuffixes = new Map<string, number>();
  const sourceToTarget = new Map<string, string>();
  const qualifiedToTarget = new Map<string, string>();
  const entries = new Map<string, CallableIdentity>();
  const tools: OpenAIResponsesTool[] = [];
  for (const tool of declared) {
    if (tool.type !== 'namespace') {
      tools.push(tool);
      registerUnchangedTool(entries, tool);
      continue;
    }
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) {
      throw new TypeError('Cannot flatten a malformed Codex Responses Lite namespace');
    }
    for (const child of tool.tools) {
      if (!isCallableTool(child)) throw new TypeError(`Cannot flatten a non-callable tool in namespace ${tool.name}`);
      const sourceKey = callableKey(tool.name, child.name);
      let name = sourceToTarget.get(sourceKey);
      if (name === undefined) {
        const preferred = `${tool.name}_${child.name}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_FLAT_TOOL_NAME_LENGTH);
        name = preferred;
        if (reservedNames.has(name)) {
          let index = 2;
          for (;;) {
            const suffix = `_${index}`;
            const prefix = preferred.slice(0, MAX_FLAT_TOOL_NAME_LENGTH - suffix.length);
            // A shorter preferred name can share this prefix but still have unused one-digit suffixes.
            const cursorKey = `${suffix.length}:${prefix}`;
            const next = nextSuffixes.get(cursorKey);
            if (next !== undefined && next > index) {
              index = next;
              continue;
            }
            name = `${prefix}${suffix}`;
            nextSuffixes.set(cursorKey, index + 1);
            if (!reservedNames.has(name)) break;
            index++;
          }
        }
        reservedNames.add(name);
        sourceToTarget.set(sourceKey, name);
        qualifiedToTarget.set(`${tool.name}.${child.name}`, name);
      }
      const flattened = { ...child, name };
      tools.push(flattened);
      registerCallable(entries, identityForTool(flattened), identityForTool(child, tool.name));
    }
  }
  const rename = <T extends { name: string; namespace?: string }>(value: T): T => {
    const name = value.namespace !== undefined
      ? sourceToTarget.get(callableKey(value.namespace, value.name))
      : flatNames.has(value.name)
        ? undefined
        : qualifiedToTarget.get(value.name) ?? sourceToTarget.get(callableKey(DEFAULT_FUNCTION_NAMESPACE, value.name));
    if (name === undefined) return value;
    const next = { ...value, name };
    delete next.namespace;
    return next;
  };
  const input = bridge.body.input.map(item =>
    item.type === 'function_call' || item.type === 'custom_tool_call' ? rename(item) : item);
  let toolChoice = bridge.body.tool_choice;
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    if (toolChoice.type === 'function' || toolChoice.type === 'custom') toolChoice = rename(toolChoice);
    else if (toolChoice.type === 'allowed_tools') {
      toolChoice = {
        ...toolChoice,
        tools: toolChoice.tools.map(tool => typeof tool.name === 'string'
          ? rename(tool as typeof tool & { name: string; namespace?: string })
          : tool),
      };
    }
  }
  return {
    body: { ...bridge.body, tools, input, ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) },
    callableIdentities: { byWireName: entries },
  };
};

export const liftCodexResponsesLiteRequest = (
  body: CodexResponsesBody,
  options: { flattenNamespaces?: boolean } = {},
): CodexResponsesBridgeResult => {
  const bridge = liftToStandard(body);
  return withRequestEchoes(options.flattenNamespaces ? flattenCallableNamespaces(bridge) : bridge, body);
};

export const bridgeCodexResponsesRequest = (
  body: CodexResponsesBody,
  opts: {
    threadId: string;
    downstreamUsesLite: boolean;
    upstreamUsesLite: boolean;
  },
): CodexResponsesBridgeResult => {
  if (opts.downstreamUsesLite === opts.upstreamUsesLite) {
    return { body, callableIdentities: { byWireName: new Map() } };
  }
  return opts.upstreamUsesLite
    ? withRequestEchoes(lowerToLite(body, opts.threadId), body)
    : liftCodexResponsesLiteRequest(body);
};

// Restore the caller-visible namespace and function/custom identity from the
// request map, mirroring CLIProxyAPI's streaming and unary response repair.
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go#L288-L445
// https://github.com/router-for-me/CLIProxyAPI/blob/7fac6b15bcfe5ea55c18c9eaec8e5b7e6457d974/internal/translator/openai/openai/responses/openai_openai-responses_response.go#L779-L963
const restoreCallableItem = (
  item: OpenAIResponsesOutputItem,
  identities: CodexResponsesCallableIdentityMap,
): OpenAIResponsesOutputItem => {
  if (item.type !== 'function_call' && item.type !== 'custom_tool_call') return item;
  const downstream = identities.byWireName.get(callableKey(item.namespace, item.name));
  if (downstream === undefined) return item;

  const restored = { ...item } as Record<string, unknown>;
  restored.name = downstream.name;
  if (downstream.namespace === undefined) delete restored.namespace;
  else restored.namespace = downstream.namespace;

  if (downstream.type === 'function_call') {
    restored.type = 'function_call';
    if (item.type === 'custom_tool_call') {
      restored.arguments = item.input;
      delete restored.input;
      restored.status ??= 'completed';
    }
  } else {
    restored.type = 'custom_tool_call';
    if (item.type === 'function_call') {
      restored.input = item.arguments;
      delete restored.arguments;
    }
  }

  return restored as unknown as OpenAIResponsesOutputItem;
};

const REQUEST_ECHO_FIELDS = [
  'tools',
  'tool_choice',
  'instructions',
  'parallel_tool_calls',
  'reasoning',
] as const;

const restoreCodexRequestEchoes = (
  result: OpenAIResponsesResult,
  requestEchoes: CodexResponsesRequestEchoes | undefined,
): OpenAIResponsesResult => {
  if (requestEchoes === undefined) return result;
  const restored = { ...result };
  const record = restored as unknown as Record<string, unknown>;
  for (const field of REQUEST_ECHO_FIELDS) {
    if (!Object.hasOwn(requestEchoes, field)) continue;
    const value = requestEchoes[field];
    if (value === undefined) delete record[field];
    else record[field] = value;
  }
  return restored;
};

export const restoreCodexResponsesResult = (
  result: OpenAIResponsesResult,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
): OpenAIResponsesResult => restoreCodexRequestEchoes({
  ...result,
  output: result.output.map(item => restoreCallableItem(item, identities)),
}, requestEchoes);

export const restoreCodexResponsesCompactionResult = (
  result: OpenAIResponsesCompactionResult,
  identities: CodexResponsesCallableIdentityMap,
): OpenAIResponsesCompactionResult => ({
  ...result,
  output: result.output.map(item => restoreCallableItem(item, identities)),
});

export const restoreCodexResponsesEvent = (
  event: OpenAIResponsesStreamEvent,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
): OpenAIResponsesStreamEvent => {
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    return {
      ...event,
      item: restoreCallableItem(event.item, identities),
    };
  }
  if ('response' in event && isRecord(event.response) && Array.isArray(event.response.output)) {
    return {
      ...event,
      response: restoreCodexResponsesResult(
        event.response as unknown as OpenAIResponsesResult,
        identities,
        requestEchoes,
      ),
    } as OpenAIResponsesStreamEvent;
  }
  return event;
};

export const restoreCodexResponsesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  identities: CodexResponsesCallableIdentityMap,
  requestEchoes?: CodexResponsesRequestEchoes,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame;
      continue;
    }
    yield {
      ...frame,
      event: restoreCodexResponsesEvent(
        frame.event,
        identities,
        requestEchoes,
      ),
    };
  }
};
