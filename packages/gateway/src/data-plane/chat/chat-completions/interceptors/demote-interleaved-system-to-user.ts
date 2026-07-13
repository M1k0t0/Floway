import type { ChatCompletionsInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Workaround for upstreams (e.g. DeepSeek-R1) that reject `role: 'system'`
// after the first non-system message. The leading contiguous run of
// `system` messages is the only valid system position; once we cross into
// any non-system role, every later `role: 'system'` is rewritten to
// `role: 'user'` with content preserved.
export const withInterleavedSystemDemotedToUser: ChatCompletionsInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'chat-completions') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-interleaved-system-to-user')) return run();

  let crossedLeadingRun = false;
  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message => {
      if (!crossedLeadingRun && message.role !== 'system') crossedLeadingRun = true;
      if (crossedLeadingRun && message.role === 'system') return { ...message, role: 'user' as const };
      return message;
    }),
  };

  return run();
};
