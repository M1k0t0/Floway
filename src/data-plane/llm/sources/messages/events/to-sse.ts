import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import { messagesSourceStreamAlgebra } from "./protocol.ts";

export const messagesProtocolEventToSSEFrame = (
  event: MessagesStreamEventData,
): SseFrame => sseFrame(JSON.stringify(event), event.type);

export const messagesProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
): AsyncGenerator<SseFrame> {
  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      messagesSourceStreamAlgebra,
    )
  ) {
    yield messagesProtocolEventToSSEFrame(event);
  }
};
