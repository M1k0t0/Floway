import { messagesBaseInterceptors } from './interceptors/index.ts';
import { type MessagesInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { targetInternalError, targetModelIdentity, targetStreamResultToExecuteResult } from '../emit.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type TelemetryModelIdentity, type ExecuteResult } from '@floway-dev/provider';

const targetApi = 'messages';

export const emitToMessages = async (invocation: MessagesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...messagesBaseInterceptors, ...(invocation.targetInterceptors?.messages ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: MessagesPayload = invocation.payload;
      const providerResult = await invocation.provider.callMessages(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers, invocation.anthropicBeta);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      return await targetStreamResultToExecuteResult(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
