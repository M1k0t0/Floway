import type { ChatCompletionChunk } from "../../shared/protocol/chat-completions.ts";
import type { MessagesStreamEventData } from "../../shared/protocol/messages.ts";
import {
  mapChatCompletionsFinishReasonToMessagesStopReason,
  mapChatCompletionsUsageToMessagesUsage,
  toMessagesId,
} from "./result.ts";
import { checkWhitespaceOverflow } from "../shared/tool-arguments.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";

const upstreamChatCompletionStreamAlgebra = {
  doneTerminates: true as const,
  missingTerminalMessage:
    "Upstream Chat Completions stream ended without a DONE sentinel.",
};

type ChatStreamDelta = ChatCompletionChunk["choices"][0]["delta"];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta["tool_calls"]>;

type DeferredAfterThinking =
  | { type: "content"; content: string }
  | { type: "tool_calls"; toolCalls: ChatStreamToolCalls };

interface ChatCompletionsToMessagesStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  contentBlockOpen: boolean;
  toolCalls: Record<number, {
    id: string;
    name: string;
    messagesBlockIndex: number;
    consecutiveWhitespace: number;
  }>;
  aborted?: boolean;
  thinkingBlockOpen?: boolean;
  pendingReasoningOpaque?: string;
  pendingThinkingSignature?: string;
  deferredAfterThinking: DeferredAfterThinking[];
  pendingFinishReason?: ChatCompletionChunk["choices"][0]["finish_reason"];
  pendingUsage?: ChatCompletionChunk["usage"];
  messageStopped?: boolean;
  usageSent?: boolean;
}

const hasPendingReasoning = (
  state: ChatCompletionsToMessagesStreamState,
): boolean =>
  Boolean(
    state.thinkingBlockOpen || state.pendingReasoningOpaque !== undefined,
  );

const isToolBlockOpen = (
  state: ChatCompletionsToMessagesStreamState,
): boolean =>
  state.contentBlockOpen &&
  Object.values(state.toolCalls).some((toolCall) =>
    toolCall.messagesBlockIndex === state.contentBlockIndex
  );

const closeThinkingBlock = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (!state.thinkingBlockOpen) return;

  if (state.pendingThinkingSignature !== undefined) {
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "signature_delta",
        signature: state.pendingThinkingSignature,
      },
    });
    state.pendingThinkingSignature = undefined;
  }

  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
  state.thinkingBlockOpen = false;
};

const attachOpaqueToOpenThinkingBlock = (
  state: ChatCompletionsToMessagesStreamState,
): boolean => {
  if (
    !state.thinkingBlockOpen || state.pendingReasoningOpaque === undefined
  ) {
    return false;
  }

  state.pendingThinkingSignature = (state.pendingThinkingSignature ?? "") +
    state.pendingReasoningOpaque;
  state.pendingReasoningOpaque = undefined;
  return true;
};

const closeCurrentBlock = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (!state.contentBlockOpen) return;

  events.push({ type: "content_block_stop", index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.contentBlockOpen = false;
};

const emitPendingOpaqueReasoningBlock = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (state.pendingReasoningOpaque === undefined) return;

  // Opaque data is attachable only to the currently open thinking block. Once a
  // thinking block has closed, later opaque-only reasoning must become its own
  // redacted_thinking block instead of being suppressed by global history.
  if (attachOpaqueToOpenThinkingBlock(state)) return;

  closeCurrentBlock(state, events);
  events.push(
    {
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: {
        type: "redacted_thinking",
        data: state.pendingReasoningOpaque,
      },
    },
    { type: "content_block_stop", index: state.contentBlockIndex },
  );
  state.contentBlockIndex++;
  state.pendingReasoningOpaque = undefined;
};

const emitContentDelta = (
  content: string,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (isToolBlockOpen(state)) {
    closeCurrentBlock(state, events);
  }

  if (!state.contentBlockOpen) {
    events.push({
      type: "content_block_start",
      index: state.contentBlockIndex,
      content_block: { type: "text", text: "" },
    });
    state.contentBlockOpen = true;
  }

  events.push({
    type: "content_block_delta",
    index: state.contentBlockIndex,
    delta: { type: "text_delta", text: content },
  });
};

const handleReasoningDelta = (
  delta: ChatStreamDelta,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): boolean => {
  if (delta.reasoning_text) {
    if (!state.thinkingBlockOpen) {
      closeCurrentBlock(state, events);
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
      state.contentBlockOpen = true;
      state.thinkingBlockOpen = true;
      attachOpaqueToOpenThinkingBlock(state);
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_text },
    });
  }

  if (delta.reasoning_opaque === undefined || delta.reasoning_opaque === null) {
    return false;
  }

  if (state.thinkingBlockOpen) {
    state.pendingThinkingSignature = (state.pendingThinkingSignature ?? "") +
      delta.reasoning_opaque;
    return flushPendingReasoningAndDeferred(state, events);
  }

  state.pendingReasoningOpaque = (state.pendingReasoningOpaque ?? "") +
    delta.reasoning_opaque;
  return false;
};

const handleContentDelta = (
  content: string,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (hasPendingReasoning(state)) {
    state.deferredAfterThinking.push({ type: "content", content });
    return;
  }

  emitContentDelta(content, state, events);
};

