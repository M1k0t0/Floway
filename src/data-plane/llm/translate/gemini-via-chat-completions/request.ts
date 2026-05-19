import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "../../shared/protocol/chat-completions.ts";
import type {
  GeminiContent,
  GeminiFunctionCallingConfig,
  GeminiGenerateContentRequest,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiThinkingConfig,
} from "../../shared/protocol/gemini.ts";

type UnmatchedToolCallIds = Record<string, string[]>;

const supportedImageMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const deterministicToolCallId = (
  turnIndex: number,
  partIndex: number,
): string => `gemini_call_${turnIndex}_${partIndex}`;

const partText = (part: GeminiPart): string | null =>
  typeof part.text === "string" ? part.text : null;

const collectSystemText = (content?: GeminiContent): string | null => {
  const text = content?.parts
    .map(partText)
    .filter((text): text is string => text !== null);

  return text?.length ? text.join("\n\n") : null;
};

const appendOpaque = (
  current: string | null,
  signature?: string,
): string | null =>
  typeof signature === "string" ? `${current ?? ""}${signature}` : current;

const inlineDataToContentPart = (part: GeminiPart): ContentPart | null => {
  if (!part.inlineData) return null;
  if (!supportedImageMimeTypes.has(part.inlineData.mimeType)) return null;

  return {
    type: "image_url",
    image_url: {
      url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
    },
  };
};

const textToContentPart = (text: string): ContentPart => ({
  type: "text",
  text,
});

const contentFromParts = (
  parts: GeminiPart[],
): string | ContentPart[] | null => {
  const textParts = parts
    .map(partText)
    .filter((text): text is string => text !== null);
  const mediaParts = parts
    .map(inlineDataToContentPart)
    .filter((part): part is ContentPart => part !== null);

  if (!textParts.length && !mediaParts.length) return null;
  if (!mediaParts.length) return textParts.join("\n\n");

  return parts.flatMap((part) => {
    const text = partText(part);
    if (text !== null) return [textToContentPart(text)];

    const media = inlineDataToContentPart(part);
    return media ? [media] : [];
  });
};

const buildAssistantMessage = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): Message | null => {
  const visibleParts: GeminiPart[] = [];
  const thoughtTexts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let reasoningOpaque: string | null = null;

  content.parts.forEach((part, partIndex) => {
    reasoningOpaque = appendOpaque(reasoningOpaque, part.thoughtSignature);

    if (part.functionCall) {
      const id = part.functionCall.id ?? deterministicToolCallId(
        turnIndex,
        partIndex,
      );
      toolCalls.push({
        id,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
      unmatchedToolCallIds[part.functionCall.name] ??= [];
      unmatchedToolCallIds[part.functionCall.name].push(id);
      return;
    }

    if (part.thought === true && typeof part.text === "string") {
      thoughtTexts.push(part.text);
      return;
    }

    if (part.text !== undefined || part.inlineData) visibleParts.push(part);
  });

  const message: Message = {
    role: "assistant",
    content: contentFromParts(visibleParts),
  };

  if (toolCalls.length) message.tool_calls = toolCalls;
  if (thoughtTexts.length) message.reasoning_text = thoughtTexts.join("\n\n");
  if (reasoningOpaque !== null) message.reasoning_opaque = reasoningOpaque;

  return message.content !== null || message.tool_calls?.length ||
      message.reasoning_text !== undefined ||
      message.reasoning_opaque !== undefined
    ? message
    : null;
};

const buildToolMessage = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): Message | null => {
  if (!part.functionResponse) return null;

  const unmatchedIds = unmatchedToolCallIds[part.functionResponse.name];
  const matchedId = part.functionResponse.id ?? unmatchedIds?.shift();
  if (part.functionResponse.id !== undefined && unmatchedIds) {
    const explicitIdIndex = unmatchedIds.indexOf(part.functionResponse.id);
    if (explicitIdIndex >= 0) unmatchedIds.splice(explicitIdIndex, 1);
  }

  return {
    role: "tool",
    tool_call_id: matchedId ?? deterministicToolCallId(turnIndex, partIndex),
    content: JSON.stringify(part.functionResponse.response),
  };
};

const buildUserMessages = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): Message[] => {
  const messages: Message[] = [];
  let pendingParts: GeminiPart[] = [];

  const flushUserParts = (): void => {
    const chatContent = contentFromParts(pendingParts);
    pendingParts = [];
    if (chatContent === null) return;

    messages.push({ role: "user", content: chatContent });
  };

  content.parts.forEach((part, partIndex) => {
    const toolMessage = buildToolMessage(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    );
    if (toolMessage) {
      flushUserParts();
      messages.push(toolMessage);
      return;
    }

    if (part.text !== undefined || part.inlineData) pendingParts.push(part);
  });

  flushUserParts();
  return messages;
};

