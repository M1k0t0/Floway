import type { ResponsesBoundaryCtx } from './types.ts';
import { sha256Uuid } from '../../ids.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER } from '../../responses-state.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { uuidV7 } from '@floway-dev/provider';

// Choose the Codex session scope before fetch.ts builds the upstream request.
// The provider-owned Responses state hook may pass a snapshot-bound scope
// through a private header; direct provider callers may pass the official
// `session-id` header themselves. `session_id` is accepted only as a
// compatibility alias and is removed before the upstream request.
//
// When neither path supplies a scope, derive a stable id from
// `instructions + first input item` so a stateless caller re-sending the
// full conversation each turn still hits chatgpt.com's prompt cache — the
// first item stays put as later turns append tail items, whereas hashing
// the whole input array would rotate the id every request. The first item
// stays first after compaction too (the snapshot's compaction blob lands
// at position 0), so the cache scope is stable inside each window.

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

  ctx.headers.set('session-id', await deriveSessionIdFromInput(ctx.payload) ?? uuidV7());
  return await run();
};

const deriveSessionIdFromInput = async (payload: ResponsesPayload): Promise<string | null> => {
  const firstItem = firstStableSeed(payload.input);
  if (firstItem === null) return null;
  const instructions = typeof payload.instructions === 'string' ? payload.instructions : '';
  // U+0001 separates the two seed components so an empty instructions can't
  // collide with the input prefix via string concatenation.
  return await sha256Uuid(`${instructions}${JSON.stringify(firstItem)}`);
};

// First non-trivial input item — type-agnostic so post-compaction snapshots
// (where the leading item is a `type: 'compaction'` blob with no user
// message before it) still produce a stable seed. Pre-compaction this is
// the conversation's first user message verbatim; after compaction it is
// the compaction blob, which is itself stable per snapshot.
const firstStableSeed = (input: ResponsesPayload['input']): unknown => {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    return item;
  }
  return null;
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};
