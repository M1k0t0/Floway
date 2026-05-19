import type {
  ChatCompletionsPayload,
  ContentPart,
  Tool,
} from "../../shared/protocol/chat-completions.ts";
import { makeResponsesReasoningId } from "../shared/reasoning.ts";
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputReasoning,
  ResponsesPayload,
  ResponseTool,
  ResponseToolChoice,
} from "../../shared/protocol/responses.ts";
import {
  scalarToResponseReasoningItem,
  translateChatReasoningItems,
} from "../shared/chat-responses-reasoning.ts";

const extractTextContent = (
  content: string | ContentPart[] | null,
): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  // Assumption: OpenAI text parts are transport fragments of one message, not
  // Anthropic-style paragraph blocks. Preserve the current no-separator join
  // unless we later find a stronger upstream boundary guarantee.
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("");
};

const toResponsesContent = (
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: ResponseInputContent[] = [];

  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    parts.push({
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail ?? "auto",
    });
  }

  return parts.length > 0 ? parts : "";
};

const toResponsesAssistantContent = (
  content: string | ContentPart[] | null,
): string | ResponseInputContent[] => {
  const text = extractTextContent(content);
  return text ? [{ type: "output_text", text }] : "";
};

const translateChatTools = (tools?: Tool[] | null): ResponseTool[] | null =>
  tools?.length
    ? tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      parameters: tool.function.parameters ??
        { type: "object", properties: {} },
      // Chat function tools are non-strict by default while Responses function
      // tools default strict; make omission explicit to preserve Chat semantics.
      strict: tool.function.strict ?? false,
      ...(tool.function.description
        ? { description: tool.function.description }
        : {}),
    }))
    : null;

const translateChatToolChoice = (
  choice?: ChatCompletionsPayload["tool_choice"],
): ResponseToolChoice => {
  if (!choice) return "auto";
  if (typeof choice === "string") {
    return choice === "none" || choice === "auto" || choice === "required"
      ? choice
      : "auto";
  }

  return choice.type === "function" && choice.function?.name
    ? { type: "function", name: choice.function.name }
    : "auto";
};

const buildResponsesTextConfig = (
  responseFormat: ChatCompletionsPayload["response_format"],
): ResponsesPayload["text"] | undefined => {
  if (responseFormat === undefined) return undefined;
  return responseFormat === null ? null : { format: responseFormat };
};

export const translateChatCompletionsToResponses = (
  payload: ChatCompletionsPayload,
): ResponsesPayload => {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];
  let hoistSystemPrefix = true;

  for (const message of payload.messages) {
    // Only the initial Chat `system` prefix maps cleanly to Responses
    // `instructions`; later `system` and `developer` turns are
    // chronology-bearing input items.
    if (hoistSystemPrefix && message.role === "system") {
      const text = extractTextContent(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: toResponsesContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const reasoningItems = translateChatReasoningItems<
        ResponseInputReasoning
      >(
        message.reasoning_items,
        () => input.length,
      );
      const scalarReasoning = scalarToResponseReasoningItem<
        ResponseInputReasoning
      >(
        message.reasoning_text,
        message.reasoning_opaque,
        makeResponsesReasoningId(input.length),
      );
      if (reasoningItems) {
        input.push(...reasoningItems);
      } else if (scalarReasoning) {
        input.push(scalarReasoning);
      }

      if (message.tool_calls?.length) {
        const text = extractTextContent(message.content);
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }

        for (const toolCall of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: "completed",
          });
        }

        continue;
      }

      input.push({
        type: "message",
        role: "assistant",
        content: toResponsesAssistantContent(message.content),
      });
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      input.push({
        type: "message",
        role: message.role,
        content: toResponsesContent(message.content),
      });
      continue;
    }

    if (!message.tool_call_id) {
      throw new Error(
        "tool message requires tool_call_id for Responses translation",
      );
    }

    input.push({
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    });
  }

  const responseTextConfig = buildResponsesTextConfig(payload.response_format);

  return {
    model: payload.model,
    input,
    ...(instructions.length > 0
      ? { instructions: instructions.join("\n\n") }
      : {}),
    ...(payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined
      ? { max_output_tokens: payload.max_tokens }
      : {}),
    ...(payload.tools !== undefined
      ? { tools: translateChatTools(payload.tools) }
      : {}),
    tool_choice: translateChatToolChoice(payload.tool_choice),
    // Same-purpose OpenAI fields are normal Chat/Responses adapter surface;
    // provider-specific policy filtering belongs at the target boundary, not in
    // pairwise translation.
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    // Preserve Chat's omitted `store` as omitted instead of synthesizing
    // `store: false`. OpenAI's migration guide treats storage as the default
    // behavior for both Responses and new Chat Completions accounts; callers
    // disable it explicitly with `store: false`.
    // Reference:
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: payload.parallel_tool_calls }
      : {}),
    ...(payload.reasoning_effort != null
      ? { reasoning: { effort: payload.reasoning_effort } }
      : {}),
    ...(responseTextConfig !== undefined ? { text: responseTextConfig } : {}),
    ...(payload.prompt_cache_key !== undefined
      ? { prompt_cache_key: payload.prompt_cache_key }
      : {}),
    ...(payload.safety_identifier !== undefined
      ? { safety_identifier: payload.safety_identifier }
      : {}),
    ...(payload.service_tier !== undefined
      ? { service_tier: payload.service_tier }
      : {}),
    // Chat exposes opaque reasoning as scalar `reasoning_opaque`; ask Responses
    // for encrypted content so translated multi-turn Chat clients can round-trip
    // it without inventing a gateway-private state store.
    include: ["reasoning.encrypted_content"],
  };
};

export const buildTargetRequest = (payload: ChatCompletionsPayload) =>
  translateChatCompletionsToResponses(payload);
