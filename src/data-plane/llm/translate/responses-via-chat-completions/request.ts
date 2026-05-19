import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "../../shared/protocol/chat-completions.ts";
import type {
  ResponseFunctionTool,
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
  ResponseTool,
  ResponseToolChoice,
} from "../../shared/protocol/responses.ts";
import { toChatReasoningItem } from "../shared/chat-responses-reasoning.ts";

const toChatCompletionsContent = (
  content: string | ResponseInputContent[],
): string | ContentPart[] => {
  if (typeof content === "string") return content;

  const parts: ContentPart[] = [];

  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type !== "input_image") continue;

    parts.push({
      type: "image_url",
      image_url: {
        url: part.image_url,
        detail: part.detail,
      },
    });
  }

  return parts.some((part) => part.type === "image_url") ? parts : parts
    .filter((part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text"
    )
    // Assumption: Responses text parts are transport fragments of one
    // message, not paragraph-level blocks. Keep the current no-separator
    // join unless upstream semantics prove otherwise.
    .map((part) => part.text)
    .join("");
};

const toAssistantText = (
  content: string | ResponseInputContent[],
): string => {
  if (typeof content === "string") return content;

  return content
    .filter((part): part is Extract<ResponseInputContent, { text: string }> =>
      part.type === "input_text" || part.type === "output_text"
    )
    // Same assumption as above: these parts are one message's text fragments,
    // so we preserve the existing no-separator flattening.
    .map((part) => part.text)
    .join("");
};

interface AssistantAccumulator {
  message: Message;
  hasScalarReasoning: boolean;
}

const ensureAssistant = (
  assistant: AssistantAccumulator | null,
): AssistantAccumulator =>
  assistant ?? {
    message: { role: "assistant", content: null },
    hasScalarReasoning: false,
  };

const appendAssistantText = (
  assistant: AssistantAccumulator | null,
  text: string,
): AssistantAccumulator | null => {
  if (!text) return assistant;

  const next = ensureAssistant(assistant);
  next.message.content = typeof next.message.content === "string"
    ? next.message.content + text
    : text;
  return next;
};

const appendAssistantReasoning = (
  assistant: AssistantAccumulator | null,
  item: Extract<ResponseInputItem, { type: "reasoning" }>,
): AssistantAccumulator => {
  const next = ensureAssistant(assistant);
  const reasoningText = item.summary.map((part) => part.text).join("");
  const reasoningItem = toChatReasoningItem(item);
  // Preserve item-level reasoning instead of compressing all Responses reasoning
  // into legacy scalar Chat fields.
  next.message.reasoning_items = [
    ...(next.message.reasoning_items ?? []),
    reasoningItem,
  ];

  const hasEncryptedContent = Object.hasOwn(item, "encrypted_content");
  if (!next.hasScalarReasoning && (reasoningText || hasEncryptedContent)) {
    if (reasoningText) next.message.reasoning_text = reasoningText;
    if (hasEncryptedContent) {
      next.message.reasoning_opaque = item.encrypted_content;
    }
    next.hasScalarReasoning = true;
  }

  return next;
};

const appendAssistantToolCall = (
  assistant: AssistantAccumulator | null,
  item: Extract<ResponseInputItem, { type: "function_call" }>,
): AssistantAccumulator => {
  const next = ensureAssistant(assistant);
  next.message.tool_calls = [
    ...(next.message.tool_calls ?? []),
    {
      id: item.call_id,
      type: "function",
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    } satisfies ToolCall,
  ];
  return next;
};

const translateResponseTools = (
  tools?: ResponseTool[] | null,
): Tool[] | undefined => {
  if (!tools?.length) return undefined;

  // Same defense-in-depth as the responses-to-messages translator: the
  // source-level strip-unsupported-tools interceptor drops hosted server tools
  // and fix-apply-patch-tools rewrites Codex's `apply_patch` Freeform tool.
  // Other Freeform tools have no shim today, so anything left without
  // `name`/`parameters` is dropped here rather than forwarded as a malformed
  // function tool.
  const functionTools = tools.filter(
    (tool): tool is ResponseFunctionTool => tool.type === "function",
  );
  if (functionTools.length === 0) return undefined;

  return functionTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      parameters: tool.parameters,
      strict: tool.strict,
      ...(tool.description ? { description: tool.description } : {}),
    },
  }));
};

