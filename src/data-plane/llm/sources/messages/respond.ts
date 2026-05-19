import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { MessagesStreamEventData } from "../../shared/protocol/messages.ts";
import {
  collectMessagesProtocolEventsToResponse,
} from "./events/to-response.ts";
import { messagesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { type ProtocolFrame, sseFrame } from "../../shared/stream/types.ts";
import {
  type PerformanceFailureCapture,
  setUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import { trackPerformanceOutcome } from "../performance.ts";

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
  type: "error",
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

const downstreamMessagesPingKeepAliveFrame = sseFrame(
  JSON.stringify({ type: "ping" }),
  "ping",
);

const internalMessagesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalMessagesErrorPayload(error), { status });

const internalMessagesStreamErrorFrame = (error: unknown) =>
  sseFrame(
    JSON.stringify(
      internalMessagesErrorPayload(toInternalDebugError(error, "messages")),
    ),
    "error",
  );

const isMessagesFailureEvent = (event: MessagesStreamEventData): boolean =>
  event.type === "error";

const isMessagesCompletionFrame = (
  frame: ProtocolFrame<MessagesStreamEventData>,
): boolean => frame.type === "event" && frame.event.type === "message_stop";

export const respondMessages = async (
  c: Context,
  result: StreamExecuteResult<MessagesStreamEventData>,
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
    const response = internalMessagesErrorResponse(result.status, result.error);
    setUsageResponseMetadata(c, { performance: result.performance });
    return response;
  }

  if (!wantsStream) {
    const performanceFailureCapture: PerformanceFailureCapture = {};
    try {
      const response = await collectMessagesProtocolEventsToResponse(
        result.events,
      );

      setUsageResponseMetadata(c, {
        usageModel: result.usageModel,
        performance: result.performance,
        performanceFailureCapture,
      });
      return Response.json(response);
    } catch (error) {
      performanceFailureCapture.failed = true;

      const response = internalMessagesErrorResponse(
        502,
        toInternalDebugError(error, "messages"),
      );
      setUsageResponseMetadata(c, {
        performance: result.performance,
        performanceFailureCapture,
      });
      return response;
    }
  }

  const performanceFailureCapture: PerformanceFailureCapture = {};
  const response = proxySSE(
    c,
    messagesProtocolEventsToSSEFrames(
      trackPerformanceOutcome(
        result.events,
        performanceFailureCapture,
        isMessagesFailureEvent,
        isMessagesCompletionFrame,
      ),
    ),
    {
      keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        performanceFailureCapture.failed = true;
        return internalMessagesStreamErrorFrame(error);
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