const emitToolCallsDelta = (
  toolCalls: ChatStreamToolCalls,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): boolean => {
  for (const toolCall of toolCalls) {
    if (toolCall.id && toolCall.function?.name) {
      closeCurrentBlock(state, events);
      const blockIndex = state.contentBlockIndex;
      state.toolCalls[toolCall.index] = {
        id: toolCall.id,
        name: toolCall.function.name,
        messagesBlockIndex: blockIndex,
        consecutiveWhitespace: 0,
      };
      events.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: {},
        },
      });
      state.contentBlockOpen = true;
    }

    if (!toolCall.function?.arguments) continue;

    const toolCallInfo = state.toolCalls[toolCall.index];
    if (!toolCallInfo) continue;

    const whitespace = checkWhitespaceOverflow(
      toolCall.function.arguments,
      toolCallInfo.consecutiveWhitespace,
    );
    toolCallInfo.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      console.warn(
        "Infinite whitespace detected in tool call arguments, aborting stream",
      );
      state.aborted = true;
      closeCurrentBlock(state, events);
      events.push({
        type: "error",
        error: {
          type: "api_error",
          message:
            "Tool call arguments contained excessive whitespace, indicating a degenerate response.",
        },
      });
      return true;
    }

    events.push({
      type: "content_block_delta",
      index: toolCallInfo.messagesBlockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: toolCall.function.arguments,
      },
    });
  }

  return false;
};

const flushPendingReasoningAndDeferred = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): boolean => {
  // Opaque-only reasoning still owns source order: it may later become a
  // thinking signature, so content/tool deltas wait behind the reasoning gate.
  emitPendingOpaqueReasoningBlock(state, events);
  closeThinkingBlock(state, events);

  const deferred = state.deferredAfterThinking;
  state.deferredAfterThinking = [];

  for (const item of deferred) {
    if (item.type === "content") {
      emitContentDelta(item.content, state, events);
      continue;
    }

    if (emitToolCallsDelta(item.toolCalls, state, events)) return true;
  }

  return false;
};

const handleToolCallsDelta = (
  toolCalls: ChatStreamToolCalls,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): boolean => {
  if (hasPendingReasoning(state)) {
    state.deferredAfterThinking.push({ type: "tool_calls", toolCalls });
    return false;
  }

  return emitToolCallsDelta(toolCalls, state, events);
};

const handleFinishReason = (
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"],
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (flushPendingReasoningAndDeferred(state, events)) return;

  closeCurrentBlock(state, events);

  state.pendingFinishReason = finishReason;
  if (chunk.usage) state.pendingUsage = chunk.usage;
  if (chunk.usage) flushFinalMessage(state, events);
};

const flushFinalMessage = (
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (!state.pendingFinishReason || state.messageStopped) return;

  const usage = mapChatCompletionsUsageToMessagesUsage(state.pendingUsage);
  if (state.pendingUsage) state.usageSent = true;

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(
          state.pendingFinishReason,
        ),
        stop_sequence: null,
      },
      usage,
    },
    { type: "message_stop" },
  );

  state.messageStopped = true;
  state.pendingFinishReason = undefined;
};

export const createChatCompletionsToMessagesStreamState =
  (): ChatCompletionsToMessagesStreamState => ({
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
    deferredAfterThinking: [],
  });

export const translateChatCompletionsChunkToMessagesEvents = (
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];

  if (chunk.choices.length === 0) {
    if (!state.aborted && chunk.usage && !state.usageSent) {
      state.pendingUsage = chunk.usage;
      flushFinalMessage(state, events);
    }

    return events;
  }

  if (state.aborted) return events;

  // Chat Completions `n > 1` returns alternative completions, not parts of one
  // answer. Messages has no multi-candidate shape, so only the first choice
  // can be represented; choices[1+] are dropped.
  const choice = chunk.choices[0];

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: toMessagesId(chunk.id),
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
      },
    });
    state.messageStartSent = true;
  }

  if (handleReasoningDelta(choice.delta, state, events)) return events;

  if (choice.delta.content) {
    handleContentDelta(choice.delta.content, state, events);
  }

  if (choice.delta.tool_calls?.length) {
    if (handleToolCallsDelta(choice.delta.tool_calls, state, events)) {
      return events;
    }
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state, events);
  }

  return events;
};

// Call once after the upstream Chat stream is exhausted. Some final Messages SSE
// events are intentionally buffered until end-of-stream so late usage and
// opaque-only reasoning can be emitted in valid block/message order.
export const flushChatCompletionsToMessagesEvents = (
  state: ChatCompletionsToMessagesStreamState,
): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  if (state.aborted) return events;
  if (flushPendingReasoningAndDeferred(state, events)) return events;
  closeCurrentBlock(state, events);
  flushFinalMessage(state, events);
  return events;
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  const state = createChatCompletionsToMessagesStreamState();

  for await (
    const chunk of protocolEventsUntilTerminal(
      frames,
      upstreamChatCompletionStreamAlgebra,
    )
  ) {
    for (
      const event of translateChatCompletionsChunkToMessagesEvents(
        chunk,
        state,
      )
    ) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToMessagesEvents(state)) {
    yield eventFrame(event);
  }
};
