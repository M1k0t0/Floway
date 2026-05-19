import type { ChatCompletionChunk } from "../../../shared/protocol/chat-completions.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { protocolFramesUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import { chatCompletionSourceStreamAlgebra } from "./protocol.ts";

export const chatProtocolEventToSSEFrame = (
  frame: ProtocolFrame<ChatCompletionChunk>,
): SseFrame =>
  frame.type === "done"
    ? sseFrame("[DONE]")
    : sseFrame(JSON.stringify(frame.event));

interface ChatProtocolEventsToSSEFramesOptions {
  includeUsageChunk?: boolean;
  onUsageChunk?: (usage: NonNullable<ChatCompletionChunk["usage"]>) => void;
}

const readUsage = (
  frame: ProtocolFrame<ChatCompletionChunk>,
): NonNullable<ChatCompletionChunk["usage"]> | null => {
  if (frame.type !== "event" || !Array.isArray(frame.event.choices)) {
    return null;
  }

  return frame.event.choices.length === 0 && frame.event.usage !== undefined
    ? frame.event.usage
    : null;
};

export const chatProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
  options: ChatProtocolEventsToSSEFramesOptions = {},
): AsyncGenerator<SseFrame> {
  const includeUsageChunk = options.includeUsageChunk ?? true;

  for await (
    const frame of protocolFramesUntilTerminal(
      frames,
      chatCompletionSourceStreamAlgebra,
    )
  ) {
    const usage = readUsage(frame);
    if (usage) options.onUsageChunk?.(usage);
    if (!includeUsageChunk && usage) continue;

    yield chatProtocolEventToSSEFrame(frame);
  }
};
