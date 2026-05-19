import type {
  ChatCompletionChunk,
  ChatReasoningItem,
  Delta,
} from "../../shared/protocol/chat-completions.ts";
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponseStreamEvent,
} from "../../shared/protocol/responses.ts";
import {
  createResponsesOutputOrderState,
  recordResponseOutputOrderEvent,
  type ResponsesOutputOrderState,
  shouldDeferForEarlierResponseOutput,
} from "../shared/responses-stream-order.ts";
import { toChatReasoningItem } from "../shared/chat-responses-reasoning.ts";
import {
  mapResponsesFinishReasonToChatCompletionsFinishReason,
  translateResponsesToChatCompletion,
} from "./result.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import {
  doneFrame,
  type EventFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../shared/stream/types.ts";
import { chatCompletionResultToEvents } from "../../targets/chat-completions/events/from-result.ts";

type UpstreamResponseStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

const upstreamResponsesStreamAlgebra = {
  isTerminalEvent: (event: Pick<ResponseStreamEvent, "type">): boolean =>
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed" ||
    event.type === "error",
  missingTerminalMessage:
    "Upstream Responses stream ended without a terminal event.",
};

const responsePartKey = (outputIndex: number, partIndex: number): string =>
  `${outputIndex}:${partIndex}`;

interface ResponsesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  functionCallIndices: Map<number, number>;
  inputTokens: number;
  cachedTokens: number;
  reasoningItems: ChatReasoningItem[];
  firstScalarReasoningOutputIndex?: number;
  pendingReasoningSummaryTexts: Map<string, {
    outputIndex: number;
    summaryIndex: number;
    text: string;
  }>;
  emittedReasoningSummaryKeys: Set<string>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  done: boolean;
}

export const createResponsesToChatCompletionsStreamState =
  (): ResponsesToChatCompletionsStreamState => ({
    messageId: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    toolCallIndex: -1,
    functionCallIndices: new Map(),
    inputTokens: 0,
    cachedTokens: 0,
    reasoningItems: [],
    pendingReasoningSummaryTexts: new Map(),
    emittedReasoningSummaryKeys: new Set(),
    emittedTextContentKeys: new Set(),
    emittedFunctionArgumentOutputIndexes: new Set(),
    outputOrder: createResponsesOutputOrderState(),
    done: false,
  });

const shouldDeferForEarlierReasoning = (
  event: ResponseStreamEvent,
  state: ResponsesToChatCompletionsStreamState,
): boolean => shouldDeferForEarlierResponseOutput(event, state.outputOrder);

const trackReasoningOutputItem = (item: ResponseOutputItem): boolean =>
  item.type === "reasoning";

const flushPendingReasoningChunks = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const chunks: ChatCompletionChunk[] = [];

  if (state.reasoningItems.length > 0) {
    chunks.push(makeChunk(state, { reasoning_items: state.reasoningItems }));
    state.reasoningItems = [];
  }

  return chunks;
};

const shouldProjectScalarReasoning = (
  outputIndex: number,
  state: ResponsesToChatCompletionsStreamState,
): boolean => {
  // Chat scalar reasoning is a compatibility projection, not an ordered
  // reasoning IR; once the first Responses reasoning output is chosen, later
  // reasoning outputs only travel through `reasoning_items[]`.
  state.firstScalarReasoningOutputIndex ??= outputIndex;
  return state.firstScalarReasoningOutputIndex === outputIndex;
};

const emitReasoningSummaryDelta = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  state.emittedReasoningSummaryKeys.add(
    responsePartKey(outputIndex, summaryIndex),
  );
  state.pendingReasoningSummaryTexts.delete(
    responsePartKey(outputIndex, summaryIndex),
  );
  return [makeChunk(state, { reasoning_text: text })];
};

const emitReasoningSummaryDoneFallback = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  const key = responsePartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return [];

  state.emittedReasoningSummaryKeys.add(key);
  state.pendingReasoningSummaryTexts.delete(key);
  return [makeChunk(state, { reasoning_text: text })];
};

const queueReasoningSummaryDoneFallback = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): void => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return;

  const key = responsePartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return;

  state.pendingReasoningSummaryTexts.set(key, {
    outputIndex,
    summaryIndex,
    text,
  });
};

const flushPendingReasoningSummaryDoneFallbacks = (
  outputIndex: number,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .filter((item) => item.outputIndex === outputIndex)
    .sort((a, b) => a.summaryIndex - b.summaryIndex);

  return pending.flatMap((item) =>
    emitReasoningSummaryDoneFallback(
      item.outputIndex,
      item.summaryIndex,
      item.text,
      state,
    )
  );
};

const flushAllPendingReasoningSummaryDoneFallbacks = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .sort((a, b) =>
      a.outputIndex === b.outputIndex
        ? a.summaryIndex - b.summaryIndex
        : a.outputIndex - b.outputIndex
    );

  return pending.flatMap((item) =>
    emitReasoningSummaryDoneFallback(
      item.outputIndex,
      item.summaryIndex,
      item.text,
      state,
    )
  );
};

