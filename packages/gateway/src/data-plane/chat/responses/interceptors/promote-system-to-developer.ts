// Promote `system` to `developer` for upstreams that reject system-role input
// messages while accepting the developer role. Translated requests defer the
// rewrite to the selected target protocol so pairwise translation keeps its
// normal instruction-placement semantics.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const promoteRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'system') return item;
  return { ...item, role: 'developer' as const };
};

export const withPromoteSystemToDeveloper: ResponsesInterceptor = (ctx, _request, run) => {
  if (ctx.targetApi !== 'responses') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('promote-system-to-developer')) return run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(promoteRole),
  };

  return run();
};
