import { targetInternalError, targetModelIdentity, targetStreamResultToExecuteResult } from '../emit.ts';
import { responsesBaseInterceptors } from './interceptors/index.ts';
import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type TelemetryModelIdentity, type ExecuteResult } from '@floway-dev/provider';

const targetApi = 'responses';

export const emitToResponses = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ResponsesPayload = invocation.payload;
      const providerResult = await invocation.provider.callResponses(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      return await targetStreamResultToExecuteResult(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