const flushDeferredEvents = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const chunks: ChatCompletionChunk[] = [];

  while (state.outputOrder.deferredEvents.length > 0) {
    const ready: ResponseStreamEvent[] = [];
    const stillDeferred: ResponseStreamEvent[] = [];

    for (const event of state.outputOrder.deferredEvents) {
      if (shouldDeferForEarlierReasoning(event, state)) {
        stillDeferred.push(event);
      } else {
        ready.push(event);
      }
    }

    if (ready.length === 0) break;
    state.outputOrder.deferredEvents = stillDeferred;

    for (const event of ready) {
      const translated = translateResponsesEventToChatCompletionsChunks(
        event,
        state,
      );
      chunks.push(...translated);
    }
  }

  return chunks;
};

export const translateResponsesEventToChatCompletionsChunks = (
  event: ResponseStreamEvent,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (state.done) return [];
  if (shouldDeferForEarlierReasoning(event, state)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordResponseOutputOrderEvent(
    event,
    state.outputOrder,
    trackReasoningOutputItem,
  );

  switch (event.type) {
    case "response.created": {
      const { response } = event as Extract<
        ResponseStreamEvent,
        { type: "response.created" }
      >;
      state.messageId = response.id;
      state.model = response.model;
      state.inputTokens = response.usage?.input_tokens ?? 0;
      state.cachedTokens =
        response.usage?.input_tokens_details?.cached_tokens ?? 0;
      return [makeChunk(state, { role: "assistant" })];
    }

    case "response.output_item.added": {
      const { item, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_item.added" }
      >;
      if (item.type === "reasoning") {
        return [];
      }

      if (item.type !== "function_call") return [];

      state.toolCallIndex++;
      state.functionCallIndices.set(output_index, state.toolCallIndex);

      return [makeChunk(state, {
        tool_calls: [{
          index: state.toolCallIndex,
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: "",
          },
        }],
      })];
    }

    case "response.output_item.done": {
      const { item, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_item.done" }
      >;
      if (item.type !== "reasoning") return [];

      const chunks: ChatCompletionChunk[] = [];
      state.reasoningItems.push(toChatReasoningItem(item));

      for (const [summaryIndex, part] of item.summary.entries()) {
        chunks.push(...emitReasoningSummaryDoneFallback(
          output_index,
          summaryIndex,
          part.text,
          state,
        ));
      }
      chunks.push(...flushPendingReasoningSummaryDoneFallbacks(
        output_index,
        state,
      ));

      if (
        Object.hasOwn(item, "encrypted_content") &&
        shouldProjectScalarReasoning(output_index, state)
      ) {
        chunks.push(makeChunk(state, {
          reasoning_opaque: item.encrypted_content,
        }));
      }

      const deferred = flushDeferredEvents(state);
      return [...chunks, ...flushPendingReasoningChunks(state), ...deferred];
    }

    case "response.reasoning_summary_text.delta": {
      const { delta, output_index, summary_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.reasoning_summary_text.delta" }
      >;
      return emitReasoningSummaryDelta(
        output_index,
        summary_index,
        delta,
        state,
      );
    }

    case "response.reasoning_summary_text.done": {
      const { text, output_index, summary_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.reasoning_summary_text.done" }
      >;
      queueReasoningSummaryDoneFallback(
        output_index,
        summary_index,
        text,
        state,
      );
      return [];
    }

    case "response.output_text.delta": {
      const { delta, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_text.delta" }
      >;
      if (delta) {
        state.emittedTextContentKeys.add(
          responsePartKey(output_index, content_index),
        );
      }
      return delta ? [makeChunk(state, { content: delta })] : [];
    }

    case "response.output_text.done": {
      const { text, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_text.done" }
      >;
      const key = responsePartKey(output_index, content_index);
      if (!text || state.emittedTextContentKeys.has(key)) return [];

      state.emittedTextContentKeys.add(key);
      return [makeChunk(state, { content: text })];
    }

    case "response.content_part.done": {
      const { part, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.content_part.done" }
      >;
      if (part.type !== "refusal") return [];

      const key = responsePartKey(output_index, content_index);
      if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

      state.emittedTextContentKeys.add(key);
      return [makeChunk(state, { content: part.refusal })];
    }

    case "response.function_call_arguments.delta": {
      const { delta, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.function_call_arguments.delta" }
      >;
      if (!delta) return [];

      const toolCallIndex = state.functionCallIndices.get(output_index);
      if (toolCallIndex === undefined) return [];

      state.emittedFunctionArgumentOutputIndexes.add(output_index);
      return [makeChunk(state, {
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: delta },
        }],
      })];
    }

    case "response.function_call_arguments.done": {
      const { arguments: args, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.function_call_arguments.done" }
      >;
      if (
        !args || state.emittedFunctionArgumentOutputIndexes.has(output_index)
      ) {
        return [];
      }

      const toolCallIndex = state.functionCallIndices.get(output_index);
      if (toolCallIndex === undefined) return [];

      state.emittedFunctionArgumentOutputIndexes.add(output_index);
      return [makeChunk(state, {
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: args },
        }],
      })];
    }

    case "response.completed":
    case "response.incomplete": {
      const { response } = event as Extract<
        ResponseStreamEvent,
        { type: "response.completed" | "response.incomplete" }
      >;
      const chunks: ChatCompletionChunk[] = [];

      chunks.push(...flushAllPendingReasoningSummaryDoneFallbacks(state));
      chunks.push(...flushPendingReasoningChunks(state));
      chunks.push(...flushDeferredEvents(state));

      const chunk = makeChunk(
        state,
        {},
        mapResponsesFinishReasonToChatCompletionsFinishReason(response),
      );

      state.done = true;
      chunks.push(chunk);
      if (response.usage) chunks.push(makeUsageChunk(state, response.usage));
      return chunks;
    }

    case "response.failed":
      state.done = true;
      return [];

    default:
      return [];
  }
};

const makeChunk = (
  state: ResponsesToChatCompletionsStreamState,
  delta: Delta,
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [{
    index: 0,
    delta,
    finish_reason: finishReason,
  }],
});

const makeUsageChunk = (
  state: ResponsesToChatCompletionsStreamState,
  usage: NonNullable<ResponsesResult["usage"]>,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [],
  usage: {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
        prompt_tokens_details: {
          cached_tokens: usage.input_tokens_details.cached_tokens,
        },
      }
      : {}),
  },
});

