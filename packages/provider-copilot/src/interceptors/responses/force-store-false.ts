import type { ProviderResponsesInterceptor } from '@floway-dev/provider';

/**
 * Copilot's `/responses` rejects `store: true` with
 * `400 {"error":{"message":"store is not supported","code":"unsupported_value","param":"store"}}`.
 * Force `store: false` on the outgoing payload once planning has committed to
 * the Copilot Responses target so the upstream accepts the request. The
 * gateway's own stored-items persistence keys off the caller's original `store`
 * value captured at parse time and is unaffected by this upstream-only flag.
 */
export const withStoreForcedFalse: ProviderResponsesInterceptor = async (ctx, _request, run) => {
  ctx.payload = { ...ctx.payload, store: false };

  return await run();
};