const translateResponseToolChoice = (
  choice?: ResponseToolChoice,
): ChatCompletionsPayload["tool_choice"] => {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  // Source interceptors strip hosted server tools and rewrite the only known
  // Freeform tool (`apply_patch`) into a function tool. Any remaining
  // non-function forced choice would point at a tool that no longer exists.
  if (choice.type !== "function") return undefined;
  return { type: "function", function: { name: choice.name } };
};

const buildChatResponseFormat = (
  text: ResponsesPayload["text"],
): ChatCompletionsPayload["response_format"] | undefined => {
  if (text === undefined) return undefined;
  if (text === null) return null;
  // `text: {}` means no explicit format. Keep it omitted instead of converting
  // absence into an explicit Chat `response_format: null`.
  if (!Object.hasOwn(text, "format")) return undefined;
  const format = text.format;
  if (format === undefined) return undefined;
  if (format === null) return null;
  // Responses API uses a flat json_schema shape
  // ({ type, name, strict, schema }), while Chat Completions wraps the
  // schema details under a nested `json_schema` field. Reshape only when
  // needed; pass `text`/`json_object` and already-wrapped variants through.
  // Without this, upstreams reject the request with
  // "When response_format type is 'json_schema', the 'json_schema' field
  // must be provided", which Codex's review/guardian flow trips on.
  // References:
  //   https://platform.openai.com/docs/api-reference/responses/create
  //   https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format
  if (format.type === "json_schema" && !("json_schema" in format)) {
    const { type: _type, ...rest } = format;
    return { type: "json_schema", json_schema: rest };
  }
  return format;
};

export const translateResponsesToChatCompletions = (
  payload: ResponsesPayload,
): ChatCompletionsPayload => {
  const responseFormat = buildChatResponseFormat(payload.text);
  const messages: Message[] = payload.instructions
    ? [{ role: "system", content: payload.instructions }]
    : [];

  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input });
  } else {
    let assistant: AssistantAccumulator | null = null;
    const flushAssistant = () => {
      if (!assistant) return;
      messages.push(assistant.message);
      assistant = null;
    };

    for (const item of payload.input) {
      if (item.type === "reasoning") {
        assistant = appendAssistantReasoning(assistant, item);
        continue;
      }

      if (item.type === "function_call") {
        assistant = appendAssistantToolCall(assistant, item);
        continue;
      }

      if (item.type === "function_call_output") {
        flushAssistant();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: item.output,
        });
        continue;
      }

      // item_reference items are connection-bound pointers with no inline
      // content to translate; skip them.
      if (item.type === "item_reference") continue;

      if (item.role === "assistant") {
        assistant = appendAssistantText(
          assistant,
          toAssistantText(item.content),
        );
        continue;
      }

      flushAssistant();
      messages.push({
        role: item.role,
        content: toChatCompletionsContent(item.content),
      });
    }

    flushAssistant();
  }

  // Same-purpose OpenAI fields pass through directly here, while broader
  // Responses-only state such as `previous_response_id` remains native-only.
  return {
    model: payload.model,
    messages,
    ...(payload.max_output_tokens !== undefined
      ? { max_tokens: payload.max_output_tokens }
      : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    ...(payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: payload.parallel_tool_calls }
      : {}),
    ...(responseFormat !== undefined
      ? { response_format: responseFormat }
      : {}),
    ...(payload.prompt_cache_key !== undefined
      ? { prompt_cache_key: payload.prompt_cache_key }
      : {}),
    ...(payload.safety_identifier !== undefined
      ? { safety_identifier: payload.safety_identifier }
      : {}),
    ...(payload.reasoning?.effort != null
      ? { reasoning_effort: payload.reasoning.effort }
      : {}),
    ...(payload.service_tier !== undefined
      ? { service_tier: payload.service_tier }
      : {}),
    // Chat Completions has no request-level counterpart for Responses
    // `reasoning`; only explicit reasoning items survive this translation.
    tools: translateResponseTools(payload.tools),
    tool_choice: translateResponseToolChoice(payload.tool_choice),
  };
};

export const buildTargetRequest = (payload: ResponsesPayload) =>
  translateResponsesToChatCompletions(payload);
