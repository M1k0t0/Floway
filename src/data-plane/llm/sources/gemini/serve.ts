import type { Context } from "hono";
import type {
  GeminiGenerateContentRequest,
  GeminiStreamEvent,
} from "../../../../lib/gemini-types.ts";
import { backgroundSchedulerFromContext } from "../../../../lib/background.ts";
import {
  type PerformanceTelemetryContext,
  runtimeLocationFromRequest,
} from "../../../../lib/performance-telemetry.ts";
import {
  type GeminiSourceContext,
  geminiSourceInterceptors,
} from "./interceptors/index.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";
import { respondGemini } from "./respond.ts";
import { geminiModelResolutionIntent, planGeminiRequest } from "./plan.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { resolveModelForRequest } from "../../shared/models/resolve-model.ts";
import { withAccountFallback } from "../../../shared/account-pool/fallback.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/gemini-via-messages/build-target-request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/gemini-via-responses/build-target-request.ts";
import { buildTargetRequest as buildChatCompletionsTargetRequest } from "../../translate/gemini-via-chat-completions/build-target-request.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/gemini-via-messages/translate-to-source-events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/gemini-via-responses/translate-to-source-events.ts";
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from "../../translate/gemini-via-chat-completions/translate-to-source-events.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { countGeminiTokens } from "../../../gemini/count-tokens.ts";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): StreamExecuteResult<GeminiStreamEvent> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

const withResultMetadata = <T>(
  result: StreamExecuteResult<T>,
  usageModel: string,
  performance: PerformanceTelemetryContext,
): StreamExecuteResult<T> =>
  result.type === "events"
    ? { ...result, usageModel, performance }
    : { ...result, performance };

export const serveGemini = async (
  c: Context,
  model: string,
  wantsStream: boolean,
): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  let downstreamAbortController: AbortController | undefined;
  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
    const scheduleBackground = backgroundSchedulerFromContext(c);
    const ctx: GeminiSourceContext = { payload, apiKeyId };
    const performanceFor = (
      usageModel: string,
      targetApi: PerformanceTelemetryContext["targetApi"],
    ): PerformanceTelemetryContext => {
      lastPerformance = {
        keyId: apiKeyId ?? "unknown",
        model: usageModel,
        sourceApi: "gemini",
        targetApi,
        stream: wantsStream,
        runtimeLocation,
      };
      return lastPerformance;
    };

    const result = await runSourceInterceptors(
      ctx,
      geminiSourceInterceptors,
      async () => {
        const modelId = await resolveModelForRequest(
          model,
          geminiModelResolutionIntent(ctx.payload),
        );
        performanceFor(modelId, "gemini");

        return await withAccountFallback(modelId, async ({ account }) => {
          const attemptPayload = structuredClone(ctx.payload);
          const capabilities = await getModelCapabilities(
            modelId,
            account.token,
            account.accountType,
          );
          const plan = planGeminiRequest(
            attemptPayload,
            modelId,
            capabilities,
            wantsStream,
          );

          if (plan.target === "messages") {
            const targetPayload = buildMessagesTargetRequest(
              attemptPayload,
              modelId,
              wantsStream,
              capabilities,
            );
            const performance = performanceFor(
              targetPayload.model,
              "messages",
            );
            const result = await emitToMessages({
              sourceApi: "gemini",
              payload: targetPayload,
              githubToken: account.token,
              accountType: account.accountType,
              apiKeyId,
              clientStream: wantsStream,
              runtimeLocation,
              scheduleBackground,
              fetchOptions: plan.fetchOptions,
              downstreamAbortSignal: downstreamAbortController?.signal,
            });

            return withResultMetadata(
              withTranslatedEvents(result, translateMessagesToSourceEvents),
              targetPayload.model,
              performance,
            );
          }

          if (plan.target === "responses") {
            const targetPayload = buildResponsesTargetRequest(
              attemptPayload,
              modelId,
              wantsStream,
            );
            const performance = performanceFor(
              targetPayload.model,
              "responses",
            );
            const result = await emitToResponses({
              sourceApi: "gemini",
              payload: targetPayload,
              githubToken: account.token,
              accountType: account.accountType,
              apiKeyId,
              clientStream: wantsStream,
              runtimeLocation,
              scheduleBackground,
              fetchOptions: plan.fetchOptions,
              downstreamAbortSignal: downstreamAbortController?.signal,
            });

            return withResultMetadata(
              withTranslatedEvents(result, translateResponsesToSourceEvents),
              targetPayload.model,
              performance,
            );
          }

          const targetPayload = buildChatCompletionsTargetRequest(
            attemptPayload,
            modelId,
            wantsStream,
          );
          const performance = performanceFor(
            targetPayload.model,
            "chat-completions",
          );
          const result = await emitToChatCompletions({
            sourceApi: "gemini",
            payload: targetPayload,
            githubToken: account.token,
            accountType: account.accountType,
            apiKeyId,
            clientStream: wantsStream,
            runtimeLocation,
            scheduleBackground,
            fetchOptions: plan.fetchOptions,
            downstreamAbortSignal: downstreamAbortController?.signal,
          });

          return withResultMetadata(
            withTranslatedEvents(
              result,
              translateChatCompletionsToSourceEvents,
            ),
            targetPayload.model,
            performance,
          );
        });
      },
    );

    return await respondGemini(
      c,
      result,
      wantsStream,
      downstreamAbortController,
    );
  } catch (error) {
    return await respondGemini(
      c,
      internalErrorResult(
        500,
        toInternalDebugError(error, "gemini"),
        lastPerformance,
      ),
      false,
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
