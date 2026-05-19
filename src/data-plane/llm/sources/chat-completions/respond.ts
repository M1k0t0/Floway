import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { ChatCompletionChunk } from "../../shared/protocol/chat-completions.ts";
import { chatCompletionsErrorPayloadMessage } from "../../shared/protocol/chat-completions-errors.ts";
import { collectChatProtocolEventsToCompletion } from "./events/reassemble.ts";
import { chatProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import {
  type ProtocolFrame,
  sseCommentFrame,
  sseFrame,
} from "../../shared/stream/types.ts";
import {
  type HiddenChatStreamUsageCapture,
  type PerformanceFailureCapture,
  setUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import { trackPerformanceOutcome } from "../performance.ts";

const internalChatErrorPayload = (error: InternalDebugError) => ({
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

const internalChatErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalChatErrorPayload(error), { status });

const internalChatStreamErrorFrame = (error: unknown) =>
  sseFrame(
    JSON.stringify(
      internalChatErrorPayload(toInternalDebugError(error, "chat-completions")),
    ),
    "error",
  );

const isChatCompletionFailureEvent = (event: ChatCompletionChunk): boolean =>
  chatCompletionsErrorPayloadMessage(event) !== null;

const isChatCompletionCompletionFrame = (
  frame: ProtocolFrame<ChatCompletionChunk>,
): boolean => frame.type === "done";

export const respondChatCompletions = async (
  c: Context,
  result: StreamExecuteResult<ChatCompletionChunk>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
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
    const response = internalChatErrorResponse(result.status, result.error);
    setUsageResponseMetadata(c, { performance: result.performance });
    return response;
  }

  if (!wantsStream) {
    const performanceFailureCapture: PerformanceFailureCapture = {};
    try {
      const response = await collectChatProtocolEventsToCompletion(
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

      const response = internalChatErrorResponse(
        502,
        toInternalDebugError(error, "chat-completions"),
      );
      setUsageResponseMetadata(c, {
        performance: result.performance,
        performanceFailureCapture,
      });
      return response;
    }
  }

  const hiddenUsageCapture: HiddenChatStreamUsageCapture = {};
  const performanceFailureCapture: PerformanceFailureCapture = {};

  const response = proxySSE(
    c,
    chatProtocolEventsToSSEFrames(
      trackPerformanceOutcome(
        result.events,
        performanceFailureCapture,
        isChatCompletionFailureEvent,
        isChatCompletionCompletionFrame,
      ),
      {
        includeUsageChunk,
        onUsageChunk: (usage) => {
          hiddenUsageCapture.usage = usage;
        },
      },
    ),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        performanceFailureCapture.failed = true;
        return internalChatStreamErrorFrame(error);
      },
    },
  );
  setUsageResponseMetadata(c, {
    hiddenChatStreamUsageCapture: hiddenUsageCapture,
    usageModel: result.usageModel,
    performance: result.performance,
    performanceFailureCapture,
  });
  return response;
};
