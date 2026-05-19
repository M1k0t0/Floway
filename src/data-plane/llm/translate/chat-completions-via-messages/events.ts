import type {
  ChatCompletionChunk,
  Delta,
} from "../../shared/protocol/chat-completions.ts";
import type { MessagesStreamEventData } from "../../shared/protocol/messages.ts";
import { mapMessagesStopReasonToChatCompletionsFinishReason } from "./result.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../shared/stream/types.ts";

const upstreamMessagesStreamAlgebra = {
  isTerminalEvent: (event: Pick<MessagesStreamEventData, "type">): boolean =>
    event.type === "message_stop" || event.type === "error",
  missingTerminalMessage:
    "Upstream Messages stream ended without a message_stop event.",
};

interface MessagesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  firstReasoningBlockIndex?: number;
}

export const createMessagesToChatCompletionsStreamState =
  (): MessagesToChatCompletionsStreamState => ({
    messageId: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    toolCallIndex: -1,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    firstReasoningBlockIndex: undefined,
  });

const makeChunk = (
  state: MessagesToChatCompletionsStreamState,
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
  state: MessagesToChatCompletionsStreamState,
  outputTokens: number,
): ChatCompletionChunk => {
  const promptTokens = state.inputTokens +
    state.cacheReadInputTokens +
    state.cacheCreationInputTokens;

  return {
    id: state.messageId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: promptTokens + outputTokens,
      ...(state.cacheReadInputTokens > 0
        ? {
          prompt_tokens_details: {
            cached_tokens: state.cacheReadInputTokens,
          },
        }
        : {}),
    },
  };
};

export const translateMessagesEventToChatCompletionsChunks = (
  event: MessagesStreamEventData,
  state: MessagesToChatCompletionsStreamState,
): ChatCompletionChunk[] | "DONE" => {
  switch (event.type) {
    case "message_start": {
      state.messageId = event.message.id;
      state.model = event.message.model;
      state.inputTokens = event.message.usage.input_tokens;
      state.cacheReadInputTokens =
        event.message.usage.cache_read_input_tokens ?? 0;
      state.cacheCreationInputTokens =
        event.message.usage.cache_creation_input_tokens ?? 0;
      return [makeChunk(state, { role: "assistant" })];
    }

    case "content_block_start":
      if (
        event.content_block.type === "thinking" ||
        event.content_block.type === "redacted_thinking"
      ) {
        state.firstReasoningBlockIndex ??= event.index;
      }

      if (event.content_block.type === "redacted_thinking") {
        return state.firstReasoningBlockIndex === event.index
          ? [makeChunk(state, { reasoning_opaque: event.content_block.data })]
          : [];
      }

      if (event.content_block.type !== "tool_use") return [];

      state.toolCallIndex++;
      return [makeChunk(state, {
        tool_calls: [{
          index: state.toolCallIndex,
          id: event.content_block.id,
          type: "function",
          function: {
            name: event.content_block.name,
            arguments: "",
          },
        }],
      })];

    case "content_block_delta":
      switch (event.delta.type) {
        case "thinking_delta":
          return state.firstReasoningBlockIndex === event.index
            ? [makeChunk(state, { reasoning_text: event.delta.thinking })]
            : [];
        case "signature_delta":
          return state.firstReasoningBlockIndex === event.index
            ? [makeChunk(state, { reasoning_opaque: event.delta.signature })]
            : [];
        case "text_delta":
          return [makeChunk(state, { content: event.delta.text })];
        case "input_json_delta":
          return [makeChunk(state, {
            tool_calls: [{
              index: state.toolCallIndex,
              function: { arguments: event.delta.partial_json },
            }],
          })];
        default:
          return [];
      }

    case "content_block_stop":
      return [];

    case "message_delta": {
      const chunk = makeChunk(
        state,
        {},
        mapMessagesStopReasonToChatCompletionsFinishReason(
          event.delta.stop_reason ?? null,
        ),
      );

      return event.usage
        ? [chunk, makeUsageChunk(state, event.usage.output_tokens)]
        : [chunk];
    }

    case "message_stop":
      return "DONE";

    case "ping":
    case "error":
      return [];

    default:
      return [];
  }
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEventData): void => {
  if (event.type !== "error") return;

  throw new Error(
    `Upstream Messages stream error: ${event.error.type}: ${event.error.message}`,
    { cause: event },
  );
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
  const state = createMessagesToChatCompletionsStreamState();

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamMessagesStreamAlgebra,
    )
  ) {
    throwOnMessagesFatalEvent(event);

    const translated = translateMessagesEventToChatCompletionsChunks(
      event,
      state,
    );

    if (translated === "DONE") {
      yield doneFrame();
      continue;
    }

    for (const chunk of translated) {
      yield eventFrame(chunk);
    }
  }
};
