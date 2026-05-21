import type { Context } from "hono";
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "../../../shared/protocol/chat-completions.ts";
import { planChatRequest } from "./plan.ts";
import { getModelCapabilities } from "../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../providers/run.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/chat-completions-via-messages/request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/chat-completions-via-responses/request.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/chat-completions-via-messages/events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/chat-completions-via-responses/events.ts";
import { respondChatCompletions } from "./respond.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
  type UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { thrownUpstreamErrorResult } from "../../shared/errors/upstream-error.ts";
import { modelLoadErrorResult } from "../../shared/errors/model-load-error.ts";
import {
  type PerformanceTelemetryContext,
  recordRequestPerformanceForApiKey,
  runtimeLocationFromRequest,
} from "../../../shared/telemetry/performance.ts";
import { backgroundSchedulerFromContext } from "../../../../runtime/background.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { recordUsageForApiKey } from "../../../shared/telemetry/usage.ts";
import {
  type ChatCompletionsExchangeContext,
  type ChatCompletionsInterceptor,
  type LlmTargetApi,
  runInterceptors,
} from "../../interceptors.ts";
import type { ModelProviderBinding } from "../../../providers/types.ts";

const unsupportedChatModelResult = (
  model: string,
  performance?: PerformanceTelemetryContext,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      message:
        `Model ${model} does not support the /chat/completions endpoint.`,
      type: "invalid_request_error",
    },
  })),
  ...(performance ? { performance } : {}),
});

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
): StreamExecuteResult<ChatCompletionChunk> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

const chatSourceInterceptorsForProvider = (
  binding: ModelProviderBinding,
): readonly ChatCompletionsInterceptor[] =>
  binding.sourceInterceptors?.chatCompletions ?? [];

const chatExchangeContext = (
  binding: ModelProviderBinding,
  targetApi: LlmTargetApi,
  model: string,
  payload: ChatCompletionsPayload,
  apiKeyId: string | undefined,
  downstreamAbortSignal: AbortSignal | undefined,
): ChatCompletionsExchangeContext => ({
  sourceApi: "chat-completions",
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

export const serveChatCompletions = async (
  c: Context,
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
  // Target interceptors may force upstream usage for gateway telemetry, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;
  let downstreamAbortController: AbortController | undefined;
  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;

    const { id: modelId, model } = await resolveModelForRequest(payload.model);

    if (!model) {
      const result = {
        type: "upstream-error" as const,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(JSON.stringify({
          error: {
            message:
              `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`,
            type: "invalid_request_error",
          },
        })),
      };
      return await respondChatCompletions(
        c,
        result,
        wantsStream,
        includeUsageChunk,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    }

    const result = await runOnModel(
      model,
      async (binding) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = modelId;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const plan = planChatRequest(capabilities);
        if (!plan) {
          return skipProvider(unsupportedChatModelResult(
            attemptPayload.model,
          ));
        }

        const sourceCtx = chatExchangeContext(
          binding,
          plan.target,
          modelId,
          attemptPayload,
          apiKeyId,
          downstreamAbortController?.signal,
        );

        return await runInterceptors(
          sourceCtx,
          chatSourceInterceptorsForProvider(binding),
          async () => {
            const payload = sourceCtx.payload;

            if (plan.target === "messages") {
              const targetPayload = await buildMessagesTargetRequest(
                payload,
                capabilities,
              );
              const result = await emitToMessages({
                sourceApi: "chat-completions",
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
              const targetPayload = buildResponsesTargetRequest(payload);
              const result = await emitToResponses({
                sourceApi: "chat-completions",
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

            const result = await emitToChatCompletions({
              sourceApi: "chat-completions",
              targetApi: "chat-completions",
              model: modelId,
              upstream: binding.upstream,
              payload,
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
            return result;
          },
        );
      },
    );

    return await respondChatCompletions(
      c,
      result,
      wantsStream,
      includeUsageChunk,
      recordUsage,
      recordRequestPerformance,
      requestStartedAt,
      downstreamAbortController,
    );
  } catch (error) {
    try {
      const modelError = modelLoadErrorResult(error, lastPerformance);
      return await respondChatCompletions(
        c,
        modelError,
        false,
        includeUsageChunk,
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
      return await respondChatCompletions(
        c,
        upstreamError,
        false,
        includeUsageChunk,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    }

    return await respondChatCompletions(
      c,
      internalErrorResult(
        502,
        toInternalDebugError(error, "chat-completions"),
        lastPerformance,
      ),
      false,
      includeUsageChunk,
      recordUsage,
      recordRequestPerformance,
      requestStartedAt,
      downstreamAbortController,
    );
  }
};
