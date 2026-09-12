import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem, OpenAIResponsesStreamEvent, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { TranslatorInputError } from '@floway-dev/translate';

// Official Codex sends the HTTP marker as per-operation metadata on WebSocket.
// These describe the caller's representation, never an upstream capability.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L163-L169
export const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const RESPONSES_LITE_METADATA_KEY = 'ws_request_header_x_openai_internal_codex_responses_lite';

// Codex groups otherwise unqualified callable tools under `functions` and tags
// the one-fragment base-instructions message that follows the tools carrier.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tools/src/tool_spec.rs#L95-L141
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/context/base_instructions.rs#L5-L12
// https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/tool_name.rs#L39-L50
const DEFAULT_FUNCTION_NAMESPACE = 'functions';
const BASE_INSTRUCTIONS_CONTENT_KIND = 'model.base_instructions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAdditionalToolsItem = (value: unknown): value is Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }> =>
  isRecord(value) && value.type === 'additional_tools' && value.role === 'developer'
  && Array.isArray(value.tools) && (value.id === undefined || value.id === null || typeof value.id === 'string');

// Do not consume a mixed developer message, an untagged message, or a carrier
// somewhere else in the input. Those are ordinary history, not instructions.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/context-fragments/src/fragment.rs#L35-L51
const baseInstructionsText = (value: unknown): string | undefined => {
  if (!isRecord(value) || value.type !== 'message' || value.role !== 'developer') return undefined;
  const metadata = value.internal_chat_message_metadata_passthrough;
  if (!isRecord(metadata) || !Array.isArray(metadata.content_item_kinds)
    || metadata.content_item_kinds.length !== 1 || metadata.content_item_kinds[0] !== BASE_INSTRUCTIONS_CONTENT_KIND) return undefined;
  if (!Array.isArray(value.content) || value.content.length !== 1) return undefined;
  const part: unknown = value.content[0];
  return isRecord(part) && part.type === 'input_text' && typeof part.text === 'string' ? part.text : undefined;
};

export interface ResponsesLiteClientView {
  // Captured before lifting and read only by the final client edge.
  readonly request: CanonicalOpenAIResponsesPayload;
  readonly toolChoiceChanged: boolean;
}

export interface ResponsesLiteInputContext {
  readonly type: 'responses_lite';
  readonly source: CanonicalOpenAIResponsesPayload;
}

interface ResponsesIngress {
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly headers: Headers;
  readonly clientView?: ResponsesLiteClientView;
  readonly inputContext?: ResponsesLiteInputContext;
}

