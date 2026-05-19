import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../shared/protocol/responses.ts";
import type { EmitInput, RawEmitResult } from "../../emit-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import { sseFrame, type StreamFrame } from "../../../shared/stream/types.ts";

const CYBER_POLICY_ERROR_CODE = "cyber_policy";
const MAX_CYBER_POLICY_RETRIES = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface FailurePayload {
  error: {
    message: string;
    type: string;
    code: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  };
  response?: Record<string, unknown>;
}

type FailureResult = Exclude<
  RawEmitResult<ResponsesResult>,
  { type: "events" }
>;

const stringField = (
  value: unknown,
  fallback: string,
): string => typeof value === "string" && value.length > 0 ? value : fallback;

const responseStringField = (
  response: Record<string, unknown> | undefined,
  field: string,
  fallback: string,
): string => response ? stringField(response[field], fallback) : fallback;

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === "string" ? { name: value.name } : {}),
  ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.source_api === "string"
    ? { source_api: value.source_api }
    : {}),
  ...(typeof value.target_api === "string"
    ? { target_api: value.target_api }
    : {}),
});

const cyberPolicyErrorFrom = (
  value: unknown,
): FailurePayload["error"] | undefined => {
  if (!isRecord(value) || value.code !== CYBER_POLICY_ERROR_CODE) {
    return undefined;
  }

  return {
    message: stringField(
      value.message,
      "This request was blocked by upstream cyber policy.",
    ),
    type: stringField(value.type, "invalid_request_error"),
    code: CYBER_POLICY_ERROR_CODE,
  };
};

const cyberPolicyPayloadFrom = (
  value: unknown,
): FailurePayload | undefined => {
  if (!isRecord(value)) return undefined;
  const error = cyberPolicyErrorFrom(value.error);
  if (error) return { error };

  if (!isRecord(value.response)) return undefined;
  const responseError = cyberPolicyErrorFrom(value.response.error);
  return responseError
    ? { error: responseError, response: value.response }
    : undefined;
};

const isCyberPolicyPayload = (value: unknown): boolean => {
  return cyberPolicyPayloadFrom(value) !== undefined;
};

const cyberPolicyUpstreamErrorFrom = (
  result: RawEmitResult<ResponsesResult>,
): FailurePayload | undefined => {
  if (result.type !== "upstream-error") return undefined;

  try {
    return cyberPolicyPayloadFrom(
      JSON.parse(new TextDecoder().decode(result.body)),
    );
  } catch {
    return undefined;
  }
};

const isCyberPolicyUpstreamError = (
  result: RawEmitResult<ResponsesResult>,
): boolean => {
  return cyberPolicyUpstreamErrorFrom(result) !== undefined;
};

const failurePayloadFromUpstreamError = (
  result: Extract<RawEmitResult<ResponsesResult>, { type: "upstream-error" }>,
): FailurePayload => {
  const bodyText = new TextDecoder().decode(result.body);
  let response: Record<string, unknown> | undefined;
  let error: Record<string, unknown> | undefined;

  try {
    const parsed = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      if (isRecord(parsed.response)) {
        response = parsed.response;
        if (isRecord(response.error)) error = response.error;
      }
      if (!error && isRecord(parsed.error)) error = parsed.error;
    }
  } catch {
    // Raw upstream error bodies are still useful as streamed failure messages.
  }

  return {
    error: {
      message: stringField(
        error?.message,
        bodyText ||
          `Upstream Responses request failed with HTTP ${result.status}.`,
      ),
      type: stringField(error?.type, "upstream_error"),
      code: stringField(error?.code, `http_${result.status}`),
      ...(error ? debugFieldsFrom(error) : {}),
    },
    ...(response ? { response } : {}),
  };
};

const failurePayloadFromResult = (
  result: FailureResult,
): FailurePayload => {
  if (result.type === "upstream-error") {
    return failurePayloadFromUpstreamError(result);
  }

  return {
    error: {
      message: result.error.message,
      type: result.error.type,
      code: result.error.type,
      name: result.error.name,
      ...(result.error.stack !== undefined
        ? { stack: result.error.stack }
        : {}),
      ...(result.error.cause !== undefined
        ? { cause: result.error.cause }
        : {}),
      source_api: result.error.source_api,
      ...(result.error.target_api !== undefined
        ? { target_api: result.error.target_api }
        : {}),
    },
  };
};

