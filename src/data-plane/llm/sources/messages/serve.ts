import type { Context } from "hono";
import type { MessagesPayload } from "../../../shared/protocol/messages.ts";
import { messagesSourceInterceptors } from "./interceptors/index.ts";
import {
  type LlmTargetApi,
  type MessagesExchangeContext,
  type MessagesInterceptor,
  runInterceptors,
} from "../../interceptors.ts";
import { planMessagesRequest } from "./plan.ts";
import { getModelCapabilities } from "../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../providers/run.ts";
import { buildTargetRequest as buildChatTargetRequest } from "../../translate/messages-via-chat-completions/request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/messages-via-responses/request.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/messages-via-responses/events.ts";
import { translateToSourceEvents as translateChatToSourceEvents } from "../../translate/messages-via-chat-completions/events.ts";
import { respondMessages } from "./respond.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
  type UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { thrownUpstreamErrorResult } from "../../shared/errors/upstream-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { modelLoadErrorResult } from "../../shared/errors/model-load-error.ts";
import {
  type PerformanceTelemetryContext,
  recordRequestPerformanceForApiKey,
  runtimeLocationFromRequest,
} from "../../../shared/telemetry/performance.ts";
import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import type { ModelProviderBinding } from "../../../providers/types.ts";
import { backgroundSchedulerFromContext } from "../../../../runtime/background.ts";
import { recordUsageForApiKey } from "../../../shared/telemetry/usage.ts";

const parseAnthropicBeta = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  const values = raw.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
};

const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, "anthropic_beta")) return "anthropic_beta";
  if (Object.hasOwn(record, "betas")) return "betas";
  return undefined;
};

const bodyAnthropicBetaResponse = (param: string): Response =>
  Response.json({
    error: {
      message:
        `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
      type: "invalid_request_error",
      param,
    },
  }, { status: 400 });

const unsupportedMessagesModelResult = (
  model: string,
  performance?: PerformanceTelemetryContext,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      message: `Model ${model} does not support the /messages endpoint.`,
      type: "invalid_request_error",
    },
  })),
  ...(performance ? { performance } : {}),
});

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
): StreamExecuteResult<MessagesStreamEventData> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

const messagesSourceInterceptorsForProvider = (
  binding: ModelProviderBinding,
): readonly MessagesInterceptor[] => [
  ...messagesSourceInterceptors,
  ...(binding.sourceInterceptors?.messages ?? []),
];

const messagesExchangeContext = (
  binding: ModelProviderBinding,
  targetApi: LlmTargetApi,
  model: string,
  payload: MessagesPayload,
  apiKeyId: string | undefined,
  downstreamAbortSignal: AbortSignal | undefined,
  anthropicBeta: readonly string[] | undefined,
): MessagesExchangeContext => ({
  sourceApi: "messages",
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  payload,
  ...(apiKeyId !== undefined ? { apiKeyId } : {}),
  ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

export const serveMessages = async (
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
  let downstreamAbortController: AbortController | undefined;
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const anthropicBeta = parseAnthropicBeta(c.req.header("anthropic-beta"));

    const result = await (async () => {
      const { id: modelId, model } = await resolveModelForRequest(
        payload.model,
      );

      if (!model) {
        return {
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
      }

      return await runOnModel(
        model,
        async (binding) => {
          const attemptPayload = structuredClone(payload);
          attemptPayload.model = modelId;
          const capabilities = getModelCapabilities(binding.upstreamModel);
          const plan = planMessagesRequest(capabilities);
          if (!plan) {
            return skipProvider(unsupportedMessagesModelResult(
              attemptPayload.model,
            ));
          }

          const sourceCtx = messagesExchangeContext(
            binding,
            plan.target,
            modelId,
            attemptPayload,
            apiKeyId,
            downstreamAbortController?.signal,
            anthropicBeta,
          );

          return await runInterceptors(
            sourceCtx,
            messagesSourceInterceptorsForProvider(binding),
            async () => {
              const payload = sourceCtx.payload;

              if (plan.target === "messages") {
                const result = await emitToMessages({
                  sourceApi: "messages",
                  targetApi: "messages",
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
                  anthropicBeta,
                });
                if (result.performance) lastPerformance = result.performance;
                return result;
              }

              if (plan.target === "responses") {
                const targetPayload = buildResponsesTargetRequest(payload);
                const result = await emitToResponses({
                  sourceApi: "messages",
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

              const targetPayload = buildChatTargetRequest(payload);
              const result = await emitToChatCompletions({
                sourceApi: "messages",
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
                translateChatToSourceEvents,
              );
            },
          );
        },
      );
    })();

    return await respondMessages(
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
      return await respondMessages(
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
      return await respondMessages(
        c,
        upstreamError,
        false,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    }

    return await respondMessages(
      c,
      internalErrorResult(
        502,
        toInternalDebugError(error, "messages"),
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
