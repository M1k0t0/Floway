import type { Context } from "hono";
import type {
  GeminiGenerateContentRequest,
  GeminiStreamEvent,
} from "../../../shared/protocol/gemini.ts";
import { backgroundSchedulerFromContext } from "../../../../runtime/background.ts";
import {
  type PerformanceTelemetryContext,
  recordRequestPerformanceForApiKey,
  runtimeLocationFromRequest,
} from "../../../shared/telemetry/performance.ts";
import { geminiSourceInterceptors } from "./interceptors/index.ts";
import {
  type GeminiExchangeContext,
  type GeminiInterceptor,
  type LlmTargetApi,
  runInterceptors,
} from "../../interceptors.ts";
import { respondGemini } from "./respond.ts";
import { planGeminiRequest } from "./plan.ts";
import { getModelCapabilities } from "../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../providers/run.ts";
import { modelLoadErrorResult } from "../../shared/errors/model-load-error.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/gemini-via-messages/request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/gemini-via-responses/request.ts";
import { buildTargetRequest as buildChatCompletionsTargetRequest } from "../../translate/gemini-via-chat-completions/request.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/gemini-via-messages/events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/gemini-via-responses/events.ts";
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from "../../translate/gemini-via-chat-completions/events.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
  type UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { thrownUpstreamErrorResult } from "../../shared/errors/upstream-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { countGeminiTokens } from "./count-tokens/serve.ts";
import { recordUsageForApiKey } from "../../../shared/telemetry/usage.ts";
import type { ModelProviderBinding } from "../../../providers/types.ts";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): StreamExecuteResult<GeminiStreamEvent> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

const unsupportedGeminiModelResult = (
  model: string,
  performance?: PerformanceTelemetryContext,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      code: 400,
      message:
        `Model ${model} does not support the Gemini generateContent endpoint.`,
      status: "INVALID_ARGUMENT",
    },
  })),
  ...(performance ? { performance } : {}),
});

const geminiSourceInterceptorsForProvider = (
  binding: ModelProviderBinding,
): readonly GeminiInterceptor[] => [
  ...geminiSourceInterceptors,
  ...(binding.sourceInterceptors?.gemini ?? []),
];

const geminiExchangeContext = (
  binding: ModelProviderBinding,
  targetApi: LlmTargetApi,
  model: string,
  payload: GeminiGenerateContentRequest,
  apiKeyId: string | undefined,
  downstreamAbortSignal: AbortSignal | undefined,
): GeminiExchangeContext => ({
  sourceApi: "gemini",
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  payload,
  ...(apiKeyId !== undefined ? { apiKeyId } : {}),
  ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
});

