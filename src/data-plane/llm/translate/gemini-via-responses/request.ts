import type {
  GeminiContent,
  GeminiFunctionCallingConfig,
  GeminiGenerateContentRequest,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiThinkingConfig,
} from "../../shared/protocol/gemini.ts";
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
  ResponseTool,
  ResponseToolChoice,
} from "../../shared/protocol/responses.ts";

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

const deterministicReasoningId = (
  turnIndex: number,
  partIndex: number,
): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

const partText = (part: GeminiPart): string | null =>
  typeof part.text === "string" ? part.text : null;

const collectSystemText = (content?: GeminiContent): string | null => {
  const text = content?.parts
    .map(partText)
    .filter((value): value is string => value !== null);

  return text?.length ? text.join("\n\n") : null;
};

const flushPendingContent = (
  input: ResponseInputItem[],
  pending: ResponseInputContent[],
  role: "user" | "assistant",
): void => {
  if (pending.length === 0) return;
  input.push({ type: "message", role, content: [...pending] });
  pending.length = 0;
};

const inlineDataToInputImage = (
  part: GeminiPart,
): ResponseInputContent | null => {
  if (!part.inlineData) return null;
  if (!supportedImageMimeTypes.has(part.inlineData.mimeType)) return null;

  return {
    type: "input_image",
    image_url:
      `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
    detail: "auto",
  };
};

const removeMatchedId = (
  ids: string[] | undefined,
  id: string,
): void => {
  const index = ids?.indexOf(id) ?? -1;
  if (index >= 0) ids?.splice(index, 1);
};

const takeFunctionResponseCallId = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): string => {
  const response = part.functionResponse;
  if (!response) return deterministicToolCallId(turnIndex, partIndex);

  const unmatchedIds = unmatchedToolCallIds[response.name];
  if (response.id !== undefined) {
    removeMatchedId(unmatchedIds, response.id);
    return response.id;
  }

  return unmatchedIds?.shift() ?? deterministicToolCallId(turnIndex, partIndex);
};

const buildFunctionCallOutput = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): ResponseInputItem | null => {
  const response = part.functionResponse;
  if (!response) return null;

  return {
    type: "function_call_output",
    call_id: takeFunctionResponseCallId(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    ),
    output: JSON.stringify(response.response),
    status: "completed",
  };
};

const buildFunctionCall = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): ResponseInputItem | null => {
  const call = part.functionCall;
  if (!call) return null;

  const callId = call.id ?? deterministicToolCallId(turnIndex, partIndex);
  unmatchedToolCallIds[call.name] ??= [];
  unmatchedToolCallIds[call.name].push(callId);

  return {
    type: "function_call",
    call_id: callId,
    name: call.name,
    arguments: JSON.stringify(call.args),
    status: "completed",
  };
};

const buildReasoningItem = (
  part: GeminiPart,
  turnIndex: number,
  partIndex: number,
): ResponseInputItem | null => {
  const text = part.thought === true && typeof part.text === "string"
    ? part.text
    : "";
  const hasSignature = Object.hasOwn(part, "thoughtSignature") &&
    part.thoughtSignature !== undefined;

  if (!text && !hasSignature) return null;

  return {
    type: "reasoning",
    id: deterministicReasoningId(turnIndex, partIndex),
    summary: text ? [{ type: "summary_text", text }] : [],
    ...(hasSignature ? { encrypted_content: part.thoughtSignature } : {}),
  };
};

const buildUserInputItems = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const functionOutput = buildFunctionCallOutput(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    );
    if (functionOutput) {
      flushPendingContent(input, pendingContent, "user");
      input.push(functionOutput);
      return;
    }

    const text = partText(part);
    if (text !== null) {
      pendingContent.push({ type: "input_text", text });
      return;
    }

    const image = inlineDataToInputImage(part);
    if (image) pendingContent.push(image);
  });

  flushPendingContent(input, pendingContent, "user");
  return input;
};

const buildAssistantInputItems = (
  content: GeminiContent,
  turnIndex: number,
  unmatchedToolCallIds: UnmatchedToolCallIds,
): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const reasoning = buildReasoningItem(part, turnIndex, partIndex);
    if (reasoning) {
      flushPendingContent(input, pendingContent, "assistant");
      input.push(reasoning);

      if (part.thought === true && !part.functionCall) return;
    }

    const functionCall = buildFunctionCall(
      part,
      turnIndex,
      partIndex,
      unmatchedToolCallIds,
    );
    if (functionCall) {
      flushPendingContent(input, pendingContent, "assistant");
      input.push(functionCall);
      return;
    }

    const text = part.thought === true ? null : partText(part);
    if (text !== null) pendingContent.push({ type: "output_text", text });
  });

  flushPendingContent(input, pendingContent, "assistant");
  return input;
};

const mapReasoningEffort = (
  thinkingConfig?: GeminiThinkingConfig,
): "low" | "medium" | "high" | null => {
  if (!thinkingConfig) return null;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget <= 0) return null;
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

const applyGenerationConfig = (
  request: ResponsesPayload,
  generationConfig?: GeminiGenerationConfig,
): void => {
  if (!generationConfig) return;

  if (generationConfig.maxOutputTokens !== undefined) {
    request.max_output_tokens = generationConfig.maxOutputTokens;
  }
  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }

  if (generationConfig.responseSchema !== undefined) {
    request.text = {
      format: {
        type: "json_schema",
        json_schema: {
          name: "gemini_response",
          schema: generationConfig.responseSchema,
        },
      },
    };
  } else if (generationConfig.responseMimeType === "application/json") {
    request.text = { format: { type: "json_object" } };
  }

  const effort = mapReasoningEffort(generationConfig.thinkingConfig);
  if (!effort) return;

  request.reasoning = {
    effort,
    ...(generationConfig.thinkingConfig?.includeThoughts === true
      ? { summary: "detailed" as const }
      : {}),
  };
};

const buildTools = (
  payload: GeminiGenerateContentRequest,
): ResponseTool[] | undefined => {
  const allowedFunctionNames = payload.toolConfig?.functionCallingConfig
    ?.allowedFunctionNames;
  const allowedNames = payload.toolConfig?.functionCallingConfig?.mode ===
        "ANY" && allowedFunctionNames?.length
    ? new Set(allowedFunctionNames)
    : null;
  const tools = payload.tools?.flatMap((toolGroup) =>
    toolGroup.functionDeclarations
      ?.filter((declaration) => allowedNames?.has(declaration.name) ?? true)
      .map((declaration) => ({
        type: "function" as const,
        name: declaration.name,
        ...(declaration.description !== undefined
          ? { description: declaration.description }
          : {}),
        parameters: declaration.parameters ??
          { type: "object", properties: {} },
        strict: false,
      })) ?? []
  );

  return tools?.length ? tools : undefined;
};

const mapToolChoice = (
  config?: GeminiFunctionCallingConfig,
): ResponseToolChoice | undefined => {
  switch (config?.mode) {
    case "NONE":
      return "none";
    case "AUTO":
    case "VALIDATED":
      return "auto";
    case "ANY":
      return config.allowedFunctionNames?.length === 1
        ? { type: "function", name: config.allowedFunctionNames[0] }
        : "required";
    default:
      return undefined;
  }
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentRequest,
  model: string,
  wantsStream: boolean,
): ResponsesPayload => {
  const request: ResponsesPayload = {
    model,
    stream: wantsStream,
    input: [],
  };
  const unmatchedToolCallIds: UnmatchedToolCallIds = {};

  const instructions = collectSystemText(payload.systemInstruction);
  if (instructions !== null) request.instructions = instructions;

  const input = request.input as ResponseInputItem[];
  payload.contents?.forEach((content, turnIndex) => {
    input.push(
      ...(content.role === "model"
        ? buildAssistantInputItems(content, turnIndex, unmatchedToolCallIds)
        : buildUserInputItems(content, turnIndex, unmatchedToolCallIds)),
    );
  });

  applyGenerationConfig(request, payload.generationConfig);

  const tools = buildTools(payload);
  if (tools) {
    request.tools = tools;

    const toolChoice = mapToolChoice(
      payload.toolConfig?.functionCallingConfig,
    );
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
  }

  return request;
};
