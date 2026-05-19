import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../../shared/protocol/chat-completions.ts";
import { chatCompletionsErrorPayloadMessage } from "../../../shared/protocol/chat-completions-errors.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
  type SseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";
import { chatCompletionResultToEvents } from "./from-result.ts";

const chatCompletionsSSEFrameToEvent = (
  frame: SseFrame,
): ProtocolFrame<ChatCompletionChunk> | null => {
  const data = frame.data.trim();
  if (!data) return null;
  if (data === "[DONE]") return doneFrame();

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(
      `Malformed upstream Chat Completions SSE JSON: ${data}`,
      { cause: error },
    );
  }

  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }

  return eventFrame(parsed as ChatCompletionChunk);
};

export const chatCompletionsStreamFramesToEvents = async function* (
  frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>,
): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      const event = chatCompletionsSSEFrameToEvent(frame);
      if (event) yield event;
      continue;
    }

    yield* chatCompletionResultToEvents(frame.data);
  }
};
