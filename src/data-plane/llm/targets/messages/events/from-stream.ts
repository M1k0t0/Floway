import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../../shared/protocol/messages.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
  type SseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";
import { messagesResultToEvents } from "../../../shared/protocol/messages.ts";

const messagesSSEFrameToEvent = (
  frame: SseFrame,
): ProtocolFrame<MessagesStreamEventData> | null => {
  const data = frame.data.trim();
  if (!data) return null;
  if (data === "[DONE]") return doneFrame();

  try {
    return eventFrame(JSON.parse(data) as MessagesStreamEventData);
  } catch (error) {
    throw new Error(
      `Malformed upstream Messages SSE JSON for event "${
        frame.event ?? "message"
      }": ${data}`,
      { cause: error },
    );
  }
};

export const messagesStreamFramesToEvents = async function* (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      const event = messagesSSEFrameToEvent(frame);
      if (event) yield event;
      continue;
    }

    yield* messagesResultToEvents(frame.data);
  }
};
