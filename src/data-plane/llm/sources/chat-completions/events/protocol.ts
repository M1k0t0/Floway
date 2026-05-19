import type { ChatCompletionChunk } from "../../../shared/protocol/chat-completions.ts";
import { chatCompletionsErrorPayloadMessage } from "../../../shared/protocol/chat-completions-errors.ts";
import type { ProtocolTerminalAlgebra } from "../../../shared/stream/protocol-algebra.ts";

export const chatCompletionSourceStreamAlgebra = {
  doneTerminates: true,
  isTerminalEvent: (event: ChatCompletionChunk) =>
    chatCompletionsErrorPayloadMessage(event) !== null,
  missingTerminalMessage:
    "Chat Completions stream ended without a DONE sentinel.",
} satisfies ProtocolTerminalAlgebra<ChatCompletionChunk>;
