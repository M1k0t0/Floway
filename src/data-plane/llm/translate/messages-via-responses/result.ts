import type {
  MessagesAssistantContentBlock,
  MessagesResponse,
} from "../../shared/protocol/messages.ts";
import type {
  ResponseOutputContentBlock,
  ResponseOutputItem,
  ResponsesResult,
} from "../../shared/protocol/responses.ts";
import { packReasoningSignature } from "../shared/messages-responses-signature.ts";
import { parseToolArgumentsObject } from "../shared/tool-arguments.ts";

const combineMessageTextContent = (
  content: ResponseOutputContentBlock[] | undefined,
): string => {
  if (!Array.isArray(content)) return "";

  // Compromise: our local Messages/Chat shapes have no dedicated refusal block,
  // so keep Responses refusal text visible rather than inventing extra
  // translated semantics at this boundary.
  return content.map((block) => {
    if (block.type === "output_text") return block.text;
    if (block.type === "refusal") return block.refusal;
    return "";
  }).join("");
};

const mapOutputToMessagesContent = (
  output: ResponseOutputItem[],
): MessagesAssistantContentBlock[] => {
  const content: MessagesAssistantContentBlock[] = [];

  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        // Pack `${encrypted_content}@${id}` into the Anthropic signature/data
        // slot so the original Responses item id survives the Messages
        // round-trip. Without this, the resynthesized `rs_${index}` id we
        // would otherwise send back next turn fails Copilot's signature
        // verification with `400 invalid_request_body: "Encrypted content
        // item_id did not match the target item id."`. See packing rationale
        // and permalinks in `../shared/messages-responses-signature.ts`.
        const thinking = item.summary?.length
          ? item.summary.map((part) => part.text).join("").trim()
          : "";
        const encryptedContent = item.encrypted_content;
        const hasEncryptedContent = Object.hasOwn(item, "encrypted_content") &&
          encryptedContent !== undefined;

        // Copilot's /v1/messages rejects `thinking: null` and missing
        // `thinking` (Pydantic: "Input should be a valid string" /
        // "Field required"), so an opaque-only reasoning item must round-trip
        // as `redacted_thinking{data}` — the schema-sanctioned signature-only
        // shape — rather than a `thinking` block with no text. A reasoning
        // item with neither summary nor encrypted_content has no valid
        // Anthropic shape (both alternates 400 upstream), so we drop it.
        if (!thinking) {
          if (hasEncryptedContent) {
            content.push({
              type: "redacted_thinking",
              data: packReasoningSignature(item.id, encryptedContent),
            });
          }
          break;
        }

        content.push({
          type: "thinking",
          thinking,
          ...(hasEncryptedContent
            ? { signature: packReasoningSignature(item.id, encryptedContent) }
            : {}),
        });
        break;
      }
      case "function_call":
        if (item.name && item.call_id) {
          content.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: parseToolArgumentsObject(item.arguments),
          });
        }
        break;
      case "message": {
        const text = combineMessageTextContent(item.content);
        if (text.length > 0) content.push({ type: "text", text });
        break;
      }
    }
  }

  return content;
};

const mapResponsesStopReason = (
  response: ResponsesResult,
): MessagesResponse["stop_reason"] => {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call")
      ? "tool_use"
      : "end_turn";
  }

  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }

  return null;
};

export const translateResponsesToMessagesResponse = (
  response: ResponsesResult,
): MessagesResponse => {
  const content = mapOutputToMessagesContent(response.output);
  const finalContent = content.length > 0
    ? content
    : response.output_text
    ? [{ type: "text" as const, text: response.output_text }]
    : [];

  const inputTokens = response.usage?.input_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: finalContent,
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens - (cachedTokens ?? 0),
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens !== undefined
        ? { cache_read_input_tokens: cachedTokens }
        : {}),
    },
  };
};
