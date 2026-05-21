import type { Context } from "hono";
import type { ResponsesPayload } from "../../../shared/protocol/responses.ts";
import { responsesSourceInterceptors } from "./interceptors/index.ts";
import {
  type LlmTargetApi,
  type ResponsesExchangeContext,
  type ResponsesInterceptor,
  runInterceptors,
} from "../../interceptors.ts";
import { planResponsesRequest } from "./plan.ts";
import { getModelCapabilities } from "../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../providers/run.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/responses-via-messages/request.ts";
import { buildTargetRequest as buildChatCompletionsTargetRequest } from "../../translate/responses-via-chat-completions/request.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { translateToSourceEvents } from "../../translate/responses-via-messages/events.ts";
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from "../../translate/responses-via-chat-completions/events.ts";
import { respondResponses } from "./respond.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
  type UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { thrownUpstreamErrorResult } from "../../shared/errors/upstream-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import type { ResponsesStreamEvent } from "../../shared/protocol/responses.ts";
import { modelLoadErrorResult } from "../../shared/errors/model-load-error.ts";
import {
  type PerformanceTelemetryContext,
  recordRequestPerformanceForApiKey,
  runtimeLocationFromRequest,
} from "../../../shared/telemetry/performance.ts";
import { backgroundSchedulerFromContext } from "../../../../runtime/background.ts";
import { recordUsageForApiKey } from "../../../shared/telemetry/usage.ts";
import type { ModelProviderBinding } from "../../../providers/types.ts";

const CODEX_AUTO_REVIEW_ALIAS = "codex-auto-review";
const CODEX_AUTO_REVIEW_TARGET = "gpt-5.4";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): StreamExecuteResult<ResponsesStreamEvent> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

type UnsupportedStatefulContinuationField =
  | "previous_response_id"
  | "item_reference";

const isItemReferenceInput = (item: unknown): boolean =>
  typeof item === "object" && item !== null &&
  (item as { type?: unknown }).type === "item_reference";

const unsupportedStatefulContinuationField = (
  payload: ResponsesPayload,
): UnsupportedStatefulContinuationField | undefined => {
  if (
    payload.previous_response_id !== undefined &&
    payload.previous_response_id !== null
  ) {
    return "previous_response_id";
  }
  if (
    Array.isArray(payload.input) && payload.input.some(isItemReferenceInput)
  ) {
    return "item_reference";
  }
  return undefined;
};

const unsupportedStatefulContinuationResponse = (
  field: UnsupportedStatefulContinuationField,
): Response =>
  Response.json({
    error: {
      message:
        `Responses API ${field} is not supported by this gateway. Send the full input instead of using server-side conversation state references.`,
      type: "invalid_request_error",
      param: field,
    },
  }, { status: 400 });

const unsupportedResponsesModelResult = (
  model: string,
  performance?: PerformanceTelemetryContext,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      message: `Model ${model} does not support the /responses endpoint.`,
      type: "invalid_request_error",
    },
  })),
  ...(performance ? { performance } : {}),
});

const responsesSourceInterceptorsForProvider = (
  binding: ModelProviderBinding,
): readonly ResponsesInterceptor[] => [
  ...responsesSourceInterceptors,
  ...(binding.sourceInterceptors?.responses ?? []),
];

const responsesExchangeContext = (
  binding: ModelProviderBinding,
  targetApi: LlmTargetApi,
  model: string,
  payload: ResponsesPayload,
  apiKeyId: string | undefined,
  downstreamAbortSignal: AbortSignal | undefined,
): ResponsesExchangeContext => ({
  sourceApi: "responses",
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

const createTranslatedResponseId = (): string =>
  `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

const rewriteResponsesEntryModelAlias = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;

  // TODO: Replace this source-entry hardcode with generic model alias support.
  // Codex sends auto-review requests over the Responses wire API, so rewriting
  // here keeps downstream routing, performance telemetry, and usage telemetry
  // on the real model name.
  // References:
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/model-provider/src/provider.rs#L73-L96
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/codex-api/src/endpoint/responses.rs#L102-L134
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: "low" },
  };
};

export const serveResponses = async (
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
    const payload = rewriteResponsesEntryModelAlias(
      await c.req.json<ResponsesPayload>(),
    );
    // previous_response_id and item_reference require stateful server-side
    // continuation. We cannot reliably preserve that semantic across provider
    // fallback and translated targets, so reject it at the Responses
    // source boundary and make clients resend the full input instead.
    const unsupportedField = unsupportedStatefulContinuationField(payload);
    if (unsupportedField) {
      return unsupportedStatefulContinuationResponse(unsupportedField);
    }
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;

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
          const plan = planResponsesRequest(capabilities);
          if (!plan) {
            return skipProvider(unsupportedResponsesModelResult(
              attemptPayload.model,
            ));
          }

          const sourceCtx = responsesExchangeContext(
            binding,
            plan.target,
            modelId,
            attemptPayload,
            apiKeyId,
            downstreamAbortController?.signal,
          );

          return await runInterceptors(
            sourceCtx,
            responsesSourceInterceptorsForProvider(binding),
            async () => {
              const payload = sourceCtx.payload;

              if (plan.target === "responses") {
                const result = await emitToResponses({
                  sourceApi: "responses",
                  targetApi: "responses",
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
              }

              if (plan.target === "messages") {
                const messagesPayload = await buildMessagesTargetRequest(
                  payload,
                  capabilities,
                );
                const result = await emitToMessages({
                  sourceApi: "responses",
                  targetApi: "messages",
                  model: modelId,
                  upstream: binding.upstream,
                  payload: messagesPayload,
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
                  (events) =>
                    translateToSourceEvents(
                      events,
                      createTranslatedResponseId(),
                      messagesPayload.model,
                    ),
                );
              }

              const chatPayload = buildChatCompletionsTargetRequest(
                payload,
              );
              const result = await emitToChatCompletions({
                sourceApi: "responses",
                targetApi: "chat-completions",
                model: modelId,
                upstream: binding.upstream,
                payload: chatPayload,
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

    return await respondResponses(
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
      return await respondResponses(
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
      return await respondResponses(
        c,
        upstreamError,
        false,
        recordUsage,
        recordRequestPerformance,
        requestStartedAt,
        downstreamAbortController,
      );
    }

    return await respondResponses(
      c,
      internalErrorResult(
        502,
        toInternalDebugError(error, "responses"),
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
