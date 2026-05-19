import {
  copilotFetch,
  isCopilotTokenFetchError,
} from "../../../../shared/copilot.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../shared/protocol/chat-completions.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame } from "../../shared/stream/types.ts";
import { runTargetInterceptors } from "../run-interceptors.ts";
import type { EmitInput, EmitResult } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { chatCompletionsStreamFramesToEvents } from "./events/from-stream.ts";
import { chatCompletionsTargetInterceptors } from "./interceptors/index.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export const emitToChatCompletions = async (
  input: EmitInput<ChatCompletionsPayload>,
): Promise<EmitResult<ChatCompletionChunk>> => {
  try {
    const result = await runTargetInterceptors<
      EmitInput<ChatCompletionsPayload>,
      ChatCompletionResponse
    >(
      input,
      chatCompletionsTargetInterceptors,
      async () => {
        const upstreamStartedAt = performance.now();
        const response = await copilotFetch(
          "/chat/completions",
          {
            method: "POST",
            body: JSON.stringify(input.payload),
            signal: input.downstreamAbortSignal,
          },
          input.githubToken,
          input.accountType,
          input.fetchOptions,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "chat-completions");
          return await readUpstreamError(response);
        }
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              input.sourceApi,
              "chat-completions",
            ),
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(withUpstreamTelemetry(
            parseSSEStream(response.body, {
              signal: input.downstreamAbortSignal,
            }),
            input,
            "chat-completions",
            upstreamStartedAt,
          ));
        }

        return eventResult(withUpstreamTelemetry(
          (async function* () {
            yield jsonFrame(await response.json() as ChatCompletionResponse);
          })(),
          input,
          "chat-completions",
          upstreamStartedAt,
        ));
      },
    );

    return result.type === "events"
      ? eventResult(chatCompletionsStreamFramesToEvents(result.events))
      : result;
  } catch (error) {
    if (isCopilotTokenFetchError(error)) {
      return {
        type: "upstream-error",
        status: error.status,
        headers: new Headers(error.headers),
        body: new TextEncoder().encode(error.body),
      };
    }

    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "chat-completions"),
    );
  }
};
