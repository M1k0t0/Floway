// Promote inline `system` role to `developer` in Responses input items for
// upstreams whose base system prompt belongs in top-level `instructions` and
// whose request history accepts developer-role instruction messages.
// Always-attached; flag-gated by `promote-system-to-developer`.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const promoteRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'system') return item;
  return { ...item, role: 'developer' as const };
};

const promoteInlineSystemRoles = (items: ResponsesInputItem[]): ResponsesInputItem[] => {
  let sawNonSystem = false;
  return items.map(item => {
    if (!isInputMessage(item)) {
      sawNonSystem = true;
      return item;
    }
    if (item.role === 'system') {
      return sawNonSystem ? promoteRole(item) : item;
    }
    sawNonSystem = true;
    return item;
  });
};

export const withPromoteSystemToDeveloper: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('promote-system-to-developer')) return await run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.targetApi === 'responses'
      ? promoteInlineSystemRoles(ctx.payload.input)
      : ctx.payload.input.map(promoteRole),
  };

  return await run();
};
