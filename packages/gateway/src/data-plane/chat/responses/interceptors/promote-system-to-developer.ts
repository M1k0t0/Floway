// Promote inline `system` role to `developer` in Responses input items for
// upstreams whose base system prompt belongs in top-level `instructions` and
// whose request history accepts developer-role instruction messages.
// Always-attached; flag-gated by `promote-system-to-developer`.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const promoteRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'system') return item;
  return { ...item, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!ctx.candidate.model.enabledFlags.has('promote-system-to-developer')) return await run();

  if (Array.isArray(ctx.payload.input)) {
    ctx.payload = {
      ...ctx.payload,
      input: ctx.payload.input.map(promoteRole),
    };
  }

  return await run();
};
