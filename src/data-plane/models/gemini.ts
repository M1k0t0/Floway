import type { Context } from "hono";
import { isCopilotTokenFetchError } from "../../shared/copilot.ts";
import { type ModelInfo, ModelsFetchError } from "./cache.ts";
import { loadMergedModels } from "./load.ts";

interface GeminiModel {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: Array<
    "generateContent" | "streamGenerateContent" | "countTokens"
  >;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
}

const LLM_ENDPOINTS = new Set([
  "/v1/messages",
  "/responses",
  "/chat/completions",
]);

const supportsLlmGeneration = (model: ModelInfo): boolean =>
  model.supported_endpoints?.some((endpoint) => LLM_ENDPOINTS.has(endpoint)) ===
    true;

const displayNameForModel = (model: ModelInfo): string =>
  model.name || model.id;

const inputLimitForModel = (model: ModelInfo): number | undefined => {
  const limits = model.capabilities?.limits;
  return limits?.max_prompt_tokens ?? limits?.max_context_window_tokens;
};

const outputLimitForModel = (model: ModelInfo): number | undefined =>
  model.capabilities?.limits?.max_output_tokens ??
    model.capabilities?.limits?.max_non_streaming_output_tokens;

const toGeminiModel = (model: ModelInfo): GeminiModel => ({
  name: `models/${model.id}`,
  baseModelId: model.id,
  displayName: displayNameForModel(model),
  supportedGenerationMethods: [
    "generateContent",
    "streamGenerateContent",
    "countTokens",
  ],
  ...(inputLimitForModel(model) !== undefined
    ? { inputTokenLimit: inputLimitForModel(model) }
    : {}),
  ...(outputLimitForModel(model) !== undefined
    ? { outputTokenLimit: outputLimitForModel(model) }
    : {}),
  temperature: 1,
  topP: 0.95,
  topK: 40,
});

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 502:
    case 503:
      return "UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT";
  }
};

const geminiError = (status: number, message: string): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  return Response.json({
    error: { code, message, status: geminiStatusForHttpStatus(code) },
  }, { status: code });
};

const geminiModelLoadError = (error: unknown): Response => {
  if (error instanceof ModelsFetchError) {
    return geminiError(error.status, error.body);
  }

  if (isCopilotTokenFetchError(error)) {
    return geminiError(error.status, error.body);
  }

  return geminiError(
    502,
    error instanceof Error ? error.message : String(error),
  );
};

const loadGeminiModels = async (): Promise<GeminiModel[]> => {
  const models = await loadMergedModels();
  return models.data.filter(supportsLlmGeneration).map(toGeminiModel);
};

export const serveGeminiModels = async (_c: Context): Promise<Response> => {
  try {
    return Response.json({ models: await loadGeminiModels() });
  } catch (error) {
    return geminiModelLoadError(error);
  }
};

export const serveGeminiModelInfo = async (
  c: Context,
): Promise<Response> => {
  const rawModelId = c.req.param("modelId");
  if (!rawModelId) return geminiError(404, "Model not found: ");

  const modelId = rawModelId.replace(/^models\//, "");
  try {
    const model = (await loadGeminiModels()).find((candidate) =>
      candidate.baseModelId === modelId ||
      candidate.name === `models/${modelId}`
    );
    if (!model) return geminiError(404, `Model not found: ${modelId}`);
    return Response.json(model);
  } catch (error) {
    return geminiModelLoadError(error);
  }
};
