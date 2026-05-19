import type { Context } from "hono";
import type {
  GeminiErrorResponse,
  GeminiStreamEvent,
} from "../../shared/protocol/gemini.ts";
import type { InternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import {
  type PerformanceFailureCapture,
  setUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import type {
  StreamExecuteResult,
  UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { decodeUpstreamErrorBody } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import {
  type ProtocolFrame,
  sseCommentFrame,
  sseFrame,
} from "../../shared/stream/types.ts";
import { trackPerformanceOutcome } from "../performance.ts";
import {
  isGeminiErrorEvent,
  isGeminiFinishedEvent,
} from "./events/protocol.ts";
import { collectGeminiProtocolEventsToResponse } from "./events/to-response.ts";
import { geminiProtocolEventsToSSEFrames } from "./events/to-sse.ts";

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 500:
      return "INTERNAL";
    case 502:
    case 503:
      return "UNAVAILABLE";
    default:
      return "INTERNAL";
  }
};

const downstreamSSECommentKeepAliveFrame = sseCommentFrame("keepalive");

type GeminiErrorDebugFields =
  & Partial<
    Pick<
      InternalDebugError,
      "type" | "name" | "stack" | "cause"
    >
  >
  & { source_api?: string; target_api?: string };

type GeminiErrorStatusPayload = {
  error: GeminiErrorResponse["error"] & GeminiErrorDebugFields;
};

const isSaneErrorHttpStatus = (status: number): boolean =>
  Number.isInteger(status) && status >= 400 && status <= 599;

const synthesizedGeminiHttpStatusCode = (status: number): number =>
  geminiStatusForHttpStatus(status) === "INTERNAL" && status !== 500
    ? 500
    : status;

const googleRpcHttpStatusCode = (status: number): number =>
  isSaneErrorHttpStatus(status) ? status : 500;

const geminiErrorPayload = (
  status: number,
  message: string,
  debug: GeminiErrorDebugFields = {},
): GeminiErrorStatusPayload => {
  const code = synthesizedGeminiHttpStatusCode(status);
  return {
    error: { code, message, status: geminiStatusForHttpStatus(code), ...debug },
  };
};

const geminiErrorResponse = (
  status: number,
  message: string,
  debug: GeminiErrorDebugFields = {},
): Response => {
  const payload = geminiErrorPayload(status, message, debug);
  return Response.json(payload, { status: payload.error.code });
};

const geminiErrorEventResponse = (event: GeminiErrorResponse): Response =>
  Response.json(event, { status: googleRpcHttpStatusCode(event.error.code) });

const geminiErrorEventFrame = (event: GeminiErrorStatusPayload) =>
  sseFrame(JSON.stringify(event));

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isGeminiErrorResponse = (
  value: unknown,
): value is GeminiErrorResponse => {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const payload = error as Partial<GeminiErrorResponse["error"]>;
  return typeof payload.code === "number" &&
    typeof payload.message === "string" && typeof payload.status === "string";
};

const upstreamGoogleRpcErrorResponse = (
  error: UpstreamErrorResult,
): Response | null => {
  const parsed = parseJson(decodeUpstreamErrorBody(error).trim());
  if (!isGeminiErrorResponse(parsed)) return null;

  return new Response(error.body.slice(), {
    status: googleRpcHttpStatusCode(parsed.error.code),
    headers: new Headers(error.headers),
  });
};

const upstreamErrorMessage = (error: UpstreamErrorResult): string => {
  const body = decodeUpstreamErrorBody(error).trim();
  return body || "Upstream Gemini request failed.";
};

const caughtGeminiErrorEvent = (error: unknown): GeminiErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiErrorResponse(error.cause) ? error.cause : null;
};

const internalErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const serializeErrorCause = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause;

  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    cause: serializeErrorCause(cause.cause),
  };
};

const internalDebugFields = (
  error: InternalDebugError,
): GeminiErrorDebugFields => ({
  type: error.type,
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  source_api: error.source_api,
  ...(error.target_api ? { target_api: error.target_api } : {}),
});

const unknownInternalDebugFields = (
  error: unknown,
): GeminiErrorDebugFields => {
  if (error instanceof Error) {
    return {
      type: "internal_error",
      name: error.name,
      stack: error.stack,
      cause: serializeErrorCause(error.cause),
      source_api: "gemini",
    };
  }

  return { type: "internal_error", cause: error, source_api: "gemini" };
};

const isGeminiFailureEvent = (event: GeminiStreamEvent): boolean =>
  isGeminiErrorEvent(event);

const isGeminiCompletionFrame = (
  frame: ProtocolFrame<GeminiStreamEvent>,
): boolean =>
  frame.type === "done" ||
  (frame.type === "event" && isGeminiFinishedEvent(frame.event));

export const respondGemini = async (
  c: Context,
  result: StreamExecuteResult<GeminiStreamEvent>,
  wantsStream: boolean,
  downstreamAbortController?: AbortController,
): Promise<Response> => {
  if (result.type === "upstream-error") {
    const googleRpcResponse = upstreamGoogleRpcErrorResponse(result);
    const response = googleRpcResponse ??
      geminiErrorResponse(result.status, upstreamErrorMessage(result));
    setUsageResponseMetadata(c, { performance: result.performance });
    return response;
  }

  if (result.type === "internal-error") {
    const response = geminiErrorResponse(
      result.status,
      result.error.message,
      internalDebugFields(result.error),
    );
    setUsageResponseMetadata(c, { performance: result.performance });
    return response;
  }

  const performanceFailureCapture: PerformanceFailureCapture = {};
  const events = trackPerformanceOutcome(
    result.events,
    performanceFailureCapture,
    isGeminiFailureEvent,
    isGeminiCompletionFrame,
  );

  if (!wantsStream) {
    try {
      const response = await collectGeminiProtocolEventsToResponse(events);
      setUsageResponseMetadata(c, {
        usageModel: result.usageModel,
        performance: result.performance,
        performanceFailureCapture,
      });
      return Response.json(response);
    } catch (error) {
      performanceFailureCapture.failed = true;
      const geminiError = caughtGeminiErrorEvent(error);
      const response = geminiError
        ? geminiErrorEventResponse(geminiError)
        : geminiErrorResponse(
          502,
          internalErrorMessage(error),
          unknownInternalDebugFields(error),
        );

      setUsageResponseMetadata(c, {
        usageModel: result.usageModel,
        performance: result.performance,
        performanceFailureCapture,
      });
      return response;
    }
  }

  const response = proxySSE(
    c,
    geminiProtocolEventsToSSEFrames(events),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        performanceFailureCapture.failed = true;
        return geminiErrorEventFrame(
          caughtGeminiErrorEvent(error) ??
            geminiErrorPayload(
              500,
              internalErrorMessage(error),
              unknownInternalDebugFields(error),
            ),
        );
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