const applyGenerationConfig = (
  request: ChatCompletionsPayload,
  generationConfig?: GeminiGenerationConfig,
): void => {
  if (!generationConfig) return;

  if (generationConfig.maxOutputTokens !== undefined) {
    request.max_tokens = generationConfig.maxOutputTokens;
  }
  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }
  if (generationConfig.stopSequences !== undefined) {
    request.stop = generationConfig.stopSequences;
  }
  if (generationConfig.candidateCount !== undefined) {
    request.n = generationConfig.candidateCount;
  }
  if (generationConfig.presencePenalty !== undefined) {
    request.presence_penalty = generationConfig.presencePenalty;
  }
  if (generationConfig.frequencyPenalty !== undefined) {
    request.frequency_penalty = generationConfig.frequencyPenalty;
  }
  if (generationConfig.seed !== undefined) {
    request.seed = generationConfig.seed;
  }

  if (generationConfig.responseSchema !== undefined) {
    request.response_format = {
      type: "json_schema",
      json_schema: {
        name: "gemini_response",
        schema: generationConfig.responseSchema,
      },
    };
  } else if (generationConfig.responseMimeType === "application/json") {
    request.response_format = { type: "json_object" };
  }

  const reasoningEffort = mapReasoningEffort(generationConfig.thinkingConfig);
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;
};

const mapReasoningEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): "low" | "medium" | "high" | null => {
  if (!thinkingConfig) return null;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === 0) return null;
    if (thinkingConfig.thinkingBudget <= 2048) return "low";
    if (thinkingConfig.thinkingBudget <= 8192) return "medium";
    return "high";
  }

  switch (thinkingConfig.thinkingLevel) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return null;
  }
};

const buildTools = (payload: GeminiGenerateContentRequest): Tool[] | null => {
  const tools = payload.tools?.flatMap((toolGroup) =>
    toolGroup.functionDeclarations?.map((declaration) => ({
      type: "function" as const,
      function: {
        name: declaration.name,
        ...(declaration.description !== undefined
          ? { description: declaration.description }
          : {}),
        ...(declaration.parameters !== undefined
          ? { parameters: declaration.parameters }
          : {}),
      },
    })) ?? []
  );

  return tools?.length ? tools : null;
};

const filterToolsForAllowedNames = (
  tools: Tool[],
  config?: GeminiFunctionCallingConfig,
): Tool[] => {
  if (config?.mode !== "ANY" || !config.allowedFunctionNames?.length) {
    return tools;
  }

  const allowedNames = new Set(config.allowedFunctionNames);
  return tools.filter((tool) => allowedNames.has(tool.function.name));
};

const mapToolChoice = (
  config?: GeminiFunctionCallingConfig,
): ChatCompletionsPayload["tool_choice"] | undefined => {
  switch (config?.mode) {
    case "NONE":
      return "none";
    case "AUTO":
    case "VALIDATED":
      return "auto";
    case "ANY":
      return config.allowedFunctionNames?.length === 1
        ? {
          type: "function",
          function: { name: config.allowedFunctionNames[0] },
        }
        : "required";
    default:
      return undefined;
  }
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentRequest,
  model: string,
  wantsStream: boolean,
): ChatCompletionsPayload => {
  const request: ChatCompletionsPayload = {
    model,
    stream: wantsStream,
    messages: [],
  };
  const unmatchedToolCallIds: UnmatchedToolCallIds = {};

  const systemText = collectSystemText(payload.systemInstruction);
  if (systemText !== null) {
    request.messages.push({ role: "system", content: systemText });
  }

  payload.contents?.forEach((content, turnIndex) => {
    if (content.role === "model") {
      const message = buildAssistantMessage(
        content,
        turnIndex,
        unmatchedToolCallIds,
      );
      if (message) request.messages.push(message);
      return;
    }

    request.messages.push(
      ...buildUserMessages(content, turnIndex, unmatchedToolCallIds),
    );
  });

  applyGenerationConfig(request, payload.generationConfig);

  const functionCallingConfig = payload.toolConfig?.functionCallingConfig;
  const builtTools = buildTools(payload);
  const tools = builtTools
    ? filterToolsForAllowedNames(builtTools, functionCallingConfig)
    : null;
  if (tools?.length) {
    request.tools = tools;

    const toolChoice = mapToolChoice(functionCallingConfig);
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
  }

  return request;
};
