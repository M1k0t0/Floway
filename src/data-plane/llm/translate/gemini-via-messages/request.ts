import type {
  GeminiContent,
  GeminiFunctionCallingConfig,
  GeminiGenerateContentRequest,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiThinkingConfig,
} from "../../shared/protocol/gemini.ts";
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesImageBlock,
  type MessagesPayload,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
} from "../../shared/protocol/messages.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";

type UnmatchedToolCallIds = Record<string, string[]>;

const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type SupportedImageMediaType = typeof SUPPORTED_IMAGE_MEDIA_TYPES[number];

const deterministicToolCallId = (
  turnIndex: number,
  partIndex: number,
): string => `gemini_call_${turnIndex}_${partIndex}`;

const isSupportedImageMediaType = (
  mediaType: string,
): mediaType is SupportedImageMediaType =>
  SUPPORTED_IMAGE_MEDIA_TYPES.some((supported) => supported === mediaType);

const partText = (part: GeminiPart): string | null =>
  typeof part.text === "string" ? part.text : null;

const collectSystemText = (content?: GeminiContent): string | null => {
  const text = content?.parts
    .map(partText)
    .filter((value): value is string => value !== null);

  return text?.length ? text.join("\n\n") : null;
};

const inlineDataToImageBlock = (
  part: GeminiPart,
): MessagesImageBlock | null => {
  const inlineData = part.inlineData;
  if (!inlineData || !isSupportedImageMediaType(inlineData.mimeType)) {
    return null;
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: inlineData.mimeType,
      data: inlineData.data,
    },
  };
};

const removeMatchedId = (
  ids: string[] | undefined,
  id: string,
): void => {
  const index = ids?.lastIndexOf(id) ?? -1;
  if (index >= 0) ids?.splice(index, 1);
};

const buildToolResultBlock = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): MessagesToolResultBlock | null => {
  const response = part.functionResponse;
  if (!response) return null;

  const unmatchedIds = unmatchedToolCallIds[response.name];
  const toolUseId = response.id ?? unmatchedIds?.shift() ??
    deterministicToolCallId(turnIndex, partIndex);
  if (response.id !== undefined) removeMatchedId(unmatchedIds, response.id);

  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(response.response),
  };
};

const buildUserMessage = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): MessagesPayload["messages"][number] | null => {
  const blocks: MessagesUserContentBlock[] = [];

  content.parts.forEach((part, partIndex) => {
    const toolResult = buildToolResultBlock(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    );
    if (toolResult) {
      blocks.push(toolResult);
      return;
    }

    const text = partText(part);
    if (text !== null) {
      blocks.push({ type: "text", text });
      return;
    }

    const image = inlineDataToImageBlock(part);
    if (image) blocks.push(image);
  });

  return blocks.length ? { role: "user", content: blocks } : null;
};

const attachSignatureToThinking = (
  blocks: MessagesAssistantContentBlock[],
  signature: string | undefined,
  firstThinkingIndex: number | undefined,
  firstSignedActionIndex: number | undefined,
): void => {
  if (signature === undefined) return;

  if (firstThinkingIndex !== undefined) {
    const block = blocks[firstThinkingIndex];
    if (block?.type === "thinking") block.signature = signature;
    return;
  }

  if (firstSignedActionIndex !== undefined) {
    blocks.splice(firstSignedActionIndex, 0, {
      type: "redacted_thinking",
      data: signature,
    });
  }
};

const buildToolUseBlock = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): MessagesAssistantContentBlock | null => {
  const call = part.functionCall;
  if (!call) return null;

  const id = call.id ?? deterministicToolCallId(turnIndex, partIndex);
  unmatchedToolCallIds[call.name] ??= [];
  unmatchedToolCallIds[call.name].push(id);

  return {
    type: "tool_use",
    id,
    name: call.name,
    input: call.args,
  };
};

const buildAssistantMessage = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): MessagesPayload["messages"][number] | null => {
  const blocks: MessagesAssistantContentBlock[] = [];
  let firstThinkingIndex: number | undefined;
  let firstActionSignature: string | undefined;
  let firstSignedActionIndex: number | undefined;

  content.parts.forEach((part, partIndex) => {
    if (
      part.thoughtSignature !== undefined && firstActionSignature === undefined
    ) {
      firstActionSignature = part.thoughtSignature;
    }

    if (part.thought === true && typeof part.text === "string") {
      firstThinkingIndex ??= blocks.length;
      blocks.push({ type: "thinking", thinking: part.text });
      return;
    }

    const toolUse = buildToolUseBlock(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    );
    if (toolUse) {
      if (part.thoughtSignature !== undefined) {
        firstSignedActionIndex ??= blocks.length;
      }
      blocks.push(toolUse);
      return;
    }

    const text = partText(part);
    if (text !== null) {
      if (part.thoughtSignature !== undefined) {
        firstSignedActionIndex ??= blocks.length;
      }
      blocks.push({ type: "text", text });
    }
  });

  attachSignatureToThinking(
    blocks,
    firstActionSignature,
    firstThinkingIndex,
    firstSignedActionIndex,
  );

  return blocks.length ? { role: "assistant", content: blocks } : null;
};

const mapThinkingEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): "low" | "medium" | "high" | undefined => {
  switch (thinkingConfig?.thinkingLevel) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return undefined;
  }
};

const applyThinkingConfig = (
  request: MessagesPayload,
  thinkingConfig?: GeminiThinkingConfig,
): void => {
  if (!thinkingConfig) return;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === -1) {
      request.thinking = { type: "adaptive" };
    } else if (thinkingConfig.thinkingBudget > 0) {
      request.thinking = {
        type: "enabled",
        budget_tokens: thinkingConfig.thinkingBudget,
      };
    } else if (thinkingConfig.thinkingBudget === 0) {
      request.thinking = { type: "disabled" };
    }
  }

  const effort = mapThinkingEffort(thinkingConfig);
  if (effort !== undefined) request.output_config = { effort };
};

const applyGenerationConfig = (
  request: MessagesPayload,
  generationConfig: GeminiGenerationConfig | undefined,
  fallbackMaxOutputTokens: number,
): void => {
  request.max_tokens = generationConfig?.maxOutputTokens ??
    fallbackMaxOutputTokens;

  if (!generationConfig) return;

  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }
  if (generationConfig.topK !== undefined) {
    request.top_k = generationConfig.topK;
  }
  if (generationConfig.stopSequences !== undefined) {
    request.stop_sequences = generationConfig.stopSequences;
  }

  applyThinkingConfig(request, generationConfig.thinkingConfig);
};

const inputSchemaForDeclaration = (
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (parameters !== undefined) return parameters;

  // MessagesClientTool requires input_schema, so parameterless Gemini function
  // declarations use the smallest object schema rather than dropping the tool.
  return { type: "object", properties: {} };
};

const buildTools = (
  payload: GeminiGenerateContentRequest,
): MessagesTool[] | undefined => {
  const allowedFunctionNames = payload.toolConfig?.functionCallingConfig
    ?.allowedFunctionNames;
  const allowedNames = allowedFunctionNames?.length
    ? new Set(allowedFunctionNames)
    : null;
  const tools = payload.tools?.flatMap((toolGroup) =>
    toolGroup.functionDeclarations
      ?.filter((declaration) => allowedNames?.has(declaration.name) ?? true)
      .map((declaration) => ({
        type: "custom" as const,
        name: declaration.name,
        ...(declaration.description !== undefined
          ? { description: declaration.description }
          : {}),
        input_schema: inputSchemaForDeclaration(declaration.parameters),
      })) ?? []
  );

  return tools?.length ? tools : undefined;
};

const mapToolChoice = (
  config?: GeminiFunctionCallingConfig,
): MessagesPayload["tool_choice"] | undefined => {
  switch (config?.mode) {
    case "NONE":
      return { type: "none" };
    case "AUTO":
    case "VALIDATED":
      return { type: "auto" };
    case "ANY":
      return config.allowedFunctionNames?.length === 1
        ? { type: "tool", name: config.allowedFunctionNames[0] }
        : { type: "any" };
    default:
      return undefined;
  }
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentRequest,
  model: string,
  wantsStream: boolean,
  capabilities: ModelCapabilities,
): MessagesPayload => {
  // Gemini can omit maxOutputTokens, but MessagesPayload requires max_tokens.
  // Prefer the model's advertised `/models` cap when one is known; otherwise
  // fall back to the gateway policy default shared with the other *-to-Messages
  // translators.
  const fallbackMaxOutputTokens = capabilities.maxOutputTokens ??
    MESSAGES_FALLBACK_MAX_TOKENS;
  const request: MessagesPayload = {
    model,
    stream: wantsStream,
    max_tokens: fallbackMaxOutputTokens,
    messages: [],
  };
  const unmatchedToolCallIds: UnmatchedToolCallIds = {};

  const system = collectSystemText(payload.systemInstruction);
  if (system !== null) request.system = system;

  payload.contents?.forEach((content, turnIndex) => {
    const message = content.role === "model"
      ? buildAssistantMessage(content, turnIndex, unmatchedToolCallIds)
      : buildUserMessage(content, turnIndex, unmatchedToolCallIds);
    if (message) request.messages.push(message);
  });

  applyGenerationConfig(
    request,
    payload.generationConfig,
    fallbackMaxOutputTokens,
  );

  const tools = buildTools(payload);
  if (tools) request.tools = tools;

  const toolChoice = mapToolChoice(payload.toolConfig?.functionCallingConfig);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;

  return request;
};
