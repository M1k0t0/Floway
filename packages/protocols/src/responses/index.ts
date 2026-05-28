// Responses API type definitions
// Used for translating Messages ↔ Responses APIs

// ── Request types ──

export interface ResponsesPayload {
  model: string;
  input: string | ResponseInputItem[];
  previous_response_id?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  // Per the OpenAI Responses spec: "The maximum number of total calls to
  // built-in tools that can be processed in a response. This maximum
  // number applies across all built-in tool calls, not per individual
  // tool. Any further attempts to call a tool by the model will be
  // ignored." Reference (openai-python parameter declaration):
  // https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py
  max_tool_calls?: number | null;
  tools?: ResponseTool[] | null;
  tool_choice?: ResponseToolChoice;
  metadata?: Record<string, unknown> | null;
  stream?: boolean | null;
  store?: boolean | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: string;
    summary?: 'detailed' | 'auto' | 'concise';
  };
  include?: string[];
  text?: { format?: Record<string, unknown> | null } | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: string | null;
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseCustomToolCallItem
  | ResponseCustomToolCallOutputItem
  | ResponseInputReasoning
  | ResponseItemReference
  | ResponseInputWebSearchCall
  | ResponseInputImageGenerationCall;

export interface ResponseInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponseInputContent[];
}

export type ResponseInputContent = ResponseInputText | ResponseInputImage;

export interface ResponseInputText {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface ResponseInputImage {
  type: 'input_image';
  image_url: string;
  detail: 'auto' | 'low' | 'high';
}

export interface ResponseInputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
}

export interface ResponseFunctionToolCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed' | 'in_progress' | 'incomplete';
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
  status?: 'completed' | 'incomplete';
}

// Freeform custom tool invocation echoed back to the model in conversation
// history. The model's own emission of a custom tool call is identical in
// shape (it is also a `custom_tool_call` item).
interface ResponseCustomToolCallItem {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  id?: string;
  namespace?: string;
}

interface ResponseCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string;
  id?: string;
}

export interface ResponseItemReference {
  type: 'item_reference';
  id: string;
}

// Tolerant input mirror of ResponseOutputWebSearchCall: clients may
// echo previously emitted web_search_call items back. Every field is
// optional so the wire shape accepts whatever the client carries.
export interface ResponseInputWebSearchCall {
  type: 'web_search_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'searching' | 'failed';
  action?: ResponseWebSearchAction;
  results?: ResponseWebSearchResult[];
}

export interface ResponseInputImageGenerationCall {
  type: 'image_generation_call';
  id?: string;
  status?: 'completed' | 'in_progress' | 'generating' | 'failed';
  result?: string;
  revised_prompt?: string;
}

export interface ResponseFunctionTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  description?: string;
}

// Codex and other Responses clients ship hosted server tools (web_search,
// image_generation, tool_search, namespace) and Freeform `custom` tools
// alongside ordinary function tools. Native Responses targets pass `custom`
// through; translated targets wrap each `custom` as a single-string-parameter
// function tool and unwrap matching function calls back into `custom_tool_call`
// outputs. The wire-level tools array is still a heterogeneous union and
// translators must narrow on `type === "function"` (or `"custom"`) before
// reading `name` / `parameters`.
//
// `web_search` ships under four equivalent type values (current + dated
// + preview + dated-preview). All four name the same hosted tool. The
// canonical list lives here so the runtime Set and this TS union can't
// drift.
export const WEB_SEARCH_HOSTED_TYPE_NAMES = [
  'web_search',
  'web_search_2025_08_26',
  'web_search_preview',
  'web_search_preview_2025_03_11',
] as const;

export type ResponseHostedToolType =
  | typeof WEB_SEARCH_HOSTED_TYPE_NAMES[number]
  | 'image_generation'
  | 'tool_search'
  | 'namespace';

