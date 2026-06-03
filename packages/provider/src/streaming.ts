import type { ProviderStreamResult } from './provider.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export type ProviderStreamParser<TEvent> = (
  body: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal },
) => AsyncIterable<ProtocolFrame<TEvent>>;

// A 2xx non-SSE upstream is a provider-contract violation: every streaming
// endpoint is called with stream=true. The throw bubbles to the target
// boundary, which turns it into a 502.
export const streamingProviderCall = async <TEvent>(
  upstreamFetch: Promise<Response>,
  parser: ProviderStreamParser<TEvent>,
  modelKey: string,
  signal: AbortSignal | undefined,
): Promise<ProviderStreamResult<TEvent>> => {
  const response = await upstreamFetch;
  if (!response.ok) {
    return { ok: false, response, modelKey };
  }
  if (!response.body) {
    throw new Error(`Upstream returned ${response.status} without a body, but a streaming SSE response was required`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok)`);
  }
  return { ok: true, events: parser(response.body, { signal }), modelKey };
};
