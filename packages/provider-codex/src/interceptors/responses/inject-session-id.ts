import type { ResponsesBoundaryCtx } from './types.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER, uuidV7 } from '@floway-dev/provider';

// Choose the Codex session scope before fetch.ts builds the upstream request.
// Gateway-dispatched Codex Responses calls pass Floway's snapshot-bound scope
// through an internal header; direct provider callers may pass the official
// `session-id` header themselves. `session_id` is accepted only as a
// compatibility alias and is removed before the upstream request.
//
// fetch.ts uses this session id as the Codex thread id, x-client-request-id,
// and default prompt_cache_key. If no caller supplies a scope, synthesize a
// fresh UUIDv7-shaped id for this standalone request instead of deriving one
// from prompt text.

export const injectSessionId = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const suppliedSessionId = trimHeader(ctx.headers, FLOWAY_CODEX_SESSION_ID_HEADER)
    ?? trimHeader(ctx.headers, 'session-id')
    ?? trimHeader(ctx.headers, 'session_id');
  if (suppliedSessionId) {
    ctx.headers.set('session-id', suppliedSessionId);
    ctx.headers.delete('session_id');
    return await run();
  }

  ctx.headers.set('session-id', uuidV7());
  return await run();
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  return value || null;
};
