import type { UpstreamModel } from './model.ts';
import type { ProviderTargetInterceptors } from './provider.ts';
import type { ExecuteResult } from './result.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesStreamEvent, ResponsesPayload } from '@floway-dev/protocols/responses';

export type LlmSourceApi = 'messages' | 'responses' | 'chat-completions' | 'gemini';
export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

// Marker the per-protocol Interceptor aliases use for their `request` slot.
// Provider-layer interceptors do not read fields off `request` — the api side
// supplies a richer context object that structurally satisfies this empty
// marker, so an api-side interceptor typed against the richer context remains
// assignable when it is sliced into a provider-side list (parameter types are
// contravariant: a function accepting `{}` accepts any concrete request).
export interface InterceptorRequest {}

// Per-provider-binding-attempt request-side description. Rebuilt for every
// binding the planner tries inside one client request.
//
// - sourceApi / targetApi: the protocol the client spoke and the protocol
//   the planner picked for this binding.
// - model: the resolved public model id.
// - upstream / upstreamModel / provider: the planner's binding choice.
// - enabledFlags: the effective flag set for this binding.
// - targetInterceptors: the provider-registered target interceptor table.
// - payload: the source-shape request body, mutable so source interceptors
//   can clean it.
// - headers: mutable HTTP-header bag the source serve seeds empty and target
//   interceptors populate. The provider's upstream call passes it through to
//   the wire fetch unchanged, so workarounds that only need to set or drop a
//   header (vision, initiator, anthropic-beta, ...) stay at the owning
//   interceptor boundary instead of widening the provider call signature.
//
// Named `Invocation` (not `Exchange`) because "exchange" implies a
// request/response pair; this object carries only the request side plus the
// planner's binding decisions. The response flows through `ExecuteResult`,
// not back through `Invocation`.
export interface Invocation<TPayload> {
  readonly sourceApi: LlmSourceApi;
  readonly targetApi: LlmTargetApi;
  readonly model: string;
  readonly upstream: string;
  readonly upstreamModel: UpstreamModel;
  readonly provider: import('./provider.ts').ModelProvider;
  readonly enabledFlags: ReadonlySet<string>;
  readonly targetInterceptors?: ProviderTargetInterceptors;
  payload: TPayload;
  headers: Record<string, string>;
}

export interface MessagesInvocation extends Invocation<MessagesPayload> {
  readonly anthropicBeta?: readonly string[];
}
export type ResponsesInvocation = Invocation<ResponsesPayload>;
export type ChatCompletionsInvocation = Invocation<ChatCompletionsPayload>;
export type GeminiInvocation = Invocation<GeminiPayload>;

// `Provider*Interceptor` aliases are the LOOSE form: typed against
// `InterceptorRequest = {}`, so an interceptor function declared with these
// types accepts any request object (per parameter contravariance). Provider
// packages ship interceptors at this width because they never read fields off
// `request`. The api side defines its own rich-context `MessagesInterceptor`
// etc. against `RequestContext`; per contravariance, the loose provider
// interceptors are assignable to those rich slots, so spread composition
// (`[...baseInterceptors, ...providerInterceptors]`) just works.
export type ProviderMessagesInterceptor = Interceptor<MessagesInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>;
export type ProviderResponsesInterceptor = Interceptor<ResponsesInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
export type ProviderChatCompletionsInterceptor = Interceptor<ChatCompletionsInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>>;
export type ProviderGeminiInterceptor = Interceptor<GeminiInvocation, InterceptorRequest, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. Interceptors registered here MUST be pure
// header/payload mutators; post-`run()` result inspection is not portable to
// this result type.
export type ProviderMessagesCountTokensInterceptor = Interceptor<MessagesInvocation, InterceptorRequest, Response>;
