// Demote `developer` to `system` at the Chat Completions target boundary for
// upstreams that do not recognise the developer role.

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { providerModelOf } from '@floway-dev/provider';

const demoteRole = (message: ChatCompletionsMessage): ChatCompletionsMessage => {
  if (message.role !== 'developer') return message;
  return { ...message, role: 'system' as const };
};

export const withDemoteDeveloperToSystem: ChatCompletionsInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'chat-completions') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-developer-to-system')) return run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(demoteRole),
  };

  return run();
};
