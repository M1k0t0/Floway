import type { EmitInput } from './emit-types.ts';
import { recordUpstreamHttpFailure, targetPerformanceContext, withUpstreamTelemetry } from './telemetry.ts';
import type { PerformanceApiName, TelemetryModelIdentity } from '../../../repo/types.ts';
import type { ProviderCallResult } from '../../providers/types.ts';
import type { LlmExchangeMeta } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { eventResult, type ExecuteResult, type InternalErrorResult, internalErrorResult } from '../shared/errors/result.ts';
import { readUpstreamError } from '../shared/errors/upstream-error.ts';
import { parseSSEStream } from '../shared/stream/parse-sse.ts';
import type { SseFrame } from '../shared/stream/types.ts';

export type TargetEmitPayload = {
  model: string;
  stream?: boolean | null;
};

export type TargetEmitApiName = Exclude<PerformanceApiName, 'gemini' | 'embeddings'>;

export const targetModelIdentity = (input: EmitInput<TargetEmitPayload>, modelKey: string): TelemetryModelIdentity => ({
  model: input.model,
  upstream: input.upstream,
  modelKey,
});

export const targetExchangeMeta = (input: EmitInput<TargetEmitPayload>): LlmExchangeMeta => ({
  sourceApi: input.sourceApi,
  targetApi: input.targetApi,
  model: input.model,
  upstream: input.upstream,
  upstreamModel: input.upstreamModel,
  provider: input.provider,
  enabledFixes: input.enabledFixes,
  ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
  ...(input.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: input.downstreamAbortSignal } : {}),
});

export const targetProviderResultToFrames = async (
  input: EmitInput<TargetEmitPayload>,
  targetApi: TargetEmitApiName,
  providerResult: ProviderCallResult,
  modelIdentity: TelemetryModelIdentity,
  upstreamStartedAt: number,
): Promise<ExecuteResult<SseFrame>> => {
  const perfContext = targetPerformanceContext(input, targetApi, modelIdentity);
  const { response } = providerResult;

  if (!response.ok) {
    recordUpstreamHttpFailure(input, targetApi, modelIdentity);
    return {
      ...(await readUpstreamError(response)),
      performance: perfContext,
    };
  }

  if (!response.body) {
    return internalErrorResult(502, toInternalDebugError(new Error('No response body from upstream'), input.sourceApi, targetApi), perfContext);
  }

  // Provider layer forces stream=true on every LLM endpoint, so any non-SSE
  // 200 response is a provider-contract violation: convert it to a 502 with
  // diagnostic context rather than silently parsing JSON. See
  // providers/endpoints.ts::isStreamingEndpoint.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    recordUpstreamHttpFailure(input, targetApi, modelIdentity);
    return internalErrorResult(
      502,
      toInternalDebugError(
        new Error(`Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok)`),
        input.sourceApi,
        targetApi,
      ),
      perfContext,
    );
  }

  return eventResult(withUpstreamTelemetry(parseSSEStream(response.body, { signal: input.downstreamAbortSignal }), input, targetApi, upstreamStartedAt, modelIdentity), modelIdentity, perfContext);
};

export const targetInternalError = (input: EmitInput<TargetEmitPayload>, targetApi: TargetEmitApiName, error: unknown, modelIdentity: TelemetryModelIdentity | undefined): InternalErrorResult =>
  internalErrorResult(502, toInternalDebugError(error, input.sourceApi, targetApi), modelIdentity ? targetPerformanceContext(input, targetApi, modelIdentity) : undefined);
