import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../shared/protocol/responses.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import { type ProtocolFrame } from "../../../shared/stream/types.ts";
import {
  responsesStreamAlgebra,
  type ResponsesStreamEvent,
} from "../../../shared/protocol/responses.ts";

type ResponsesReassembleEvent = ResponseStreamEvent | {
  type: "error";
  message?: string;
};

export async function reassembleResponsesEvents(
  events: AsyncIterable<ResponsesReassembleEvent>,
): Promise<ResponsesResult> {
  for await (const event of events) {
    const rawEvent = event as unknown as Record<string, unknown>;
    const type = rawEvent.type as string;

    if (type === "error") {
      const message = (rawEvent.message as string | undefined) ??
        JSON.stringify(event);
      throw new Error(`Upstream SSE error: ${message}`);
    }

    if (
      type === "response.completed" || type === "response.incomplete" ||
      type === "response.failed"
    ) {
      return rawEvent.response as ResponsesResult;
    }
  }

  throw new Error("SSE stream ended without a terminal response event");
}

export const collectResponsesProtocolEventsToResult = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ResponsesResult> => {
  return await reassembleResponsesEvents(
    protocolEventsUntilTerminal(frames, responsesStreamAlgebra),
  );
};
