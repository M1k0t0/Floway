import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import { collectResponsesProtocolEventsToResult } from "./events/reassemble.ts";
import { responsesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { ResponsesStreamEvent } from "../../shared/protocol/responses.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import {
  type ProtocolFrame,
  sseCommentFrame,
  sseFrame,
} from "../../shared/stream/types.ts";
import {
  type RecordRequestPerformance,
} from "../../../shared/telemetry/performance.ts";
import {
  type RecordUsage,
  recordUsageIfPresent,
} from "../../../shared/telemetry/usage.ts";
import {
  type SourceStreamOutcome,
  trackSourceStreamOutcome,
} from "../telemetry.ts";
import { tokenUsageFromResponsesResult } from "./usage.ts";

const internalResponsesErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    source_api: error.source_api,
    target_api: error.target_api,
  },
});

const downstreamSSECommentKeepAliveFrame = sseCommentFrame("keepalive");

const internalResponsesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalResponsesErrorPayload(error), { status });

const internalResponsesStreamErrorFrame = (error: unknown) => {
  const debug = toInternalDebugError(error, "responses");

  return sseFrame(
    JSON.stringify({
      type: "error",
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    }),
    "error",
  );
};

const isResponsesFailureEvent = (event: ResponsesStreamEvent): boolean =>
  event.type === "error" || event.type === "response.failed";

const isResponsesCompletionFrame = (
  frame: ProtocolFrame<ResponsesStreamEvent>,
): boolean =>
  frame.type === "event" &&
  (frame.event.type === "response.completed" ||
    frame.event.type === "response.incomplete");

export const respondResponses = async (
  c: Context,
  result: StreamExecuteResult<ResponsesStreamEvent>,
  wantsStream: boolean,
  recordUsage: RecordUsage,
  recordRequestPerformance: RecordRequestPerformance,
  requestStartedAt: number,
  downstreamAbortController?: AbortController,
): Promise<Response> => {
  const recordPerformance = (failed: boolean): void => {
    recordRequestPerformance(
      result.performance,
      failed,
      performance.now() - requestStartedAt,
    );
  };

  if (result.type === "upstream-error") {
    const response = upstreamErrorToResponse(result);
    recordPerformance(true);
    return response;
  }
  if (result.type === "internal-error") {
    const response = internalResponsesErrorResponse(
      result.status,
      result.error,
    );
    recordPerformance(true);
    return response;
  }

  const streamOutcome: SourceStreamOutcome = {
    failed: false,
    completed: false,
  };
  const events = trackSourceStreamOutcome(
    result.events,
    streamOutcome,
    isResponsesFailureEvent,
    isResponsesCompletionFrame,
  );

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(events);
      if (response.status === "failed") {
        streamOutcome.failed = true;
      }
      await recordUsageIfPresent(
        result.modelIdentity,
        tokenUsageFromResponsesResult(response),
        recordUsage,
      );
      recordPerformance(streamOutcome.failed);
      return Response.json(response);
    } catch (error) {
      streamOutcome.failed = true;

      const response = internalResponsesErrorResponse(
        502,
        toInternalDebugError(error, "responses"),
      );
      recordPerformance(true);
      return response;
    }
  }

  const response = proxySSE(
    c,
    responsesProtocolEventsToSSEFrames(events, {
      onUsage: (usage) => recordUsage(result.modelIdentity, usage),
    }),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        streamOutcome.failed = true;
        return internalResponsesStreamErrorFrame(error);
      },
      onComplete: (completion) => {
        recordPerformance(
          completion === "error" || streamOutcome.failed ||
            (completion === "cancel" && !streamOutcome.completed),
        );
      },
    },
  );
  return response;
};
