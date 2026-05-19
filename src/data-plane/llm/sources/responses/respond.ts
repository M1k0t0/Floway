import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import { collectResponsesProtocolEventsToResult } from "./events/reassemble.ts";
import { responsesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { SourceResponseStreamEvent } from "./events/protocol.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import {
  type ProtocolFrame,
  sseCommentFrame,
  sseFrame,
} from "../../shared/stream/types.ts";
import {
  type PerformanceFailureCapture,
  setUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import { trackPerformanceOutcome } from "../performance.ts";

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

const isResponsesFailureEvent = (event: SourceResponseStreamEvent): boolean =>
  event.type === "error" || event.type === "response.failed";

const isResponsesCompletionFrame = (
  frame: ProtocolFrame<SourceResponseStreamEvent>,
): boolean =>
  frame.type === "event" &&
  (frame.event.type === "response.completed" ||
    frame.event.type === "response.incomplete");

export const respondResponses = async (
  c: Context,
  result: StreamExecuteResult<SourceResponseStreamEvent>,
  wantsStream: boolean,
  downstreamAbortController?: AbortController,
): Promise<Response> => {
  if (result.type === "upstream-error") {
    const response = upstreamErrorToResponse(result);
    setUsageResponseMetadata(c, {
      performance: result.performance,
    });
    return response;
  }
  if (result.type === "internal-error") {
    const response = internalResponsesErrorResponse(
      result.status,
      result.error,
    );
    setUsageResponseMetadata(c, { performance: result.performance });
    return response;
  }

  const performanceFailureCapture: PerformanceFailureCapture = {};
  const events = trackPerformanceOutcome(
    result.events,
    performanceFailureCapture,
    isResponsesFailureEvent,
    isResponsesCompletionFrame,
  );

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(events);
      if (response.status === "failed") {
        performanceFailureCapture.failed = true;
      }
      setUsageResponseMetadata(c, {
        usageModel: result.usageModel,
        performance: result.performance,
        performanceFailureCapture,
      });
      return Response.json(response);
    } catch (error) {
      performanceFailureCapture.failed = true;

      const response = internalResponsesErrorResponse(
        502,
        toInternalDebugError(error, "responses"),
      );
      setUsageResponseMetadata(c, {
        performance: result.performance,
        performanceFailureCapture,
      });
      return response;
    }
  }

  const response = proxySSE(
    c,
    responsesProtocolEventsToSSEFrames(events),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        performanceFailureCapture.failed = true;
        return internalResponsesStreamErrorFrame(error);
      },
    },
  );

  setUsageResponseMetadata(c, {
    usageModel: result.usageModel,
    performance: result.performance,
    performanceFailureCapture,
  });
  return response;
};
