// Promote `system` role to `developer` for upstreams whose base system prompt
// belongs in a top-level field and whose message history accepts
// developer-role instruction messages. Always-attached; flag-gated by
// `promote-system-to-developer`.

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

const promoteRole = (message: ChatCompletionsMessage): ChatCompletionsMessage => {
  if (message.role !== 'system') return message;
  return { ...message, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('promote-system-to-developer')) return await run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(promoteRole),
  };

  return await run();
};
