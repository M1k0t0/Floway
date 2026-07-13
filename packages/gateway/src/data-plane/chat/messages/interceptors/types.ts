import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor, InterceptorRun } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, MessagesInvocation } from '@floway-dev/provider';

export type { MessagesInvocation };

export type MessagesInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. The interceptor chain still runs against a
// `MessagesInvocation` so payload-shaped reads (vision detection, last-message
// initiator classification, anthropic-beta filtering) match the chat path
// exactly. Interceptors registered here MUST be pure header/payload mutators;
// post-`run()` result inspection is not portable to this result type.
export type MessagesCountTokensInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  Response
>;

// Payload-only transforms can run in both the streaming generation chain and
// the one-shot count_tokens chain. Keeping the result generic prevents those
// shared interceptors from accidentally inspecting either result shape.
export type MessagesPayloadInterceptor = <TResult>(
  ctx: MessagesInvocation,
  gatewayCtx: GatewayCtx,
  run: InterceptorRun<TResult>,
) => Promise<TResult>;