export const serveGemini = async (
  c: Context,
  model: string,
  wantsStream: boolean,
): Promise<Response> => {
  const requestStartedAt = performance.now();
  const apiKeyId = c.get("apiKeyId") as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  const recordUsage = recordUsageForApiKey(apiKeyId);
  const recordRequestPerformance = recordRequestPerformanceForApiKey(
    apiKeyId,
    scheduleBackground,
  );
  let lastPerformance: PerformanceTelemetryContext | undefined;
  let downstreamAbortController: AbortController | undefined;
  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();

    downstreamAbortController = wantsStream ? new AbortController() : undefined;

    const result = await (async () => {
      const { id: modelId, model: resolvedModel } =
        await resolveModelForRequest(model);

      if (!resolvedModel) {
        return {
          type: "upstream-error" as const,
          status: 404,
          headers: new Headers({ "content-type": "application/json" }),
          body: new TextEncoder().encode(JSON.stringify({
            error: {
              code: 404,
              message:
                `Model ${modelId} is not available on any configured upstream.`,
              status: "NOT_FOUND",
            },
          })),
        };
      }

      return await runOnModel(
        resolvedModel,
        async (binding) => {
          const attemptPayload = structuredClone(payload);
          const capabilities = getModelCapabilities(binding.upstreamModel);
          const plan = planGeminiRequest(capabilities);
          if (!plan) {
            return skipProvider(
              unsupportedGeminiModelResult(modelId),
            );
          }

          const sourceCtx = geminiExchangeContext(
            binding,
            plan.target,
            modelId,
            attemptPayload,
            apiKeyId,
            downstreamAbortController?.signal,
          );

          return await runInterceptors(
            sourceCtx,
            geminiSourceInterceptorsForProvider(binding),
            async () => {
              const payload = sourceCtx.payload;

              if (plan.target === "messages") {
                const targetPayload = buildMessagesTargetRequest(
                  payload,
                  modelId,
                  wantsStream,
                  capabilities,
                );
                const result = await emitToMessages({
                  sourceApi: "gemini",
                  targetApi: "messages",
                  model: modelId,
                  upstream: binding.upstream,
                  payload: targetPayload,
                  provider: binding.provider,
                  upstreamModel: binding.upstreamModel,
                  enabledFixes: binding.enabledFixes,
                  targetInterceptors: binding.targetInterceptors,
                  apiKeyId,
                  clientStream: wantsStream,
                  runtimeLocation,
                  scheduleBackground,
                  downstreamAbortSignal: downstreamAbortController?.signal,
                });

                if (result.performance) lastPerformance = result.performance;
                return withTranslatedEvents(
                  result,
                  translateMessagesToSourceEvents,
                );
              }

              if (plan.target === "responses") {
                const targetPayload = buildResponsesTargetRequest(
                  payload,
                  modelId,
                  wantsStream,
                );
                const result = await emitToResponses({
                  sourceApi: "gemini",
                  targetApi: "responses",
                  model: modelId,
                  upstream: binding.upstream,
                  payload: targetPayload,
                  provider: binding.provider,
                  upstreamModel: binding.upstreamModel,
                  enabledFixes: binding.enabledFixes,
                  targetInterceptors: binding.targetInterceptors,
                  apiKeyId,
                  clientStream: wantsStream,
                  runtimeLocation,
                  scheduleBackground,
                  downstreamAbortSignal: downstreamAbortController?.signal,
                });

                if (result.performance) lastPerformance = result.performance;
                return withTranslatedEvents(
                  result,
                  translateResponsesToSourceEvents,
                );
              }

              const targetPayload = buildChatCompletionsTargetRequest(
                payload,
                modelId,
                wantsStream,
              );
              const result = await emitToChatCompletions({
                sourceApi: "gemini",
                targetApi: "chat-completions",
                model: modelId,
                upstream: binding.upstream,
                payload: targetPayload,
                provider: binding.provider,
                upstreamModel: binding.upstreamModel,
                enabledFixes: binding.enabledFixes,
                targetInterceptors: binding.targetInterceptors,
                apiKeyId,
                clientStream: wantsStream,
                runtimeLocation,
                scheduleBackground,
                downstreamAbortSignal: downstreamAbortController?.signal,
              });

              if (result.performance) lastPerformance = result.performance;
              return withTranslatedEvents(
                result,
                translateChatCompletionsToSourceEvents,
              );
            },
          );
        },
      );
    })();

    return await respondGemini(
      c,
      result,
      wantsStream,
      recordUsage,
      recordRequestPerformance,
      requestStartedAt,
      downstreamAbortController,
    );
  } catch (error) {
    try {
      const modelError = modelLoadErrorResult(error, lastPerformance);
      return await respondGemini(
        c,
        modelError,
        false,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    } catch {
      // Not a model-load error; continue with normal request-boundary handling.
    }

    const upstreamError = thrownUpstreamErrorResult(error, lastPerformance);
    if (upstreamError) {
      return await respondGemini(
        c,
        upstreamError,
        false,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    }

    return await respondGemini(
      c,
      internalErrorResult(
        500,
        toInternalDebugError(error, "gemini"),
        lastPerformance,
      ),
      false,
      recordUsage,
      recordRequestPerformance,
      requestStartedAt,
      downstreamAbortController,
    );
  }
};

const geminiRpcError = (
  code: number,
  status: string,
  message: string,
): Response =>
  Response.json({ error: { code, message, status } }, { status: code });

export const serveGeminiPost = async (c: Context): Promise<Response> => {
  const modelAction = c.req.param("modelAction");
  if (!modelAction) {
    return geminiRpcError(404, "NOT_FOUND", "Missing Gemini model action.");
  }

  const separator = modelAction.lastIndexOf(":");
  if (separator <= 0 || separator === modelAction.length - 1) {
    return geminiRpcError(
      404,
      "NOT_FOUND",
      `Unknown Gemini model action: ${modelAction}`,
    );
  }

  const model = modelAction.slice(0, separator);
  const action = modelAction.slice(separator + 1);

  switch (action) {
    case "generateContent":
      return await serveGemini(c, model, false);
    case "streamGenerateContent":
      return await serveGemini(c, model, true);
    case "countTokens":
      return await countGeminiTokens(c, model);
    default:
      return geminiRpcError(
        404,
        "NOT_FOUND",
        `Unknown Gemini model action: ${action}`,
      );
  }
};
