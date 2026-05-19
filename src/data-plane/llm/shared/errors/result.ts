import type { InternalDebugError } from "./internal-debug-error.ts";
import type { ProtocolFrame } from "../stream/types.ts";
import type { PerformanceTelemetryContext } from "../../../shared/performance/telemetry.ts";

export interface EventResult<T> {
  type: "events";
  events: AsyncIterable<T>;
  usageModel?: string;
  performance?: PerformanceTelemetryContext;
}

export interface UpstreamErrorResult {
  type: "upstream-error";
  status: number;
  headers: Headers;
  body: Uint8Array;
  performance?: PerformanceTelemetryContext;
}

export interface InternalErrorResult {
  type: "internal-error";
  status: number;
  error: InternalDebugError;
  performance?: PerformanceTelemetryContext;
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult;

export type StreamExecuteResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;

export const eventResult = <T>(
  events: AsyncIterable<T>,
  options: { usageModel?: string; performance?: PerformanceTelemetryContext } =
    {},
): EventResult<T> => {
  const result: EventResult<T> = { type: "events", events };
  if (options.usageModel !== undefined) result.usageModel = options.usageModel;
  if (options.performance !== undefined) {
    result.performance = options.performance;
  }
  return result;
};

export const internalErrorResult = (
  status: number,
  error: InternalDebugError,
  performance?: PerformanceTelemetryContext,
): InternalErrorResult => ({
  type: "internal-error",
  status,
  error,
  ...(performance ? { performance } : {}),
});
