// Demote `developer` to `system` at the Responses target boundary for
// upstreams that do not recognise the developer role.

import type { ResponsesInterceptor } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const demoteRole = (item: ResponsesInputItem): ResponsesInputItem => {
  if (!isInputMessage(item) || item.role !== 'developer') return item;
  return { ...item, role: 'system' as const };
};

export const withDemoteDeveloperToSystem: ResponsesInterceptor = (ctx, _request, run) => {
  if (ctx.targetApi !== 'responses') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-developer-to-system')) return run();

  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(demoteRole),
  };

  return run();
};
