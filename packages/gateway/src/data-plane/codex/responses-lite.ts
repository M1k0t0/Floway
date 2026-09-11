import type { OpenAIResponsesInterceptor } from '../chat/openai-responses/interceptors/types.ts';
import { providerModelOf } from '@floway-dev/provider';
import { CODEX_RESPONSES_LITE_HEADER, downstreamRequestsCodexResponsesLite, liftCodexResponsesLiteRequest, restoreCodexResponsesFrames } from '@floway-dev/provider-codex';

export const withCodexResponsesLite: OpenAIResponsesInterceptor = async (invocation, _ctx, run) => {
  if (!downstreamRequestsCodexResponsesLite(invocation.headers, invocation.payload)) return await run();
  const { candidate, targetApi } = invocation;
  if (
    targetApi === 'openaiResponses'
    && candidate.provider.instance.supportsOpenAIResponsesLite?.(providerModelOf(candidate)) === true
  ) return await run();

  const bridge = liftCodexResponsesLiteRequest(invocation.payload, {
    flattenNamespaces: targetApi !== 'openaiResponses',
  });
  invocation.payload = { ...bridge.body, model: invocation.payload.model };
  invocation.headers.delete(CODEX_RESPONSES_LITE_HEADER);

  const result = await run();
  if (result.type !== 'events') return result;
  const headers = new Headers(result.headers);
  headers.set(CODEX_RESPONSES_LITE_HEADER, 'true');
  return {
    ...result,
    headers,
    events: restoreCodexResponsesFrames(result.events, bridge.callableIdentities, bridge.requestEchoes),
  };
};
