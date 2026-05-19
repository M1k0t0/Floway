import type {
  ChatCompletionResponse,
  ChatReasoningItem,
  ToolCall,
} from "../../shared/protocol/chat-completions.ts";
import type { ResponsesResult } from "../../shared/protocol/responses.ts";
import { toChatReasoningItem } from "../shared/chat-responses-reasoning.ts";

export const mapResponsesFinishReasonToChatCompletionsFinishReason = (
  response: ResponsesResult,
): ChatCompletionResponse["choices"][0]["finish_reason"] => {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call")
      ? "tool_calls"
      : "stop";
  }

  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length";
  }

  return "stop";
};

export const translateResponsesToChatCompletion = (
  response: ResponsesResult,
): ChatCompletionResponse => {
  let content = "";
  const toolCalls: ToolCall[] = [];
  const reasoningItems: ChatReasoningItem[] = [];
  let reasoningText: string | undefined;
  let reasoningOpaque: string | undefined;
  let hasScalarReasoning = false;

  // Preserve every reasoning item, and expose only the first scalar group through
  // legacy `reasoning_text` / `reasoning_opaque` fields.
  for (const item of response.output) {
    if (item.type === "message") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          content += block.text;
          continue;
        }

        // Compromise: our local Chat shape has no dedicated refusal field, so
        // keep refusal text visible rather than inventing extra translated
        // semantics at this boundary.
        content += block.refusal;
      }
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }

    reasoningItems.push(toChatReasoningItem(item));
    const text = item.summary.map((part) => part.text).join("");
    const hasEncryptedContent = Object.hasOwn(item, "encrypted_content");
    if (!hasScalarReasoning && (text || hasEncryptedContent)) {
      if (text) reasoningText = text;
      if (hasEncryptedContent) reasoningOpaque = item.encrypted_content;
      hasScalarReasoning = true;
    }
  }

  if (!content && response.output_text) {
    content = response.output_text;
  }

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningText !== undefined
          ? { reasoning_text: reasoningText }
          : {}),
        ...(reasoningOpaque !== undefined
          ? { reasoning_opaque: reasoningOpaque }
          : {}),
        ...(reasoningItems.length > 0
          ? { reasoning_items: reasoningItems }
          : {}),
      },
      finish_reason: mapResponsesFinishReasonToChatCompletionsFinishReason(
        response,
      ),
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
        : {}),
    },
  };
};
