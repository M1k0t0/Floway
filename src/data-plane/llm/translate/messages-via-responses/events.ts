import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import { packReasoningSignature } from "../shared/messages-responses-signature.ts";
import type {
  ResponseOutputItem,
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../shared/protocol/responses.ts";
import {
  createResponsesOutputOrderState,
  recordResponseOutputOrderEvent,
  type ResponsesOutputOrderState,
  shouldDeferForEarlierResponseOutput,
} from "../shared/responses-stream-order.ts";
import { translateResponsesToMessagesResponse } from "./result.ts";
import { checkWhitespaceOverflow } from "../shared/tool-arguments.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import {
  type EventFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../shared/stream/types.ts";
import { messagesResultToEvents } from "../../shared/protocol/messages.ts";

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

const hasResponsePartForOutput = (
  keys: Set<string>,
  outputIndex: number,
): boolean => {
  const prefix = `${outputIndex}:`;
  for (const key of keys) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};

type ResponseCreatedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.created" }
>;

type ResponseOutputItemAddedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.added" }
>;

type ResponseOutputItemDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
>;

type ResponseReasoningSummaryTextDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.reasoning_summary_text.delta" }
>;

type ResponseReasoningSummaryTextDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.reasoning_summary_text.done" }
>;

type ResponseOutputTextDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_text.delta" }
>;

type ResponseOutputTextDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_text.done" }
>;

type ResponseContentPartDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.content_part.done" }
>;

type ResponseFunctionCallArgumentsDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.function_call_arguments.delta" }
>;

type ResponseFunctionCallArgumentsDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.function_call_arguments.done" }
>;

type ResponseCompletedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.completed" }
>;

type ResponseIncompleteEvent = Extract<
  ResponseStreamEvent,
  { type: "response.incomplete" }
>;

type ResponseFailedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.failed" }
>;

type ErrorEvent = Extract<ResponseStreamEvent, { type: "error" }>;

interface ResponsesToMessagesStreamState {
  messageCompleted: boolean;
  nextBlockIndex: number;
  blockIndexByKey: Map<string, number>;
  openBlocks: Set<number>;
  blockHasDelta: Set<number>;
  emittedReasoningSummaryKeys: Set<string>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  functionCallState: Map<number, {
    blockIndex: number;
    toolCallId: string;
    name: string;
    consecutiveWhitespace: number;
  }>;
}

type ContentBlockInit =
  | { type: "text"; text: "" }
  | { type: "thinking"; thinking: "" }
  | { type: "redacted_thinking"; data: string };

const shouldDeferForEarlierOutput = (
  event: ResponseStreamEvent,
  state: ResponsesToMessagesStreamState,
): boolean => shouldDeferForEarlierResponseOutput(event, state.outputOrder);

const trackMessagesOutputItem = (_item: ResponseOutputItem): boolean => true;

const openBlock = (
  state: ResponsesToMessagesStreamState,
  key: string,
  contentBlock: ContentBlockInit,
  events: MessagesStreamEventData[],
): number => {
  let blockIndex = state.blockIndexByKey.get(key);

  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++;
    state.blockIndexByKey.set(key, blockIndex);
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events);
    events.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: contentBlock,
    });
    state.openBlocks.add(blockIndex);
  }

  return blockIndex;
};

const openTextBlock = (
  state: ResponsesToMessagesStreamState,
  outputIndex: number,
  contentIndex: number,
  events: MessagesStreamEventData[],
): number =>
  openBlock(
    state,
    `${outputIndex}:${contentIndex}`,
    { type: "text", text: "" },
    events,
  );

const openThinkingBlock = (
  state: ResponsesToMessagesStreamState,
  outputIndex: number,
  events: MessagesStreamEventData[],
): number =>
  openBlock(
    state,
    `${outputIndex}:0`,
    { type: "thinking", thinking: "" },
    events,
  );

const openRedactedThinkingBlock = (
  state: ResponsesToMessagesStreamState,
  outputIndex: number,
  signature: string,
  events: MessagesStreamEventData[],
): number =>
  openBlock(
    state,
    `${outputIndex}:0`,
    { type: "redacted_thinking", data: signature },
    events,
  );

