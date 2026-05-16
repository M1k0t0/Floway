import type { Context } from "hono";
import { copilotFetch, isCopilotTokenFetchError } from "../../lib/copilot.ts";
import type {
  GeminiCountTokensRequest,
  GeminiGenerateContentRequest,
} from "../../lib/gemini-types.ts";
import { toInternalDebugError } from "../llm/shared/errors/internal-debug-error.ts";
import { stripUnsupportedPartFieldsFromPayload } from "../llm/sources/gemini/interceptors/strip-unsupported-part-fields.ts";
import { stripUnsupportedToolsFromPayload } from "../llm/sources/gemini/interceptors/strip-unsupported-tools.ts";
import { geminiModelResolutionIntent } from "../llm/sources/gemini/plan.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../llm/translate/gemini-via-messages/build-target-request.ts";
import { getModelCapabilities } from "../llm/shared/models/get-model-capabilities.ts";
import { resolveModelForRequest } from "../llm/shared/models/resolve-model.ts";
import { withAccountFallback } from "../shared/account-pool/fallback.ts";

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 500:
      return "INTERNAL";
    case 502:
    case 503:
      return "UNAVAILABLE";
    default:
      return "INTERNAL";
  }
};

const geminiError = (status: number, message: string): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  return Response.json({
    error: { code, message, status: geminiStatusForHttpStatus(code) },
  }, { status: code });
};

const geminiInternalError = (status: number, error: unknown): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  const debug = toInternalDebugError(error, "gemini");
  return Response.json({
    error: {
      code,
      message: debug.message,
      status: geminiStatusForHttpStatus(code),
      type: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    },
  }, { status: code });
};

const countTokensRequestToGenerateContentRequest = (
  request: GeminiCountTokensRequest,
): GeminiGenerateContentRequest =>
  request.generateContentRequest ?? { contents: request.contents };

// count_tokens reuses Gemini source request normalization, but cannot run the
// full streaming source-interceptor pipeline. Apply the same payload mutations
// directly so its translated request shape matches `generateContent`.
const normalizeCountTokensRequest = (
  payload: GeminiGenerateContentRequest,
): void => {
  stripUnsupportedPartFieldsFromPayload(payload);
  stripUnsupportedToolsFromPayload(payload);
  delete payload.safetySettings;
};

const totalTokensFromUpstream = (value: unknown): number | null => {
  if (!value || typeof value !== "object") return null;
  const payload = value as { input_tokens?: unknown; total_tokens?: unknown };
  if (typeof payload.input_tokens === "number") return payload.input_tokens;
  if (typeof payload.total_tokens === "number") return payload.total_tokens;
  return null;
};

export const countGeminiTokens = async (
  c: Context,
  model: string,
): Promise<Response> => {
  try {
    const request = await c.req.json<GeminiCountTokensRequest>();
    const generateContentRequest = countTokensRequestToGenerateContentRequest(
      request,
    );
    normalizeCountTokensRequest(generateContentRequest);

    const modelId = await resolveModelForRequest(
      model,
      geminiModelResolutionIntent(generateContentRequest),
    );

    const response = await withAccountFallback(
      modelId,
      async ({ account }) => {
        const capabilities = await getModelCapabilities(
          modelId,
          account.token,
          account.accountType,
        );
        const messagesPayload = buildMessagesTargetRequest(
          generateContentRequest,
          modelId,
          false,
          capabilities,
        );
        return copilotFetch(
          "/v1/messages/count_tokens",
          { method: "POST", body: JSON.stringify(messagesPayload) },
          account.token,
          account.accountType,
        );
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return geminiError(
        response.status,
        body || "Upstream token counting request failed.",
      );
    }

    const parsed = await response.json() as unknown;
    const totalTokens = totalTokensFromUpstream(parsed);
    if (totalTokens === null) {
      return geminiInternalError(
        502,
        new Error("Invalid upstream token counting response."),
      );
    }

    return Response.json({ totalTokens });
  } catch (error) {
    if (isCopilotTokenFetchError(error)) {
      return geminiError(error.status, error.body);
    }

    return geminiInternalError(500, error);
  }
};
