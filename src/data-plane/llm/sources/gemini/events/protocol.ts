import type {
  GeminiErrorResponse,
  GeminiStreamEvent,
} from "../../../shared/protocol/gemini.ts";
import type { ProtocolTerminalAlgebra } from "../../../shared/stream/protocol-algebra.ts";

export const isGeminiErrorEvent = (
  event: GeminiStreamEvent,
): event is GeminiErrorResponse => "error" in event;

export const isGeminiFinishedEvent = (event: GeminiStreamEvent): boolean =>
  "candidates" in event &&
  event.candidates?.some((candidate) =>
      candidate.finishReason !== undefined
    ) ===
    true;

export const isGeminiTerminalEvent = (event: GeminiStreamEvent): boolean =>
  isGeminiErrorEvent(event) || isGeminiFinishedEvent(event);

export const geminiSourceStreamAlgebra = {
  doneTerminates: true,
  isTerminalEvent: isGeminiTerminalEvent,
  missingTerminalMessage: "Gemini stream ended without a terminal event.",
} satisfies ProtocolTerminalAlgebra<GeminiStreamEvent>;