const closeOpenBlocks = (
  state: ResponsesToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  for (const blockIndex of state.openBlocks) {
    events.push({ type: "content_block_stop", index: blockIndex });
  }

  state.openBlocks.clear();
  state.blockHasDelta.clear();
};

const closeAllBlocks = (
  state: ResponsesToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  closeOpenBlocks(state, events);
  state.functionCallState.clear();
};

const handleResponseCreated = (
  response: ResponsesResult,
): MessagesStreamEventData[] => {
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return [{
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: (response.usage?.input_tokens ?? 0) - (cachedTokens ?? 0),
        output_tokens: 0,
        ...(cachedTokens !== undefined
          ? { cache_read_input_tokens: cachedTokens }
          : {}),
      },
    },
  }];
};

const handleOutputItemAdded = (
  event: ResponseOutputItemAddedEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (event.item.type === "reasoning") {
    return [];
  }

  if (event.item.type !== "function_call") return [];

  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? "function";

  state.functionCallState.set(event.output_index, {
    blockIndex,
    toolCallId,
    name,
    consecutiveWhitespace: 0,
  });

  const events: MessagesStreamEventData[] = [];
  closeOpenBlocks(state, events);
  events.push({
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "tool_use", id: toolCallId, name, input: {} },
  });
  state.openBlocks.add(blockIndex);

  if (event.item.arguments.length > 0) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: event.item.arguments },
    });
    state.blockHasDelta.add(blockIndex);
    state.emittedFunctionArgumentOutputIndexes.add(event.output_index);
  }

  return events;
};

const handleOutputItemDone = (
  event: ResponseOutputItemDoneEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (event.item.type !== "reasoning") return flushDeferredEvents(state);

  const encryptedContent = event.item.encrypted_content;
  const hasEncryptedContent = Object.hasOwn(event.item, "encrypted_content") &&
    encryptedContent !== undefined;
  const hasEmittedSummary = hasResponsePartForOutput(
    state.emittedReasoningSummaryKeys,
    event.output_index,
  );
  const trimmedSummary = event.item.summary
    .map((part) => part.text)
    .join("")
    .trim();

  // No prior summary delta and no usable summary text: either round-trip the
  // opaque blob as `redacted_thinking{data}` (the valid signature-only Messages
  // shape) or drop entirely when there is nothing the target can verify. The
  // Responses item id is packed into the signature/data slot so upstream
  // reasoning-continuity checks can pass on the next turn; see
  // `../shared/messages-responses-signature.ts`.
  if (!hasEmittedSummary && trimmedSummary === "") {
    if (hasEncryptedContent) {
      const events: MessagesStreamEventData[] = [];
      openRedactedThinkingBlock(
        state,
        event.output_index,
        packReasoningSignature(event.item.id, encryptedContent),
        events,
      );
      return [...events, ...flushDeferredEvents(state)];
    }
    return flushDeferredEvents(state);
  }

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  let emittedDelta = false;

  for (const [summaryIndex, part] of event.item.summary.entries()) {
    const key = responsePartKey(event.output_index, summaryIndex);
    if (!part.text || state.emittedReasoningSummaryKeys.has(key)) continue;

    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: part.text },
    });
    emittedDelta = true;
    state.emittedReasoningSummaryKeys.add(key);
  }

  if (hasEncryptedContent) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "signature_delta",
        signature: packReasoningSignature(event.item.id, encryptedContent),
      },
    });
    emittedDelta = true;
  }

  if (emittedDelta) state.blockHasDelta.add(blockIndex);
  return [...events, ...flushDeferredEvents(state)];
};

const handleThinkingDelta = (
  event: ResponseReasoningSummaryTextDeltaEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "thinking_delta", thinking: event.delta },
  });
  state.blockHasDelta.add(blockIndex);
  state.emittedReasoningSummaryKeys.add(
    responsePartKey(event.output_index, event.summary_index),
  );
  return events;
};

const handleThinkingDone = (
  event: ResponseReasoningSummaryTextDoneEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsePartKey(event.output_index, event.summary_index);

  if (event.text && !state.emittedReasoningSummaryKeys.has(key)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "thinking_delta", thinking: event.text },
    });
    state.blockHasDelta.add(blockIndex);
    state.emittedReasoningSummaryKeys.add(key);
  }

  return events;
};

