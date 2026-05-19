import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../shared/protocol/messages.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import type { ProtocolFrame } from "../../../shared/stream/types.ts";
import { messagesSourceStreamAlgebra } from "./protocol.ts";
import { reassembleMessagesEvents } from "./reassemble.ts";

export const collectMessagesProtocolEventsToResponse = async (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
): Promise<MessagesResponse> => {
  return await reassembleMessagesEvents(
    protocolEventsUntilTerminal(frames, messagesSourceStreamAlgebra),
  );
};
