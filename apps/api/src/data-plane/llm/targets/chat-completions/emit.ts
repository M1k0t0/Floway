import { chatCompletionsBaseInterceptors } from './interceptors/index.ts';
import { type ChatCompletionsInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { targetInternalError, targetModelIdentity, targetStreamResultToExecuteResult } from '../emit.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type TelemetryModelIdentity, type ExecuteResult } from '@floway-dev/provider';

const targetApi = 'chat-completions';

export const emitToChatCompletions = async (invocation: ChatCompletionsInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...chatCompletionsBaseInterceptors, ...(invocation.targetInterceptors?.chatCompletions ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ChatCompletionsPayload = invocation.payload;
      const providerResult = await invocation.provider.callChatCompletions(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      return await targetStreamResultToExecuteResult(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
