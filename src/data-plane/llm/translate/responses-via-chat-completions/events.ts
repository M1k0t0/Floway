import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatReasoningItem,
} from "../../../shared/protocol/chat-completions.ts";
import type {
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../shared/protocol/responses.ts";
import { toResponseReasoningItem } from "../shared/chat-responses-reasoning.ts";
import { makeResponsesReasoningId } from "../shared/reasoning.ts";
import { checkWhitespaceOverflow } from "../shared/tool-arguments.ts";
import { mapChatCompletionsUsageToResponsesUsage } from "./result.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import type { ResponsesStreamEvent } from "../../shared/protocol/responses.ts";

const upstreamChatCompletionStreamAlgebra = {
  doneTerminates: true as const,
  missingTerminalMessage:
    "Upstream Chat Completions stream ended without a DONE sentinel.",
};

interface PendingScalarReasoningItem {
  text: string;
  signature: string;
  hasSignature: boolean;
}

interface PendingTextItem {
  outputIndex: number;
  itemId: string;
  text: string;
}

interface PendingFunctionCallItem {
  outputIndex?: number;
  itemId?: string;
  callId?: string;
  name?: string;
  arguments: string;
  consecutiveWhitespace: number;
}

type ChatStreamDelta = ChatCompletionChunk["choices"][0]["delta"];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta["tool_calls"]>;

type DeferredAfterReasoning =
  | { type: "content"; content: string }
  | { type: "tool_calls"; toolCalls: ChatStreamToolCalls };

interface ChatCompletionsToResponsesStreamState {
  responseCreated: boolean;
  outputIndex: number;
  sequenceNumber: number;
  responseId: string;
  model: string;
  outputText: string;
  completedItems: Map<number, ResponseOutputItem>;
  pendingScalarReasoning: PendingScalarReasoningItem | null;
  openText: PendingTextItem | null;
  openFunctionCalls: Map<number, PendingFunctionCallItem>;
  deferredAfterReasoning: DeferredAfterReasoning[];
  reasoningItemsSeen: boolean;
  usage?: ResponsesResult["usage"];
  pendingFinishReason?: ChatCompletionResponse["choices"][0]["finish_reason"];
  completed: boolean;
}

export const createChatCompletionsToResponsesStreamState =
  (): ChatCompletionsToResponsesStreamState => ({
    responseCreated: false,
    outputIndex: 0,
    sequenceNumber: 0,
    responseId: "",
    model: "",
    outputText: "",
    completedItems: new Map(),
    pendingScalarReasoning: null,
    openText: null,
    openFunctionCalls: new Map(),
    deferredAfterReasoning: [],
    reasoningItemsSeen: false,
    usage: undefined,
    pendingFinishReason: undefined,
    completed: false,
  });

const seq = (
  state: ChatCompletionsToResponsesStreamState,
  events: ResponseStreamEvent[],
): ResponseStreamEvent[] =>
  events.map((event) => ({
    ...event,
    sequence_number: state.sequenceNumber++,
  }));

const buildResult = (
  state: ChatCompletionsToResponsesStreamState,
  status: ResponsesResult["status"],
): ResponsesResult => ({
  id: state.responseId,
  object: "response",
  model: state.model,
  output: [...state.completedItems.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item),
  output_text: state.outputText,
  status,
  ...(state.pendingFinishReason === "length"
    ? { incomplete_details: { reason: "max_output_tokens" } }
    : {}),
  ...(state.usage ? { usage: state.usage } : {}),
});

const ensureResponseCreated = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  state.responseId = chunk.id;
  state.model = chunk.model;

  if (chunk.usage) {
    state.usage = mapChatCompletionsUsageToResponsesUsage(chunk.usage);
  }

  if (state.responseCreated) return [];

  state.responseCreated = true;
  const response = buildResult(state, "in_progress");

  return seq(state, [
    { type: "response.created", response },
    { type: "response.in_progress", response },
  ]);
};

const emitCompletedReasoningItem = (
  item: ResponseOutputReasoning,
  outputIndex: number,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  state.completedItems.set(outputIndex, item);

  return seq(state, [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    },
    ...item.summary.flatMap((part, summaryIndex) => [
      {
        type: "response.reasoning_summary_part.added" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part,
      },
      {
        type: "response.reasoning_summary_text.done" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: part.text,
      },
      {
        type: "response.reasoning_summary_part.done" as const,
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        part,
      },
    ]),
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    },
  ]);
};

const commitPendingScalarReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (!state.pendingScalarReasoning) return [];

  const reasoning = state.pendingScalarReasoning;
  state.pendingScalarReasoning = null;
  const outputIndex = state.outputIndex++;
  const item: ResponseOutputReasoning = {
    type: "reasoning",
    id: makeResponsesReasoningId(outputIndex),
    summary: reasoning.text
      ? [{ type: "summary_text", text: reasoning.text }]
      : [],
    ...(reasoning.hasSignature
      ? { encrypted_content: reasoning.signature }
      : {}),
  };

  return emitCompletedReasoningItem(item, outputIndex, state);
};

const closeText = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (!state.openText) return [];

  const textItem = state.openText;
  state.openText = null;

  const part = { type: "output_text" as const, text: textItem.text };
  const item: ResponseOutputMessage = {
    type: "message",
    role: "assistant",
    content: [part],
  };

  state.completedItems.set(textItem.outputIndex, item);

  return seq(state, [
    {
      type: "response.output_text.done",
      item_id: textItem.itemId,
      output_index: textItem.outputIndex,
      content_index: 0,
      text: textItem.text,
    },
    {
      type: "response.content_part.done",
      item_id: textItem.itemId,
      output_index: textItem.outputIndex,
      content_index: 0,
      part,
    },
    {
      type: "response.output_item.done",
      output_index: textItem.outputIndex,
      item,
    },
  ]);
};

const closeFunctionCalls = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];

  for (
    const functionCall of [...state.openFunctionCalls.values()].sort((a, b) =>
      (a.outputIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.outputIndex ?? Number.MAX_SAFE_INTEGER)
    )
  ) {
    if (
      functionCall.outputIndex == null ||
      !functionCall.itemId ||
      !functionCall.callId ||
      !functionCall.name
    ) {
      continue;
    }

    const item: ResponseOutputFunctionCall = {
      type: "function_call",
      call_id: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
      status: "completed",
    };

    state.completedItems.set(functionCall.outputIndex, item);
    events.push(
      {
        type: "response.function_call_arguments.done",
        item_id: functionCall.itemId,
        output_index: functionCall.outputIndex,
        arguments: functionCall.arguments,
      },
      {
        type: "response.output_item.done",
        output_index: functionCall.outputIndex,
        item,
      },
    );
  }

  state.openFunctionCalls.clear();
  return seq(state, events);
};

const ensureReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.pendingScalarReasoning) return [];

  state.pendingScalarReasoning = {
    text: "",
    signature: "",
    hasSignature: false,
  };
  return [];
};

const ensureText = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.openText) return [];

  const outputIndex = state.outputIndex++;
  const itemId = `msg_${outputIndex}`;
  state.openText = { outputIndex, itemId, text: "" };

  return seq(state, [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
  ]);
};

const ensureFunctionCall = (
  toolCallIndex: number,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const current = state.openFunctionCalls.get(toolCallIndex);
  if (
    !current ||
    current.outputIndex != null ||
    !current.callId ||
    !current.name
  ) {
    return [];
  }

  current.outputIndex = state.outputIndex++;
  current.itemId = `fc_${current.outputIndex}`;

  const events: ResponseStreamEvent[] = [{
    type: "response.output_item.added",
    output_index: current.outputIndex,
    item: {
      type: "function_call",
      call_id: current.callId,
      name: current.name,
      arguments: "",
      status: "in_progress",
    },
  }];

  if (current.arguments) {
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: current.itemId,
      output_index: current.outputIndex,
      delta: current.arguments,
    });
  }

  return seq(state, events);
};

const emitReasoningItemFromChatDelta = (
  item: ChatReasoningItem,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const outputIndex = state.outputIndex++;
  const responseItem = toResponseReasoningItem<ResponseOutputReasoning>(
    item,
    makeResponsesReasoningId(outputIndex),
  );

  return emitCompletedReasoningItem(responseItem, outputIndex, state);
};

const emitContentDelta = (
  content: string,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...ensureText(state));

  if (state.openText) {
    state.openText.text += content;
    state.outputText += content;
    events.push(...seq(state, [{
      type: "response.output_text.delta",
      item_id: state.openText.itemId,
      output_index: state.openText.outputIndex,
      content_index: 0,
      delta: content,
    }]));
  }

  return events;
};

const emitToolCallsDelta = (
  toolCalls: ChatStreamToolCalls,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...closeText(state));

  for (const toolCall of toolCalls) {
    const current = state.openFunctionCalls.get(toolCall.index) ?? {
      arguments: "",
      consecutiveWhitespace: 0,
    };

    if (toolCall.id) current.callId = toolCall.id;
    if (toolCall.function?.name) current.name = toolCall.function.name;
    state.openFunctionCalls.set(toolCall.index, current);
    events.push(...ensureFunctionCall(toolCall.index, state));

    if (!toolCall.function?.arguments) continue;

    const whitespace = checkWhitespaceOverflow(
      toolCall.function.arguments,
      current.consecutiveWhitespace,
    );
    current.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      state.completed = true;
      return [
        ...events,
        ...seq(state, [{
          type: "error",
          message:
            "Tool call arguments contained excessive whitespace, indicating a degenerate response.",
          code: "api_error",
        }]),
      ];
    }

    current.arguments += toolCall.function.arguments;

    if (current.outputIndex != null && current.itemId) {
      events.push(...seq(state, [{
        type: "response.function_call_arguments.delta",
        item_id: current.itemId,
        output_index: current.outputIndex,
        delta: toolCall.function.arguments,
      }]));
    }
  }

  return events;
};

