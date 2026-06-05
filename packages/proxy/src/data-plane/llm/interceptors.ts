import type { StatefulResponsesStore } from './sources/responses/stateful-store.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type {
  ChatCompletionsInvocation,
  ExecuteResult,
  GeminiInvocation,
  MessagesInvocation,
  ResponsesInvocation,
} from '@floway-dev/provider';

// Re-export the generic interceptor machinery so api-internal call sites keep
// their short module path.
export { runInterceptors } from '@floway-dev/interceptor';
export type { Interceptor, InterceptorRun } from '@floway-dev/interceptor';

// Re-export per-protocol Invocation types and the protocol/api enums so
// api-internal call sites keep their short module path.
export type {
  ChatCompletionsInvocation,
  GeminiInvocation,
  Invocation,
  LlmSourceApi,
  LlmTargetApi,
  MessagesInvocation,
  ResponsesInvocation,
} from '@floway-dev/provider';

/**
 * Per client request scope. Constructed once in `createHttpRequestContext` and
 * threaded through every layer (source interceptors, target emits, target
 * interceptors, telemetry). Holds immutable identities/adapters plus the
 * Responses state store that owns mutable request and provider-attempt state.
 *
 * Telemetry recording is done via global helpers that accept `apiKeyId`
 * explicitly so call sites stay visible about the no-op when the request has
 * no API key (ADMIN_KEY playground path).
 *
 * Structurally satisfies the provider package's empty `InterceptorRequest`
 * marker, so provider-package interceptors typed against the marker remain
 * assignable to api-side chains typed against this richer context (parameter
 * contravariance: a function accepting `{}` is a valid element in a list of
 * functions accepting `RequestContext`).
 */
export interface RequestContext {
  readonly requestStartedAt: number;
  readonly apiKeyId?: string;
  // null = Default mode (inherit global upstream order).
  readonly apiKeyUpstreamIds: readonly string[] | null;
  readonly runtimeLocation: string;
  readonly scheduleBackground: BackgroundScheduler;
  readonly downstreamAbortSignal?: AbortSignal;
  readonly clientStream: boolean;
  statefulResponsesStore: StatefulResponsesStore;
}

// Per-protocol api-side Interceptor aliases. They differ from the
// `Provider*Interceptor` aliases in `@floway-dev/provider` only in the request
// slot (`RequestContext` here vs the empty marker there); api-internal source
// and target interceptors read fields off `request` (apiKeyId,
// scheduleBackground, statefulResponsesStore, ...) so they need the rich type.
export type MessagesInterceptor = Interceptor<MessagesInvocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>;
export type ResponsesInterceptor = Interceptor<ResponsesInvocation, RequestContext, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
export type ChatCompletionsInterceptor = Interceptor<ChatCompletionsInvocation, RequestContext, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>;
export type GeminiInterceptor = Interceptor<GeminiInvocation, RequestContext, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. The interceptor chain still runs against a
// `MessagesInvocation` so payload-shaped reads (vision detection, last-message
// initiator classification, anthropic-beta filtering) match the chat path
// exactly. Interceptors registered here MUST be pure header/payload mutators;
// post-`run()` result inspection is not portable to this result type.
export type MessagesCountTokensInterceptor = Interceptor<MessagesInvocation, RequestContext, Response>;
