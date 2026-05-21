import type {
  MessagesPayload,
  MessagesResponse,
} from "../../../shared/protocol/messages.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame, type StreamFrame } from "../../shared/stream/types.ts";
import {
  type MessagesExchangeContext,
  type MessagesExchangeResult,
  runInterceptors,
} from "../../interceptors.ts";
import type { EmitInput } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  targetPerformanceContext,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { messagesStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForMessages } from "./interceptors/index.ts";
import type { TelemetryModelIdentity } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export interface EmitToMessagesInput extends EmitInput<MessagesPayload> {
  targetApi: "messages";
  anthropicBeta?: readonly string[];
}

const exchangeContextFromInput = (
  input: EmitToMessagesInput,
): MessagesExchangeContext => ({
  sourceApi: input.sourceApi,
  targetApi: "messages",
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
  ...(input.anthropicBeta !== undefined
    ? { anthropicBeta: input.anthropicBeta }
    : {}),
});

export const emitToMessages = async (
  input: EmitToMessagesInput,
): Promise<MessagesExchangeResult> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  const ctx = exchangeContextFromInput(input);

  try {
    ctx.payload.stream = true;

    return await runInterceptors(
      ctx,
      interceptorsForMessages(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = ctx.payload;
        const { response, modelKey } = await ctx.provider.callMessages(
          ctx.upstreamModel,
          body,
          ctx.downstreamAbortSignal,
          ctx.anthropicBeta,
        );
        modelIdentity = {
          model: ctx.model,
          upstream: ctx.upstream,
          modelKey,
        };
        const perfContext = targetPerformanceContext(
          input,
          "messages",
          modelIdentity,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "messages", modelIdentity);
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
              "messages",
            ),
            perfContext,
          );
        }

        const rawEvents: AsyncIterable<StreamFrame<MessagesResponse>> =
          isSSEResponse(response)
            ? parseSSEStream(response.body, {
              signal: ctx.downstreamAbortSignal,
            })
            : (async function* () {
              yield jsonFrame(await response.json() as MessagesResponse);
            })();

        return eventResult(
          messagesStreamFramesToEvents(withUpstreamTelemetry(
            rawEvents,
            input,
            "messages",
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
      toInternalDebugError(error, ctx.sourceApi, "messages"),
      modelIdentity
        ? targetPerformanceContext(input, "messages", modelIdentity)
        : undefined,
    );
  }
};
