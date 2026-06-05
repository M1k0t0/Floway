import { chatCompletionsSourceInterceptors } from './interceptors/index.ts';
import { respondChatCompletions } from './respond.ts';
import { type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createHttpRequestContext } from '../request-context.ts';
import { type LlmHttpEndpoint, jsonUpstreamErrorResult, sourceErrorResult, type LlmServeFailure, type LlmSourceTraits } from '../traits.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ProviderModelRecord } from '@floway-dev/provider';
import { type SourceEmit, translateChatCompletionsViaMessages, translateChatCompletionsViaResponses, viaTranslation } from '@floway-dev/translate';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const chatCompletionsInvocation = <TPayload extends { model: string }>(
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
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers: {} as Record<string, string>,
});

// OpenAI error envelope. `param`/`code` reproduce OpenAI's native fields; a
// stored-item miss must byte-match OpenAI's own "not found" body.
const openAiErrorResult = (status: number, message: string, extra?: { param: string; code: string | null }): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  jsonUpstreamErrorResult(status, { error: { message, type: 'invalid_request_error', ...extra } });

const renderChatCompletionsFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return openAiErrorResult(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null });
  case 'routing-unavailable':
    return openAiErrorResult(400, failure.message, { param: 'input', code: 'responses_item_routing_unavailable' });
  case 'model-missing':
    return openAiErrorResult(404, `Model ${failure.model} is not available on any configured upstream.`);
  case 'model-unsupported':
    return openAiErrorResult(400, `Model ${failure.model} does not support the /chat/completions endpoint.`);
  case 'internal':
    return sourceErrorResult<ChatCompletionsStreamEvent>(failure.error, { sourceApi: 'chat-completions', internalStatus: 502 });
  }
};

// Target interceptors may force upstream usage for gateway accounting, but
// Chat SSE exposes usage only when the caller requested `include_usage`.
// `prepare` parses that intent off the body; `respond` reads it back from the
// per-request Hono context, since the shared traits object holds no per-call
// state.
const INCLUDE_USAGE_CHUNK_KEY = 'chatCompletionsIncludeUsageChunk';

const chatCompletionsGenerate: LlmHttpEndpoint<readonly ChatCompletionsMessage[], ChatCompletionsStreamEvent> = {
  respond: async ({ c, result, runtime }) =>
    await respondChatCompletions(c, result, runtime.wantsStream, c.get(INCLUDE_USAGE_CHUNK_KEY) === true, runtime.request, runtime.downstreamAbortController),
  prepare: async c => {
    const payload = await c.req.json<ChatCompletionsPayload>();
    c.set(INCLUDE_USAGE_CHUNK_KEY, payload.stream_options?.include_usage === true);
    const wantsStream = payload.stream === true;
    const downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const request = createHttpRequestContext(c, downstreamAbortController?.signal, wantsStream);
    return {
      request,
      items: payload.messages,
      responsesItemsView: chatCompletionsViaResponsesItemsView,
      wantsStream,
      store: payload.store,
      model: payload.model,
      downstreamAbortController,
      pickTarget: endpoints => endpoints.chatCompletions ? 'chat-completions' : endpoints.messages ? 'messages' : endpoints.responses ? 'responses' : null,
      attempt: async ({ binding, target, model, rewriteItems }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        attemptPayload.messages = await rewriteItems(attemptPayload.messages);
        const invocation: ChatCompletionsInvocation = chatCompletionsInvocation(binding, target, model, attemptPayload);
        const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>> = {
          'chat-completions': async srcPayload => await emitToChatCompletions({ ...invocation, payload: srcPayload }, request),
          messages: viaTranslation(translateChatCompletionsViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(chatCompletionsInvocation(binding, 'messages', model, tgtPayload), request)),
          responses: viaTranslation(translateChatCompletionsViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(chatCompletionsInvocation(binding, 'responses', model, tgtPayload), request)),
        };
        const interceptors = [...chatCompletionsSourceInterceptors, ...(binding.sourceInterceptors?.chatCompletions ?? [])];
        return await runInterceptors(invocation, request, interceptors, () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
      },
    };
  },
};

export const chatCompletionsTraits: LlmSourceTraits<readonly ChatCompletionsMessage[], ChatCompletionsStreamEvent> = {
  renderFailure: renderChatCompletionsFailure,
  endpoints: { generate: chatCompletionsGenerate },
};