const flushDeferredAfterReasoning = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...commitPendingScalarReasoning(state));

  const deferred = state.deferredAfterReasoning;
  state.deferredAfterReasoning = [];

  for (const item of deferred) {
    if (state.completed) break;
    events.push(
      ...(item.type === "content"
        ? emitContentDelta(item.content, state)
        : emitToolCallsDelta(item.toolCalls, state)),
    );
  }

  return events;
};

const finalize = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  if (state.completed || state.pendingFinishReason == null) return [];

  const events = [
    ...flushDeferredAfterReasoning(state),
    ...closeText(state),
    ...closeFunctionCalls(state),
  ];

  if (state.completed) return events;
  state.completed = true;

  return [
    ...events,
    ...seq(state, [{
      type: state.pendingFinishReason === "length"
        ? "response.incomplete"
        : "response.completed",
      response: buildResult(
        state,
        state.pendingFinishReason === "length" ? "incomplete" : "completed",
      ),
    }]),
  ];
};

export const translateChatCompletionsChunkToResponsesEvents = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => {
  const events = ensureResponseCreated(chunk, state);

  if (chunk.usage) {
    state.usage = mapChatCompletionsUsageToResponsesUsage(chunk.usage);
  }

  if (chunk.choices.length === 0) {
    return [...events, ...finalize(state)];
  }

  for (const choice of chunk.choices) {
    if (choice.delta.reasoning_items?.length) {
      const hadPendingScalarReasoning = state.pendingScalarReasoning !== null;
      state.reasoningItemsSeen = true;

      if (hadPendingScalarReasoning) {
        // Chat stream composition can emit legacy scalar reasoning first and a
        // richer item-level `reasoning_items[]` carrier later. Responses SSE
        // items are not retractable, so scalar reasoning remains buffered until
        // either a carrier replaces it or finalization commits it.
        state.pendingScalarReasoning = null;
      } else {
        events.push(...flushDeferredAfterReasoning(state));
        events.push(...closeText(state));
      }

      for (const item of choice.delta.reasoning_items) {
        events.push(...emitReasoningItemFromChatDelta(item, state));
      }

      if (hadPendingScalarReasoning) {
        events.push(...flushDeferredAfterReasoning(state));
        if (state.completed) return events;
      }
    } else if (
      choice.delta.reasoning_text ||
      choice.delta.reasoning_opaque !== undefined &&
        choice.delta.reasoning_opaque !== null
    ) {
      if (!state.reasoningItemsSeen) {
        if (!state.pendingScalarReasoning) events.push(...closeText(state));
        events.push(...ensureReasoning(state));

        if (choice.delta.reasoning_text && state.pendingScalarReasoning) {
          state.pendingScalarReasoning.text += choice.delta.reasoning_text;
        }

        if (
          choice.delta.reasoning_opaque !== undefined &&
          choice.delta.reasoning_opaque !== null &&
          state.pendingScalarReasoning
        ) {
          state.pendingScalarReasoning.signature +=
            choice.delta.reasoning_opaque;
          state.pendingScalarReasoning.hasSignature = true;
        }
      }
    }

    if (choice.delta.content) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: "content",
          content: choice.delta.content,
        });
      } else {
        events.push(...emitContentDelta(choice.delta.content, state));
      }
    }

    if (choice.delta.tool_calls?.length) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: "tool_calls",
          toolCalls: choice.delta.tool_calls,
        });
      } else {
        events.push(...emitToolCallsDelta(choice.delta.tool_calls, state));
        if (state.completed) return events;
      }
    }

    if (choice.finish_reason) {
      state.pendingFinishReason = choice.finish_reason;
    }
  }

  return events;
};

export const flushChatCompletionsToResponsesEvents = (
  state: ChatCompletionsToResponsesStreamState,
): ResponseStreamEvent[] => finalize(state);

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state = createChatCompletionsToResponsesStreamState();

  for await (
    const chunk of protocolEventsUntilTerminal(
      frames,
      upstreamChatCompletionStreamAlgebra,
    )
  ) {
    for (
      const event of translateChatCompletionsChunkToResponsesEvents(
        chunk,
        state,
      )
    ) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToResponsesEvents(state)) {
    yield eventFrame(event);
  }
};
