import type { ResponsesBoundaryCtx } from './types.ts';

// Codex backend rejects /responses requests that lack a non-empty
// `instructions` field with a 4xx ("Instructions are required"). Native
// /v1/responses callers may omit it, and translated requests may have neither
// caller-supplied instructions nor a hoistable leading developer prefix after
// the required system-to-developer conversion. Inject a neutral default at the
// Codex target boundary so every request shape satisfies the upstream contract.
export const injectDefaultInstructions = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const instructions = ctx.payload.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) {
    ctx.payload = { ...ctx.payload, instructions: "You're a helpful assistant." };
  }
  return await run();
};
