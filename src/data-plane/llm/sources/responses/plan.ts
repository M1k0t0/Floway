import type { ResponsesPayload } from "../../shared/protocol/responses.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { CopilotFetchOptions } from "../../../../shared/copilot.ts";

export type ResponsesPlan =
  | { target: "responses"; fetchOptions: CopilotFetchOptions }
  | { target: "messages"; fetchOptions: CopilotFetchOptions }
  | { target: "chat-completions"; fetchOptions: CopilotFetchOptions };

const hasVision = (payload: ResponsesPayload): boolean => {
  if (!Array.isArray(payload.input)) return false;

  return payload.input.some((item) =>
    item.type === "message" &&
    Array.isArray(item.content) &&
    item.content.some((block) =>
      (block as { type?: string }).type === "input_image" ||
      (block as { type?: string }).type === "image"
    )
  );
};

const getInitiator = (payload: ResponsesPayload): "user" | "agent" => {
  if (!Array.isArray(payload.input)) return "user";

  const lastItem = payload.input[payload.input.length - 1];
  return lastItem?.type === "function_call_output" ? "agent" : "user";
};

export const planResponsesRequest = (
  payload: ResponsesPayload,
  capabilities: ModelCapabilities,
): ResponsesPlan | null => {
  const fetchOptions = {
    vision: hasVision(payload),
    initiator: getInitiator(payload),
  };

  // The broader Responses -> Messages -> Chat fallback surface is product
  // behavior here, not an accidental route-order default.
  if (capabilities.supportsResponses) {
    return {
      target: "responses",
      fetchOptions,
    };
  }

  if (capabilities.supportsMessages) {
    return {
      target: "messages",
      fetchOptions,
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      target: "chat-completions",
      fetchOptions,
    };
  }

  return null;
};