export interface ResponseHostedTool {
  type: ResponseHostedToolType;
  // web_search-specific fields per the OpenAI Responses guide. Typed
  // explicitly to avoid unsafe index-signature casts at the call site.
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  user_location?: {
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  search_context_size?: 'low' | 'medium' | 'high';
  external_web_access?: boolean;
  search_content_types?: string[];
  return_token_budget?: 'default' | 'unlimited';
  name?: string;
  // Forward-compat catch-all for other hosted-tool fields the gateway
  // doesn't currently inspect.
  [key: string]: unknown;
}

export interface ResponseCustomTool {
  type: 'custom';
  name: string;
  description?: string;
  format?: Record<string, unknown>;
}

export type ResponseTool = ResponseFunctionTool | ResponseHostedTool | ResponseCustomTool;

export type ResponseToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | { type: 'custom'; name: string }
  | { type: ResponseHostedToolType };

// ── Response types ──

export interface ResponsesResult {
  id: string;
  object: string;
  model: string;
  output: ResponseOutputItem[];
  // SDK-only convenience alias for "all assistant text in this
  // response". Optional on the wire because OpenAI's SDKs derive it
  // from `output` rather than reading it from the JSON (see
  // openai-python `Response.output_text` `@property`, openai-dotnet
  // `[CodeGenSuppress("OutputText")]`, openai-go `func (r Response)
  // OutputText() string`). The captured wire fixture at
  // `openai-dotnet/tests/SessionRecords/ResponsesToolTests/WebSearchCallAsync.json`
  // confirms the field is absent from the response body. Producers
  // that happen to emit it (some OpenAPI implementations do) are
  // preserved as-is on pass-through.
  output_text?: string;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
  // `error` and `incomplete_details` are REQUIRED on the wire shape
  // per the OpenAI Responses spec (both can be null). Reference:
  // https://github.com/openai/openai-openapi/blob/master/openapi.yaml
  // `Response.required` lists both. Native upstreams emit them as
  // `null` on success-path frames; downstream clients (typed SDKs)
  // probe for the field's presence rather than its truthiness, so
  // omitting them on synthesized envelopes breaks parse-time validation.
  //
  // `error.type` is NOT in the OpenAI spec (see ResponseError schema —
  // only `code` and `message` are defined), but kept optional here to
  // accommodate upstreams that publish it as an extension; the shim
  // never synthesizes it.
  incomplete_details: { reason: string } | null;
  error: { message: string; code: string; type?: string } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens_details?: { reasoning_tokens: number };
  };
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputCustomToolCall
  | ResponseOutputReasoning
  | ResponseOutputWebSearchCall
  | ResponseOutputImageGenerationCall;

export interface ResponseOutputMessage {
  type: 'message';
  role: 'assistant';
  content: ResponseOutputContentBlock[];
}

export type ResponseOutputContentBlock = ResponseOutputText | ResponseOutputRefusal;

interface ResponseOutputText {
  type: 'output_text';
  text: string;
}

interface ResponseOutputRefusal {
  type: 'refusal';
  refusal: string;
}

export interface ResponseOutputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export interface ResponseOutputCustomToolCall {
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  input: string;
  id?: string;
  namespace?: string;
}

export interface ResponseOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
}

// Web-search call types. `results` is opt-in on the wire (native gates
// it on `include: ["web_search_call.results"]`); consumers must
// tolerate its absence.

export type ResponseWebSearchAction =
  // `type: 'search'` carries either `queries: string[]` (preferred,
  // emitted by newer variants) or the deprecated `query: string` (older
  // codex). Producers should populate `queries`; consumers should read
  // `queries` first. `sources` is opt-in on the wire (native gates it
  // on `include: ["web_search_call.action.sources"]`); consumers must
  // tolerate its absence. The element shape mirrors openai-python
  // `ActionSearch.sources[]` — `type: 'url'` with the source URL.
  | { type: 'search'; query?: string; queries?: string[]; sources?: { type: 'url'; url: string }[] }
  // `url` is optional on `open_page`: native upstreams drop the field on
  // soft failures (404, network, blocked) rather than emitting a placeholder.
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url: string; pattern: string };

export interface ResponseWebSearchResult {
  type: 'text_result';
  url: string;
  title: string;
  snippet: string;
}

export interface ResponseOutputWebSearchCall {
  type: 'web_search_call';
  id: string;
  status: 'in_progress' | 'searching' | 'completed' | 'failed';
  // Optional because upstream omits `action` on the in-flight
  // `output_item.added` and only populates it on `.done` once the
  // action shape (search vs open_page vs find_in_page) is known.
  action?: ResponseWebSearchAction;
  results?: ResponseWebSearchResult[];
}

export interface ResponseOutputImageGenerationCall {
  type: 'image_generation_call';
  id: string;
  status: 'in_progress' | 'generating' | 'completed' | 'failed';
  result?: string;
  revised_prompt?: string;
  error?: { message: string; code: string };
}

// ── Stream event types ──