const handleTextDelta = (
  event: ResponseOutputTextDeltaEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (!event.delta) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(
    state,
    event.output_index,
    event.content_index,
    events,
  );
  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "text_delta", text: event.delta },
  });
  state.blockHasDelta.add(blockIndex);
  state.emittedTextContentKeys.add(
    responsePartKey(event.output_index, event.content_index),
  );
  return events;
};

const handleTextDone = (
  event: ResponseOutputTextDoneEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(
    state,
    event.output_index,
    event.content_index,
    events,
  );

  const key = responsePartKey(event.output_index, event.content_index);
  if (event.text && !state.emittedTextContentKeys.has(key)) {
    events.push({
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "text_delta", text: event.text },
    });
    state.blockHasDelta.add(blockIndex);
    state.emittedTextContentKeys.add(key);
  }

  return events;
};

const handleContentPartDone = (
  event: ResponseContentPartDoneEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (event.part.type !== "refusal") return [];

  const key = responsePartKey(event.output_index, event.content_index);
  if (!event.part.refusal || state.emittedTextContentKeys.has(key)) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(
    state,
    event.output_index,
    event.content_index,
    events,
  );
  events.push({
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "text_delta", text: event.part.refusal },
  });
  state.blockHasDelta.add(blockIndex);
  state.emittedTextContentKeys.add(key);
  return events;
};

const handleFunctionArgumentsDelta = (
  event: ResponseFunctionCallArgumentsDeltaEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (!event.delta) return [];

  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  const whitespace = checkWhitespaceOverflow(
    event.delta,
    functionCallState.consecutiveWhitespace,
  );
  functionCallState.consecutiveWhitespace = whitespace.count;

  if (whitespace.exceeded) {
    const events: MessagesStreamEventData[] = [];
    console.warn(
      "Infinite whitespace in Responses function call args, aborting",
    );
    closeAllBlocks(state, events);
    state.messageCompleted = true;
    events.push({
      type: "error",
      error: {
        type: "api_error",
        message: "Tool call arguments contained excessive whitespace.",
      },
    });
    return events;
  }

  state.blockHasDelta.add(functionCallState.blockIndex);
  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [{
    type: "content_block_delta",
    index: functionCallState.blockIndex,
    delta: { type: "input_json_delta", partial_json: event.delta },
  }];
};

const handleFunctionArgumentsDone = (
  event: ResponseFunctionCallArgumentsDoneEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  state.functionCallState.delete(event.output_index);

  if (
    !event.arguments ||
    state.emittedFunctionArgumentOutputIndexes.has(event.output_index)
  ) {
    return [];
  }

  state.blockHasDelta.add(functionCallState.blockIndex);
  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [{
    type: "content_block_delta",
    index: functionCallState.blockIndex,
    delta: { type: "input_json_delta", partial_json: event.arguments },
  }];
};

const handleCompleted = (
  response: ResponsesResult,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);

  const messagesResponse = translateResponsesToMessagesResponse(response);
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: messagesResponse.stop_reason,
        stop_sequence: messagesResponse.stop_sequence,
      },
      usage: messagesResponse.usage,
    },
    { type: "message_stop" },
  );
  state.messageCompleted = true;
  return events;
};

const handleFailed = (
  response: ResponsesResult,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);
  state.messageCompleted = true;
  events.push({
    type: "error",
    error: {
      type: "api_error",
      message: response.error?.message ??
        "Response failed due to unknown error.",
    },
  });
  return events;
};

const handleError = (
  event: ErrorEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);
  state.messageCompleted = true;
  events.push({
    type: "error",
    error: {
      type: "api_error",
      message: typeof event.message === "string"
        ? event.message
        : "An unexpected error occurred during streaming.",
    },
  });
  return events;
};