// Resolve Lite's implicit identities without flattening semantic namespaces.
// Temporary protocol-specific names are allocated only after history hydration.
const qualifyLiteCallables = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const flatNames = new Set<string>();
  // Store each scope once. Qualified lookup uses this same index instead of
  // concatenating a potentially long namespace into every child's key.
  const namespaces = new Map<string, Set<string>>();
  const namespaceLengths = new Set<number>();
  for (const tool of (payload.tools ?? []) as readonly unknown[]) {
    if (!isRecord(tool)) continue;
    if ((tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string') flatNames.add(tool.name);
    if (tool.type !== 'namespace' || typeof tool.name !== 'string' || !Array.isArray(tool.tools)) continue;
    let children = namespaces.get(tool.name);
    if (children === undefined) {
      children = new Set();
      namespaces.set(tool.name, children);
      namespaceLengths.add(tool.name.length);
    }
    for (const child of tool.tools as readonly unknown[]) {
      if (!isRecord(child) || (child.type !== 'function' && child.type !== 'custom') || typeof child.name !== 'string') continue;
      children.add(child.name);
    }
  }
  const qualify = <T extends { name: string; namespace?: string }>(value: T): T => {
    const source = value.namespace === '' || value.namespace === null ? { ...value } : value;
    if (source !== value) delete source.namespace;
    if (source.namespace !== undefined || flatNames.has(source.name)) return source;
    let identity: { name: string; namespace: string } | undefined;
    for (const length of namespaceLengths) {
      if (source.name[length] !== '.') continue;
      const namespace = source.name.slice(0, length);
      const name = source.name.slice(length + 1);
      if (!namespaces.get(namespace)?.has(name)) continue;
      if (identity !== undefined) throw new TranslatorInputError(`Ambiguous qualified Responses Lite callable name '${source.name}'`, { param: 'input' });
      identity = { name, namespace };
    }
    if (identity === undefined && namespaces.get(DEFAULT_FUNCTION_NAMESPACE)?.has(source.name)) {
      identity = { name: source.name, namespace: DEFAULT_FUNCTION_NAMESPACE };
    }
    return identity === undefined ? source : { ...source, ...identity };
  };
  const input = payload.input.map(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? qualify(item) : item);
  let toolChoice = payload.tool_choice;
  if (toolChoice !== null && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function' || toolChoice.type === 'custom') toolChoice = qualify(toolChoice);
    else if (toolChoice.type === 'allowed_tools') {
      const originalTools = toolChoice.tools;
      const tools = originalTools.map(tool => (tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string'
        ? qualify(tool as typeof tool & { name: string; namespace?: string })
        : tool);
      if (tools.some((tool, index) => tool !== originalTools[index])) toolChoice = { ...toolChoice, tools };
    }
  }
  return { ...payload, input, ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) };
};

const liftResponsesLiteInput = (request: CanonicalOpenAIResponsesPayload): {
  payload: CanonicalOpenAIResponsesPayload;
  consumedIndices: readonly number[];
} => {
  const tools: OpenAIResponsesTool[] = [...(request.tools ?? [])];
  const instructions = isAdditionalToolsItem(request.input[0]) ? baseInstructionsText(request.input[1]) : undefined;
  const promote = (request.instructions == null || request.instructions === '') && instructions !== undefined && instructions.length > 0;
  const consumedIndices: number[] = [];
  let hasAdditionalTools = false;
  const input = request.input.filter((item, index) => {
    if (isAdditionalToolsItem(item)) {
      hasAdditionalTools = true;
      for (const tool of item.tools) tools.push(tool);
      consumedIndices.push(index);
      return false;
    }
    if (promote && index === 1) {
      consumedIndices.push(index);
      return false;
    }
    return true;
  });
  return {
    payload: {
      ...request, input,
      ...(hasAdditionalTools || Array.isArray(request.tools) ? { tools } : {}),
      ...(promote ? { instructions } : {}),
    },
    consumedIndices,
  };
};

export const normalizeResponsesIngress = (request: CanonicalOpenAIResponsesPayload, sourceHeaders: Headers, transport: 'http' | 'websocket' = 'http'): ResponsesIngress => {
  const metadata = (request as unknown as Record<string, unknown>).client_metadata;
  // A WebSocket handshake outlives this operation. Only its per-operation
  // metadata may select Lite; a header from an earlier turn is not a mode bit.
  const usesLite = (transport === 'http' && sourceHeaders.get(RESPONSES_LITE_HEADER)?.trim().toLowerCase() === 'true')
    || (isRecord(metadata) && metadata[RESPONSES_LITE_METADATA_KEY] === 'true');
  const headers = new Headers(sourceHeaders);
  headers.delete(RESPONSES_LITE_HEADER);
  let payload = request;
  // Consume reserved controls even when false, preserving every other extension.
  if (isRecord(metadata) && Object.hasOwn(metadata, RESPONSES_LITE_METADATA_KEY)) {
    const cleaned = { ...metadata };
    delete cleaned[RESPONSES_LITE_METADATA_KEY];
    payload = { ...payload, client_metadata: cleaned } as CanonicalOpenAIResponsesPayload;
  }
  if (!usesLite) return { payload, headers };

  const source = payload;
  payload = liftResponsesLiteInput(source).payload;
  const hasReferences = request.input.some(item => isRecord(item) && typeof item.id === 'string');
  // Stored identities are authoritative, including when the caller supplies a body.
  if (request.previous_response_id == null && !hasReferences) payload = qualifyLiteCallables(payload);
  return {
    payload,
    headers,
    inputContext: { type: 'responses_lite', source },
    clientView: {
      request,
      // Referenced declarations are available only after history hydration.
      toolChoiceChanged: payload.tool_choice !== request.tool_choice
        || ((request.previous_response_id != null || hasReferences) && isRecord(request.tool_choice)),
    },
  };
};

// Codex's incremental WebSocket request omits its unchanged tools/base prefix.
// Restore the referenced source items independently of create-only request fields.
// https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/tests/suite/client_websockets.rs#L1887-L1953
export const restoreResponsesLiteInputContext = (
  payload: CanonicalOpenAIResponsesPayload,
  options: {
    readonly sourceInput: readonly OpenAIResponsesInputItem[];
    readonly currentInputStart: number;
    readonly sourceItemIds?: readonly string[];
    readonly getItem: (id: string) => unknown;
  },
): { payload: CanonicalOpenAIResponsesPayload; sourceItems: readonly OpenAIResponsesInputItem[] } => {
  const sourceItems: OpenAIResponsesInputItem[] = [];
  const inheritedItems: OpenAIResponsesInputItem[] = [];
  const remaining = new Map<string, number>();
  for (const id of options.sourceItemIds ?? []) {
    const item = options.getItem(id);
    if (!isAdditionalToolsItem(item) && baseInstructionsText(item) === undefined) {
      throw new TypeError(`Invalid stored Responses Lite source item '${id}'`);
    }
    inheritedItems.push(item as OpenAIResponsesInputItem);
    sourceItems.push({ type: 'item_reference', id });
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }

  const tools = [...(payload.tools ?? [])];
  let hasCarrier = false;
  let inheritedInstructions: string | undefined;
  for (const item of inheritedItems) {
    if (isAdditionalToolsItem(item)) {
      hasCarrier = true;
      for (const tool of item.tools) tools.push(tool);
    } else inheritedInstructions = baseInstructionsText(item);
  }
  const history: OpenAIResponsesInputItem[] = [];
  for (let index = 0; index < options.currentInputStart; index++) {
    const source = options.sourceInput[index]!;
    const id = source.type === 'item_reference' ? source.id : undefined;
    const count = id === undefined ? 0 : remaining.get(id) ?? 0;
    if (id !== undefined && count > 0) {
      remaining.set(id, count - 1);
      continue;
    }
    const item = payload.input[index]!;
    if (isAdditionalToolsItem(item)) {
      hasCarrier = true;
      for (const tool of item.tools) tools.push(tool);
      sourceItems.push(source);
    } else history.push(item);
  }
  const current = liftResponsesLiteInput({
    ...payload,
    input: payload.input.slice(options.currentInputStart),
    ...(hasCarrier || Array.isArray(payload.tools) ? { tools } : {}),
  });
  for (const index of current.consumedIndices) sourceItems.push(options.sourceInput[options.currentInputStart + index]!);
  const restored = {
    ...current.payload,
    input: [...history, ...current.payload.input],
    ...((current.payload.instructions == null || current.payload.instructions === '') && inheritedInstructions !== undefined ? { instructions: inheritedInstructions } : {}),
  };
  return { payload: qualifyLiteCallables(restored), sourceItems };
};

// Restore representation-dependent echoes before resource completion. Undefined
// means absent in the caller view, not permission to delete a required field
// after the client schema has been completed.
export const restoreResponsesLiteEchoes = <T extends object>(resource: T, view: ResponsesLiteClientView): T => {
  const restored = { ...resource } as T & Record<string, unknown>;
  for (const field of ['tools', 'instructions', ...(view.toolChoiceChanged ? ['tool_choice'] as const : [])] as const) {
    const value = view.request[field];
    if (value === undefined) delete restored[field];
    else Object.assign(restored, { [field]: value });
  }
  return restored;
};

export const wrapResponsesLiteClientEchoes = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  view: ResponsesLiteClientView,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type === 'event' && 'response' in frame.event && isRecord(frame.event.response)) {
      yield { ...frame, event: { ...frame.event, response: restoreResponsesLiteEchoes(frame.event.response, view) } } as ProtocolFrame<OpenAIResponsesStreamEvent>;
    } else yield frame;
  }
};

// Call only on the successful egress path. API-error headers are upstream bytes
// and must not acquire a synthetic marker, even for a Lite caller.
export const responsesLiteSuccessHeaders = (headers: Headers | undefined, view: ResponsesLiteClientView | undefined): Headers | undefined => {
  if (view === undefined) return headers;
  const next = new Headers(headers);
  next.set(RESPONSES_LITE_HEADER, 'true');
  return next;
};
