import type { ResponsesBoundaryCtx } from './types.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER, uuidV7 } from '@floway-dev/provider';

// Codex uses the conversation id as the session/thread cache scope. The
// gateway may provide a Floway-owned internal session id; direct provider calls
// can still supply the official `session-id` header.
//
// Prefer Floway's snapshot-bound Codex session when present. Otherwise accept
// the official `session-id` header verbatim, normalize the legacy `session_id`
// alias, or synthesize Codex's UUIDv7-shaped session/thread id for a new turn.

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