export const createResponsesToMessagesStreamState =
  (): ResponsesToMessagesStreamState => ({
    messageCompleted: false,
    nextBlockIndex: 0,
    blockIndexByKey: new Map(),
    openBlocks: new Set(),
    blockHasDelta: new Set(),
    emittedReasoningSummaryKeys: new Set(),
    emittedTextContentKeys: new Set(),
    emittedFunctionArgumentOutputIndexes: new Set(),
    outputOrder: createResponsesOutputOrderState(),
    functionCallState: new Map(),
  });

const flushDeferredEvents = (
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];

  while (state.outputOrder.deferredEvents.length > 0) {
    const ready: ResponseStreamEvent[] = [];
    const stillDeferred: ResponseStreamEvent[] = [];

    for (const event of state.outputOrder.deferredEvents) {
      if (shouldDeferForEarlierOutput(event, state)) {
        stillDeferred.push(event);
      } else {
        ready.push(event);
      }
    }

    if (ready.length === 0) break;
    state.outputOrder.deferredEvents = stillDeferred;

    for (const event of ready) {
      events.push(
        ...translateResponsesStreamEventToMessagesEvents(event, state),
      );
    }
  }

  return events;
};

export const translateResponsesStreamEventToMessagesEvents = (
  event: ResponseStreamEvent,
  state: ResponsesToMessagesStreamState,
): MessagesStreamEventData[] => {
  if (state.messageCompleted) return [];
  if (shouldDeferForEarlierOutput(event, state)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordResponseOutputOrderEvent(
    event,
    state.outputOrder,
    trackMessagesOutputItem,
  );

  switch (event.type) {
    case "response.created":
      return handleResponseCreated((event as ResponseCreatedEvent).response);
    case "response.output_item.added":
      return handleOutputItemAdded(
        event as ResponseOutputItemAddedEvent,
        state,
      );
    case "response.output_item.done":
      return handleOutputItemDone(event as ResponseOutputItemDoneEvent, state);
    case "response.reasoning_summary_text.delta":
      return handleThinkingDelta(
        event as ResponseReasoningSummaryTextDeltaEvent,
        state,
      );
    case "response.reasoning_summary_text.done":
      return handleThinkingDone(
        event as ResponseReasoningSummaryTextDoneEvent,
        state,
      );
    case "response.output_text.delta":
      return handleTextDelta(event as ResponseOutputTextDeltaEvent, state);
    case "response.output_text.done":
      return handleTextDone(event as ResponseOutputTextDoneEvent, state);
    case "response.content_part.done":
      return handleContentPartDone(
        event as ResponseContentPartDoneEvent,
        state,
      );
    case "response.function_call_arguments.delta":
      return handleFunctionArgumentsDelta(
        event as ResponseFunctionCallArgumentsDeltaEvent,
        state,
      );
    case "response.function_call_arguments.done":
      return handleFunctionArgumentsDone(
        event as ResponseFunctionCallArgumentsDoneEvent,
        state,
      );
    case "response.completed":
      return handleCompleted((event as ResponseCompletedEvent).response, state);
    case "response.incomplete":
      return handleCompleted(
        (event as ResponseIncompleteEvent).response,
        state,
      );
    case "response.failed":
      return handleFailed((event as ResponseFailedEvent).response, state);
    case "error":
      return handleError(event as ErrorEvent, state);
    case "ping":
      return [{ type: "ping" }];
    default:
      return [];
  }
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<UpstreamResponseStreamEvent>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  const state = createResponsesToMessagesStreamState();
  let sawStructuredOutput = false;
  let streamingCommitted = false;
  const pendingFrames: Array<EventFrame<MessagesStreamEventData>> = [];

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamResponsesStreamAlgebra,
    )
  ) {
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done" ||
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_summary_text.done" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.output_text.done" ||
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
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
      yield* messagesResultToEvents(
        translateResponsesToMessagesResponse(event.response as ResponsesResult),
      );
      continue;
    }

    for (
      const translated of translateResponsesStreamEventToMessagesEvents(
        event,
        state,
      )
    ) {
      const translatedFrame = eventFrame(translated);
      if (streamingCommitted) {
        yield translatedFrame;
      } else {
        pendingFrames.push(translatedFrame);
      }
    }
  }

  if (!streamingCommitted) {
    for (const pending of pendingFrames) yield pending;
  }
};