const failureFrameFromResult = (
  ctx: EmitInput<ResponsesPayload>,
  result: FailureResult,
): StreamFrame<ResponsesResult> => {
  const payload = failurePayloadFromResult(result);

  return sseFrame(
    JSON.stringify({
      type: "response.failed",
      response: {
        id: responseStringField(
          payload.response,
          "id",
          "resp_upstream_failed",
        ),
        object: responseStringField(payload.response, "object", "response"),
        model: responseStringField(
          payload.response,
          "model",
          ctx.payload.model,
        ),
        status: "failed",
        output: [],
        output_text: "",
        error: payload.error,
      },
    }),
    "response.failed",
  );
};

const isCyberPolicyJsonFrame = (response: ResponsesResult): boolean =>
  response.status === "failed" &&
  response.error?.code === CYBER_POLICY_ERROR_CODE;

const isCyberPolicySseFrame = (data: string): boolean => {
  try {
    return isCyberPolicyPayload(JSON.parse(data));
  } catch {
    return false;
  }
};

const isCyberPolicyFrame = (frame: StreamFrame<ResponsesResult>): boolean => {
  if (frame.type === "json") return isCyberPolicyJsonFrame(frame.data);

  return isCyberPolicySseFrame(frame.data);
};

const replayFirstThenRest = async function* (
  first: StreamFrame<ResponsesResult>,
  iterator: AsyncIterator<StreamFrame<ResponsesResult>>,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  let done = false;

  try {
    yield first;

    while (true) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return;
      }

      yield next.value;
    }
  } finally {
    if (!done) await iterator.return?.();
  }
};

type EventsResult = Extract<RawEmitResult<ResponsesResult>, { type: "events" }>;

const isDownstreamAborted = (ctx: EmitInput<ResponsesPayload>): boolean =>
  ctx.downstreamAbortSignal?.aborted === true;

const retryCyberPolicyEvents = async function* (
  ctx: EmitInput<ResponsesPayload>,
  run: () => Promise<RawEmitResult<ResponsesResult>>,
  initialResult: EventsResult,
): AsyncGenerator<StreamFrame<ResponsesResult>> {
  let result: RawEmitResult<ResponsesResult> = initialResult;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    if (result.type !== "events") {
      if (
        isCyberPolicyUpstreamError(result) &&
        attempt < MAX_CYBER_POLICY_RETRIES &&
        !isDownstreamAborted(ctx)
      ) {
        result = await run();
        continue;
      }

      if (isDownstreamAborted(ctx)) return;
      yield failureFrameFromResult(ctx, result);
      return;
    }

    const iterator = result.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) return;

    if (!isCyberPolicyFrame(first.value)) {
      yield* replayFirstThenRest(first.value, iterator);
      return;
    }

    // Retry only before any failed attempt frames reach the source pipeline.
    // This first-frame inspection is lazy so downstream keep-alives and aborts
    // are active while Copilot is still idle before its first stream frame.
    await iterator.return?.();
    if (
      attempt >= MAX_CYBER_POLICY_RETRIES || isDownstreamAborted(ctx)
    ) {
      yield first.value;
      return;
    }

    result = await run();
  }
};

/**
 * OpenAI's GPT-5.x Responses path is prone to intermittent false-positive
 * `cyber_policy` failures for Codex traffic. Copilot upstream does not support
 * the Trusted Access for Cyber program named in OpenAI's client-facing text, so
 * this gateway cannot resolve those failures through account verification and
 * can only retry the upstream attempt.
 *
 * Keep this at the `/responses` target boundary because both HTTP error bodies
 * and streaming `response.failed` payloads are upstream protocol details. The
 * interceptor suppresses retried failed attempts and passes through either the
 * first successful attempt or the final policy failure.
 *
 * References:
 * - https://openai.com/index/trusted-access-for-cyber/
 * - https://deploymentsafety.openai.com/gpt-5-3-codex/cybersecurity
 *
 * TODO: Add gateway-side recent cyber-policy retry/error-log storage so
 * operators can inspect detailed upstream failures, matching the web-search shim
 * error-log TODO pattern.
 */
export const withCyberPolicyRetried: TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
> = async (ctx, run) => {
  let finalResult: RawEmitResult<ResponsesResult> | undefined;

  for (let attempt = 0; attempt <= MAX_CYBER_POLICY_RETRIES; attempt++) {
    const current = await run();
    finalResult = current;

    if (current.type === "events") {
      return {
        ...current,
        events: retryCyberPolicyEvents(ctx, run, current),
      };
    }

    if (!isCyberPolicyUpstreamError(current) || isDownstreamAborted(ctx)) {
      return current;
    }
  }

  return finalResult!;
};
