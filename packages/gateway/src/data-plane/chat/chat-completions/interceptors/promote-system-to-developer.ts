// Promote `system` to `developer` for upstreams that reject system-role input
// messages while accepting the developer role. Translated requests defer the
// rewrite to the selected target protocol so pairwise translation keeps its
// normal instruction-placement semantics.

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { providerModelOf } from '@floway-dev/provider';

const promoteRole = (message: ChatCompletionsMessage): ChatCompletionsMessage => {
  if (message.role !== 'system') return message;
  return { ...message, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ChatCompletionsInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'chat-completions') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('promote-system-to-developer')) return run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(promoteRole),
  };

  return run();
};
