import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import type { ProtocolTerminalAlgebra } from "../../../shared/stream/protocol-algebra.ts";

const isMessagesTerminalEvent = (
  event: Pick<MessagesStreamEventData, "type">,
): boolean => event.type === "message_stop" || event.type === "error";

export const messagesSourceStreamAlgebra = {
  isTerminalEvent: isMessagesTerminalEvent,
  missingTerminalMessage: "Messages stream ended without a message_stop event.",
} satisfies ProtocolTerminalAlgebra<MessagesStreamEventData>;
