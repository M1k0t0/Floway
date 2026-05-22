import type { Context } from 'hono';

import { respondChatCompletions } from './respond.ts';
import { getModelCapabilities } from '../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ModelEndpoint, ProviderModelRecord } from '../../../providers/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type ChatCompletionsInterceptor, type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { translateToSourceEvents as chatCompletionsViaMessagesEvents } from '../../translate/chat-completions-via-messages/events.ts';
import { buildTargetRequest as chatCompletionsViaMessagesRequest } from '../../translate/chat-completions-via-messages/request.ts';
import { translateToSourceEvents as chatCompletionsViaResponsesEvents } from '../../translate/chat-completions-via-responses/events.ts';
import { buildTargetRequest as chatCompletionsViaResponsesRequest } from '../../translate/chat-completions-via-responses/request.ts';
import { type SourceEmit, viaTranslation } from '../../translate/types.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';

const chatSourceInterceptorsForProvider = (binding: ProviderModelRecord): readonly ChatCompletionsInterceptor[] => binding.sourceInterceptors?.chatCompletions ?? [];

const chatInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'chat-completions' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFixes: binding.enabledFixes,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    return null;
  };

  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model);
    let result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const capabilities = getModelCapabilities(binding.upstreamModel);
        const target = pickTarget(binding.upstreamModel.supportedEndpoints);
        if (!target) continue;

        const invocation: ChatCompletionsInvocation = chatInvocation(binding, target, model, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, ChatCompletionChunk>> = {
          'chat-completions': async srcPayload => await emitToChatCompletions({ ...invocation, payload: srcPayload }, request),
          messages: viaTranslation({
            targetApi: 'messages',
            buildTargetPayload: (payload, ctx) => chatCompletionsViaMessagesRequest(payload, ctx.capabilities),
            translateEvents: frames => chatCompletionsViaMessagesEvents(frames),
          }, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(chatInvocation(binding, 'messages', model, tgtPayload), request)),
          responses: viaTranslation({
            targetApi: 'responses',
            buildTargetPayload: payload => chatCompletionsViaResponsesRequest(payload),
            translateEvents: frames => chatCompletionsViaResponsesEvents(frames),
          }, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(chatInvocation(binding, 'responses', model, tgtPayload), request)),
        };

        result = await runInterceptors(invocation, request, chatSourceInterceptorsForProvider(binding), () =>
          emits[target](invocation.payload, { model, wantsStream, capabilities }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/chat/completions');
    }

    return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, request, downstreamAbortController);
  } catch (error) {
    return await respondChatCompletions(
      c,
      sourceErrorResult(error, {
        sourceApi: 'chat-completions',
        internalStatus: 502,
      }),
      false,
      includeUsageChunk,
      request, downstreamAbortController,
    );
  }
};
