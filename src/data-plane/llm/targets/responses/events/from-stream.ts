import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../shared/protocol/responses.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
  type SseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";
import {
  responsesResultToEvents,
  type SequencedResponseStreamEvent,
} from "./from-result.ts";

const responsesSSEFrameToEvent = (
  frame: SseFrame,
): ProtocolFrame<SequencedResponseStreamEvent> | null => {
  const data = frame.data.trim();
  if (!data) return null;
  if (data === "[DONE]") return doneFrame();

  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent;
    const event = frame.event && !(parsed as { type?: string }).type
      ? { ...parsed, type: frame.event }
      : parsed;

    return eventFrame(event as SequencedResponseStreamEvent);
  } catch (error) {
    throw new Error(
      `Malformed upstream Responses SSE JSON for event "${
        frame.event ?? "response"
      }": ${data}`,
      { cause: error },
    );
  }
};

export const responsesStreamFramesToEvents = async function* (
  frames: AsyncIterable<StreamFrame<ResponsesResult>>,
): AsyncGenerator<ProtocolFrame<SequencedResponseStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      const event = responsesSSEFrameToEvent(frame);
      if (event) yield event;
      continue;
    }

    yield* responsesResultToEvents(frame.data);
  }
};