interface ChatErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === "string" ? { name: value.name } : {}),
  ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.source_api === "string"
    ? { source_api: value.source_api }
    : {}),
  ...(typeof value.target_api === "string"
    ? { target_api: value.target_api }
    : {}),
});

const chatErrorPayloadFromResponsesError = (
  event: Extract<ResponseStreamEvent, { type: "error" }>,
): ChatErrorPayload => ({
  error: {
    message: event.message,
    type: event.code ?? "api_error",
    ...(event.code ? { code: event.code } : {}),
    ...(event.name ? { name: event.name } : {}),
    ...(event.stack ? { stack: event.stack } : {}),
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
    ...(event.source_api ? { source_api: event.source_api } : {}),
    ...(event.target_api ? { target_api: event.target_api } : {}),
  },
});

const chatErrorPayloadFromResponsesFailure = (
  event: Extract<ResponseStreamEvent, { type: "response.failed" }>,
): ChatErrorPayload => {
  const response = event.response as ResponsesResult;
  const error = isRecord(response.error) ? response.error : undefined;

  return {
    error: {
      message: stringField(
        error?.message,
        "Response failed due to unknown error.",
      ),
      type: stringField(error?.type, "api_error"),
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
      ...(error ? debugFieldsFrom(error) : {}),
    },
  };
};

const chatErrorFrameFromResponsesFatalEvent = (
  event: ResponseStreamEvent,
): EventFrame<ChatCompletionChunk> | undefined => {
  if (event.type === "error") {
    // OpenAI-compatible Chat streams can carry top-level error payloads;
    // ChatCompletionChunk only models successful chunk payloads.
    return eventFrame(
      chatErrorPayloadFromResponsesError(
        event as Extract<ResponseStreamEvent, { type: "error" }>,
      ) as unknown as ChatCompletionChunk,
    );
  }

  if (event.type === "response.failed") {
    return eventFrame(
      chatErrorPayloadFromResponsesFailure(
        event as Extract<ResponseStreamEvent, { type: "response.failed" }>,
      ) as unknown as ChatCompletionChunk,
    );
  }

  return undefined;
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<UpstreamResponseStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
  const state = createResponsesToChatCompletionsStreamState();
  let sawStructuredOutput = false;
  let streamingCommitted = false;
  const pendingFrames: Array<EventFrame<ChatCompletionChunk>> = [];
  let yieldedDone = false;

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamResponsesStreamAlgebra,
    )
  ) {
    const failureFrame = chatErrorFrameFromResponsesFatalEvent(event);
    if (failureFrame) {
      yield failureFrame;
      return;
    }

    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done" ||
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.function_call_arguments.delta"
    ) {
      sawStructuredOutput = true;
      if (!streamingCommitted) {
        streamingCommitted = true;
        for (const pending of pendingFrames) yield pending;
        pendingFrames.length = 0;
      }
    }

    if (
      !streamingCommitted &&
      !sawStructuredOutput &&
      (event.type === "response.completed" ||
        event.type === "response.incomplete")
    ) {
      pendingFrames.length = 0;
      for (
        const translated of chatCompletionResultToEvents(
          translateResponsesToChatCompletion(event.response as ResponsesResult),
        )
      ) {
        if (translated.type === "done") yieldedDone = true;
        yield translated;
      }
      continue;
    }

    const translated = translateResponsesEventToChatCompletionsChunks(
      event,
      state,
    );

    for (const chunk of translated) {
      const chunkFrame = eventFrame(chunk);
      if (streamingCommitted) {
        yield chunkFrame;
      } else {
        pendingFrames.push(chunkFrame);
      }
    }
  }

  if (!streamingCommitted && pendingFrames.length > 0) {
    for (const pending of pendingFrames) yield pending;
  }

  if (!yieldedDone) yield doneFrame();
};
