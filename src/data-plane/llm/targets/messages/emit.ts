import {
  copilotFetch,
  isCopilotTokenFetchError,
} from "../../../../shared/copilot.ts";
import type {
  MessagesPayload,
  MessagesResponse,
  MessagesStreamEventData,
} from "../../shared/protocol/messages.ts";
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
import { messagesStreamFramesToEvents } from "./events/from-stream.ts";
import { messagesTargetInterceptors } from "./interceptors/index.ts";

export interface EmitToMessagesInput extends EmitInput<MessagesPayload> {
  rawBeta?: string;
}

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export const emitToMessages = async (
  input: EmitToMessagesInput,
): Promise<EmitResult<MessagesStreamEventData>> => {
  try {
    input.payload.stream = true;

    const result = await runTargetInterceptors<
      EmitToMessagesInput,
      MessagesResponse
    >(
      input,
      messagesTargetInterceptors,
      async () => {
        const upstreamStartedAt = performance.now();
        const response = await copilotFetch(
          "/v1/messages",
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
          recordUpstreamHttpFailure(input, "messages");
          return await readUpstreamError(response);
        }
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              input.sourceApi,
              "messages",
            ),
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(withUpstreamTelemetry(
            parseSSEStream(response.body, {
              signal: input.downstreamAbortSignal,
            }),
            input,
            "messages",
            upstreamStartedAt,
          ));
        }

        return eventResult(withUpstreamTelemetry(
          (async function* () {
            yield jsonFrame(await response.json() as MessagesResponse);
          })(),
          input,
          "messages",
          upstreamStartedAt,
        ));
      },
    );

    return result.type === "events"
      ? eventResult(messagesStreamFramesToEvents(result.events))
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
      toInternalDebugError(error, input.sourceApi, "messages"),
    );
  }
};
