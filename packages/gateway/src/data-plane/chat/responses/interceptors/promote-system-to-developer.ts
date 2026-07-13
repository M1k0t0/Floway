// Promote `system` to `developer` for upstreams that reject system-role input
// messages while accepting the developer role.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const promoteRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'system') return item;
  return { ...item, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ResponsesInterceptor = async (ctx, _request, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('promote-system-to-developer')) return await run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(promoteRole),
  };

  return await run();
};
