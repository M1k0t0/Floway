import type { ResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Workaround for upstreams (e.g. DeepSeek-R1) that reject `role: 'system'`
// after the first non-system message. The Responses input is a mixed
// sequence of message items (with a `role`) and non-message items
// (reasoning, function_call, function_call_output, …). The leading
// contiguous run of `role: 'system'` message items is the only valid
// system position; once we cross into anything else — a user/assistant/
// developer message or any non-message item — every later
// `role: 'system'` message item is rewritten to `role: 'user'` with its
// content kept verbatim.
export const withInterleavedSystemDemotedToUser: ResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'responses') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-interleaved-system-to-user')) return run();

  let crossedLeadingRun = false;
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      const isSystemMessage = item.type === 'message' && item.role === 'system';
      if (!crossedLeadingRun && !isSystemMessage) crossedLeadingRun = true;
      if (crossedLeadingRun && isSystemMessage) return { ...item, role: 'user' as const };
      return item;
    }),
  };

  return run();
};
