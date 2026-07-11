// Promote `system` to `developer` before dispatch or translation to upstreams
// that reject system-role input messages, including Codex Responses. The Codex
// provider boundary then hoists only a contiguous leading text-representable
// developer prefix into `instructions`; later developer messages remain inline.
// Always-attached; flag-gated by `promote-system-to-developer`.

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { providerModelOf } from '@floway-dev/provider';

const promoteRole = (message: ChatCompletionsMessage): ChatCompletionsMessage => {
  if (message.role !== 'system') return message;
  return { ...message, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('promote-system-to-developer')) return await run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(promoteRole),
  };

  return await run();
};
