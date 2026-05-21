import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../shared/protocol/chat-completions.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame, type StreamFrame } from "../../shared/stream/types.ts";
import {
  type ChatCompletionsExchangeContext,
  type ChatCompletionsExchangeResult,
  runInterceptors,
} from "../../interceptors.ts";
import type { EmitInput } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  targetPerformanceContext,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { chatCompletionsStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForChatCompletions } from "./interceptors/index.ts";
import type { TelemetryModelIdentity } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export interface EmitToChatCompletionsInput
  extends EmitInput<ChatCompletionsPayload> {
  targetApi: "chat-completions";
}

const exchangeContextFromInput = (
  input: EmitToChatCompletionsInput,
): ChatCompletionsExchangeContext => ({
  sourceApi: input.sourceApi,
  targetApi: "chat-completions",
  model: input.model,
  upstream: input.upstream,
  upstreamModel: input.upstreamModel,
  provider: input.provider,
  enabledFixes: input.enabledFixes,
  payload: input.payload,
  ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
  ...(input.downstreamAbortSignal !== undefined
    ? { downstreamAbortSignal: input.downstreamAbortSignal }
    : {}),
});

export const emitToChatCompletions = async (
  input: EmitToChatCompletionsInput,
): Promise<ChatCompletionsExchangeResult> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  const ctx = exchangeContextFromInput(input);

  try {
    return await runInterceptors(
      ctx,
      interceptorsForChatCompletions(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = ctx.payload;
        const { response, modelKey } = await ctx.provider.callChatCompletions(
          ctx.upstreamModel,
          body,
          ctx.downstreamAbortSignal,
        );
        modelIdentity = {
          model: ctx.model,
          upstream: ctx.upstream,
          modelKey,
        };
        const perfContext = targetPerformanceContext(
          input,
          "chat-completions",
          modelIdentity,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(
            input,
            "chat-completions",
            modelIdentity,
          );
          return {
            ...(await readUpstreamError(response)),
            performance: perfContext,
          };
        }
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              ctx.sourceApi,
              "chat-completions",
            ),
            perfContext,
          );
        }

        const rawEvents: AsyncIterable<StreamFrame<ChatCompletionResponse>> =
          isSSEResponse(response)
            ? parseSSEStream(response.body, {
              signal: ctx.downstreamAbortSignal,
            })
            : (async function* () {
              yield jsonFrame(await response.json() as ChatCompletionResponse);
            })();

        return eventResult(
          chatCompletionsStreamFramesToEvents(withUpstreamTelemetry(
            rawEvents,
            input,
            "chat-completions",
            upstreamStartedAt,
            modelIdentity,
          )),
          modelIdentity,
          perfContext,
        );
      },
    );
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, ctx.sourceApi, "chat-completions"),
      modelIdentity
        ? targetPerformanceContext(input, "chat-completions", modelIdentity)
        : undefined,
    );
  }
};
