import type { ResponseStreamEvent } from "../../../shared/protocol/responses.ts";
import type { ProtocolTerminalAlgebra } from "../stream/protocol-algebra.ts";

export type ResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

const isResponsesTerminalEvent = (
  event: Pick<ResponseStreamEvent, "type">,
): boolean =>
  event.type === "response.completed" ||
  event.type === "response.incomplete" ||
  event.type === "response.failed" ||
  event.type === "error";

export const responsesStreamAlgebra = {
  isTerminalEvent: isResponsesTerminalEvent,
  missingTerminalMessage: "Responses stream ended without a terminal event.",
} satisfies ProtocolTerminalAlgebra<ResponsesStreamEvent>;