export type ResponseStreamEvent =
  | { type: 'response.created'; response: ResponsesResult }
  | { type: 'response.in_progress'; response: ResponsesResult }
  | {
    type: 'response.output_item.added';
    output_index: number;
    item: ResponseOutputItem;
  }
  | {
    type: 'response.output_item.done';
    output_index: number;
    item: ResponseOutputItem;
  }
  | {
    type: 'response.content_part.added';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputContentBlock;
  }
  | {
    type: 'response.content_part.done';
    item_id: string;
    output_index: number;
    content_index: number;
    part: ResponseOutputContentBlock;
  }
  | {
    type: 'response.reasoning_summary_part.added';
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: 'summary_text'; text: string };
  }
  | {
    type: 'response.reasoning_summary_part.done';
    item_id: string;
    output_index: number;
    summary_index: number;
    part: { type: 'summary_text'; text: string };
  }
  | {
    type: 'response.reasoning_summary_text.delta';
    item_id: string;
    output_index: number;
    summary_index: number;
    delta: string;
  }
  | {
    type: 'response.reasoning_summary_text.done';
    item_id: string;
    output_index: number;
    summary_index: number;
    text: string;
  }
  | {
    type: 'response.output_text.delta';
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
  }
  | {
    type: 'response.output_text.done';
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
  }
  | {
    type: 'response.output_text.annotation.added';
    output_index: number;
    content_index: number;
    annotation_index: number;
    item_id: string;
    annotation:
      | {
        type: 'url_citation';
        url: string;
        title: string;
        start_index: number;
        end_index: number;
      };
  }
  | {
    type: 'response.web_search_call.in_progress';
    output_index: number;
    item_id: string;
  }
  // Intermediate progress event for hosted `web_search`. Native upstreams
  // emit it between `.in_progress` and `.completed`; gateway-synthesized
  // lifecycles do the same.
  | {
    type: 'response.web_search_call.searching';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.web_search_call.completed';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.in_progress';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.generating';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.image_generation_call.partial_image';
    output_index: number;
    item_id: string;
    partial_image_index: number;
    partial_image_b64: string;
  }
  | {
    type: 'response.image_generation_call.completed';
    output_index: number;
    item_id: string;
  }
  | {
    type: 'response.function_call_arguments.delta';
    item_id: string;
    output_index: number;
    delta: string;
  }
  | {
    type: 'response.function_call_arguments.done';
    item_id: string;
    output_index: number;
    arguments: string;
  }
  | {
    type: 'response.custom_tool_call_input.delta';
    item_id: string;
    output_index: number;
    delta: string;
  }
  | {
    type: 'response.custom_tool_call_input.done';
    item_id: string;
    output_index: number;
    input: string;
  }
  | { type: 'response.completed'; response: ResponsesResult }
  | { type: 'response.incomplete'; response: ResponsesResult }
  | { type: 'response.failed'; response: ResponsesResult }
  | {
    type: 'error';
    message: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  }
  | { type: 'ping' };

// Forward-compatibility escape hatch for unknown event types. Earlier
// versions of `ResponseStreamEvent` ended with a permissive
// `{ type: string; [key: string]: unknown }` catch-all in the union;
// because that branch matches any object with a `type` field and any
// extra keys, it silently let test fixtures compile against
// `ResponseStreamEvent` while missing required fields on the
// `response` member (e.g. spec-required `error: null` /
// `incomplete_details: null` on `response.created.response`). Splitting
// the catch-all into a separate exported type means callers that need
// to accept unknown future events must opt in explicitly (and assume
// the responsibility of asserting field shapes themselves) instead of
// letting every malformed fixture compile through silently.
export interface UnknownResponseStreamEvent {
  type: string;
  [key: string]: unknown;
}

// Union for consumers that explicitly need to accept future / unknown
// event types alongside the strongly-typed ones. Use this when reading
// from an upstream wire we do not fully control. Producers (test
// fixtures, gateway synthesizers) should keep using
// `ResponseStreamEvent` so missing required fields are caught at
// compile time.
export type ResponseStreamEventOrUnknown = ResponseStreamEvent | UnknownResponseStreamEvent;

// Gateway-side extension: upstream Responses streams may omit `sequence_number`
// when probing, so the gateway-internal shape leaves it optional.
export type ResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

// Sibling of ResponsesStreamEvent for sequences synthesized inside the
// gateway (from-result expansion, from-stream projection), where the
// sequence number is always present.
export type SequencedResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number: number;
};

// Either side of the Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type ResponsesReasoningItem = ResponseInputReasoning | ResponseOutputReasoning;

export const isResponsesTerminalEvent = (event: Pick<ResponseStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';

export { responsesResultToEvents } from './from-result.ts';
export { imageGenerationCallLifecycleEvents } from './image-generation-lifecycle.ts';
export { webSearchCallLifecycleEvents } from './web-search-lifecycle.ts';
