import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../shared/protocol/responses.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame, type StreamFrame } from "../../shared/stream/types.ts";
import {
  type ResponsesExchangeContext,
  type ResponsesExchangeResult,
  runInterceptors,
} from "../../interceptors.ts";
import type { EmitInput } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  targetPerformanceContext,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { responsesStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForResponses } from "./interceptors/index.ts";
import type { TelemetryModelIdentity } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export interface EmitToResponsesInput extends EmitInput<ResponsesPayload> {
  targetApi: "responses";
}

const exchangeContextFromInput = (
  input: EmitToResponsesInput,
): ResponsesExchangeContext => ({
  sourceApi: input.sourceApi,
  targetApi: "responses",
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

export const emitToResponses = async (
  input: EmitToResponsesInput,
): Promise<ResponsesExchangeResult> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  const ctx = exchangeContextFromInput(input);

  try {
    ctx.payload.stream = true;

    return await runInterceptors(
      ctx,
      interceptorsForResponses(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = ctx.payload;
        const { response, modelKey } = await ctx.provider.callResponses(
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
          "responses",
          modelIdentity,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "responses", modelIdentity);
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
              "responses",
            ),
            perfContext,
          );
        }

        const rawEvents: AsyncIterable<StreamFrame<ResponsesResult>> =
          isSSEResponse(response)
            ? parseSSEStream(response.body, {
              signal: ctx.downstreamAbortSignal,
            })
            : (async function* () {
              yield jsonFrame(await response.json() as ResponsesResult);
            })();

        return eventResult(
          responsesStreamFramesToEvents(withUpstreamTelemetry(
            rawEvents,
            input,
            "responses",
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
      toInternalDebugError(error, ctx.sourceApi, "responses"),
      modelIdentity
        ? targetPerformanceContext(input, "responses", modelIdentity)
        : undefined,
    );
  }
};
