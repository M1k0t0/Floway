import type { MessagesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Workaround for upstreams (e.g. DeepSeek-R1) that reject `role: 'system'`
// after the first non-system message. Anthropic Messages carries the
// conceptually-first system slot on the top-level `payload.system` field;
// any inline message with `role: 'system'` is therefore by definition
// interleaved, and gets demoted to `role: 'user'` with content preserved.
export const withInterleavedSystemDemotedToUser: MessagesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'messages') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-interleaved-system-to-user')) return run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message =>
      message.role === 'system' ? { role: 'user' as const, content: message.content } : message),
  };

  return run();
};
