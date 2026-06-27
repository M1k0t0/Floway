import { test } from 'vitest';

import {
  beforeCodexResponsesSnapshotCommit,
  CODEX_CHILD_RESPONSE_ID_METADATA_KEY,
  CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY,
  CODEX_DOWNSTREAM_WINDOW_METADATA_KEY,
  CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY,
  CODEX_SESSION_METADATA_KEY,
  CODEX_WINDOW_METADATA_KEY,
  FLOWAY_CODEX_SESSION_ID_HEADER,
  FLOWAY_CODEX_TURN_ID_HEADER,
  FLOWAY_CODEX_WINDOW_ID_HEADER,
  prepareCodexResponsesRequest,
} from './responses-state.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ResponsesSnapshotState } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Most window-tracking tests below don't exercise the derive-from-input
// fallback, so a stub payload is enough — the session id comes from headers
// or snapshot metadata in those cases. Tests that DO want the derive path
// build their own payload inline.
const stubPayload: ResponsesPayload = { model: 'gpt-test', input: [] };

class MemoryResponsesSnapshotState implements ResponsesSnapshotState {
  readonly loadedUpdates: Record<string, unknown> = {};
  private readonly loaded: Record<string, unknown>;
  private readonly pending: Record<string, unknown> = {};

  constructor(loaded: Record<string, unknown> = {}) {
    this.loaded = structuredClone(loaded);
  }

  snapshot(): Record<string, unknown> {
    return { ...this.loaded, ...this.pending };
  }

  committedSnapshotMetadata(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.snapshot()).filter(([key]) => !Object.hasOwn(this.loadedUpdates, key)));
  }

  getSnapshotMetadata(name: string): unknown {
    if (Object.hasOwn(this.pending, name)) return this.pending[name];
    return this.loaded[name];
  }

  setSnapshotMetadata(name: string, value: unknown): void {
    this.pending[name] = structuredClone(value);
  }

  getLoadedSnapshotMetadata(name: string): unknown {
    return this.loaded[name];
  }

  setLoadedSnapshotMetadata(name: string, value: unknown): void {
    const cloned = structuredClone(value);
    this.loaded[name] = cloned;
    this.loadedUpdates[name] = cloned;
  }
}

test('prepareCodexResponsesRequest prefers official downstream session scope and scrubs forged private headers', async () => {
  const state = new MemoryResponsesSnapshotState({ [CODEX_SESSION_METADATA_KEY]: 'snapshot-session' });
  const headers = new Headers({
    [FLOWAY_CODEX_SESSION_ID_HEADER]: 'forged-session',
    [FLOWAY_CODEX_TURN_ID_HEADER]: 'forged-turn',
    [FLOWAY_CODEX_WINDOW_ID_HEADER]: 'forged-window',
    'session-id': 'caller-session',
    'x-codex-window-id': 'downstream-window-a',
  });

  await prepareCodexResponsesRequest({ headers, payload: stubPayload, snapshotState: state });

  assertEquals(headers.get(FLOWAY_CODEX_SESSION_ID_HEADER), 'caller-session');
  assertEquals(headers.get(FLOWAY_CODEX_WINDOW_ID_HEADER), 'caller-session:0');
  const turnId = headers.get(FLOWAY_CODEX_TURN_ID_HEADER);
  assert(turnId !== null && UUID_V7_RE.test(turnId), `expected UUIDv7 turn id, got ${turnId}`);
  assert(turnId !== 'forged-turn', 'expected forged private turn id to be replaced');
  assertEquals(headers.get('x-codex-window-id'), null);
  assertEquals(state.committedSnapshotMetadata(), {
    [CODEX_SESSION_METADATA_KEY]: 'caller-session',
    [CODEX_WINDOW_METADATA_KEY]: 'caller-session:0',
    [CODEX_DOWNSTREAM_WINDOW_METADATA_KEY]: 'downstream-window-a',
    [CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY]: false,
  });
});

test('prepareCodexResponsesRequest keeps turn id stable for repeated dispatches in one gateway attempt', async () => {
  const state = new MemoryResponsesSnapshotState({ [CODEX_SESSION_METADATA_KEY]: 'stable-session' });
  const headers = new Headers({ 'session-id': 'stable-session' });

  await prepareCodexResponsesRequest({ headers, payload: stubPayload, snapshotState: state });
  const firstTurnId = headers.get(FLOWAY_CODEX_TURN_ID_HEADER);
  assert(firstTurnId !== null && UUID_V7_RE.test(firstTurnId), `expected UUIDv7 turn id, got ${firstTurnId}`);

  headers.set(FLOWAY_CODEX_TURN_ID_HEADER, 'forged-retry-turn');
  await prepareCodexResponsesRequest({ headers, payload: stubPayload, snapshotState: state });

  assertEquals(headers.get(FLOWAY_CODEX_TURN_ID_HEADER), firstTurnId);
  assertEquals(state.committedSnapshotMetadata(), {
    [CODEX_SESSION_METADATA_KEY]: 'stable-session',
    [CODEX_WINDOW_METADATA_KEY]: 'stable-session:0',
    [CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY]: false,
  });
});

test('prepareCodexResponsesRequest advances window generation when a loaded snapshot was already continued', async () => {
  const parentMetadata = {
    [CODEX_SESSION_METADATA_KEY]: 'session-a',
    [CODEX_WINDOW_METADATA_KEY]: 'session-a:0',
  };
  const continuedParent = new MemoryResponsesSnapshotState(parentMetadata);
  await prepareCodexResponsesRequest({ headers: new Headers(), payload: stubPayload, snapshotState: continuedParent });
  beforeCodexResponsesSnapshotCommit({ snapshotState: continuedParent, snapshotMode: 'append', responseId: 'resp_turn_2' });

  assertEquals(continuedParent.loadedUpdates, {
    [CODEX_CHILD_RESPONSE_ID_METADATA_KEY]: 'resp_turn_2',
    [CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY]: 1,
  });

  const firstFork = new MemoryResponsesSnapshotState({
    ...parentMetadata,
    [CODEX_CHILD_RESPONSE_ID_METADATA_KEY]: 'resp_turn_2',
    [CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY]: 1,
  });
  const firstForkHeaders = new Headers();
  await prepareCodexResponsesRequest({ headers: firstForkHeaders, payload: stubPayload, snapshotState: firstFork });
  assertEquals(firstForkHeaders.get(FLOWAY_CODEX_WINDOW_ID_HEADER), 'session-a:1');
  beforeCodexResponsesSnapshotCommit({ snapshotState: firstFork, snapshotMode: 'append', responseId: 'resp_fork_1' });

  const secondFork = new MemoryResponsesSnapshotState({
    ...parentMetadata,
    [CODEX_CHILD_RESPONSE_ID_METADATA_KEY]: 'resp_fork_1',
    [CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY]: 2,
  });
  const secondForkHeaders = new Headers();
  await prepareCodexResponsesRequest({ headers: secondForkHeaders, payload: stubPayload, snapshotState: secondFork });
  assertEquals(secondForkHeaders.get(FLOWAY_CODEX_WINDOW_ID_HEADER), 'session-a:2');
});

test('beforeCodexResponsesSnapshotCommit advances stored window scope for replacement snapshots', async () => {
  const state = new MemoryResponsesSnapshotState({
    [CODEX_SESSION_METADATA_KEY]: 'session-a',
    [CODEX_WINDOW_METADATA_KEY]: 'session-a:0',
    [CODEX_DOWNSTREAM_WINDOW_METADATA_KEY]: 'session-a:0',
  });
  const headers = new Headers({ 'session-id': 'session-a', 'x-codex-window-id': 'session-a:0' });
  await prepareCodexResponsesRequest({ headers, payload: stubPayload, snapshotState: state });

  beforeCodexResponsesSnapshotCommit({ snapshotState: state, snapshotMode: 'replace', responseId: 'resp_compact' });

  assertEquals(state.committedSnapshotMetadata(), {
    [CODEX_SESSION_METADATA_KEY]: 'session-a',
    [CODEX_WINDOW_METADATA_KEY]: 'session-a:1',
    [CODEX_DOWNSTREAM_WINDOW_METADATA_KEY]: 'session-a:1',
    [CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY]: false,
  });
  assertEquals(state.loadedUpdates, {
    [CODEX_CHILD_RESPONSE_ID_METADATA_KEY]: 'resp_compact',
    [CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY]: 2,
  });
});

test('prepareCodexResponsesRequest derives a stable session-id from instructions + first input item when neither header nor snapshot has one', async () => {
  // Two turns of the same conversation: the second carries the original
  // first user message plus more tail items. The derived id must stay put
  // so chatgpt.com's prompt cache continues to hit across turns.
  const turn1State = new MemoryResponsesSnapshotState();
  const turn1Headers = new Headers();
  await prepareCodexResponsesRequest({
    headers: turn1Headers,
    payload: {
      model: 'gpt-test',
      instructions: 'You are helpful.',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    },
    snapshotState: turn1State,
  });

  const turn2State = new MemoryResponsesSnapshotState();
  const turn2Headers = new Headers();
  await prepareCodexResponsesRequest({
    headers: turn2Headers,
    payload: {
      model: 'gpt-test',
      instructions: 'You are helpful.',
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'assistant', content: 'hi' },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    },
    snapshotState: turn2State,
  });

  const sessionId = turn1Headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
  assert(sessionId !== null && UUID_RE.test(sessionId), `expected UUID, got ${sessionId}`);
  assertEquals(turn2Headers.get(FLOWAY_CODEX_SESSION_ID_HEADER), sessionId);
});

test('prepareCodexResponsesRequest derives different session-ids for different instructions', async () => {
  const headersA = new Headers();
  const headersB = new Headers();
  await prepareCodexResponsesRequest({
    headers: headersA,
    payload: { model: 'gpt-test', instructions: 'You are pirate.', input: 'hello' },
    snapshotState: new MemoryResponsesSnapshotState(),
  });
  await prepareCodexResponsesRequest({
    headers: headersB,
    payload: { model: 'gpt-test', instructions: 'You are scientist.', input: 'hello' },
    snapshotState: new MemoryResponsesSnapshotState(),
  });
  assert(
    headersA.get(FLOWAY_CODEX_SESSION_ID_HEADER) !== headersB.get(FLOWAY_CODEX_SESSION_ID_HEADER),
    'expected distinct session-ids — instructions must feed into the seed',
  );
});

test('prepareCodexResponsesRequest derives different session-ids for different first input items', async () => {
  const headersA = new Headers();
  const headersB = new Headers();
  await prepareCodexResponsesRequest({
    headers: headersA,
    payload: { model: 'gpt-test', instructions: 'Sys.', input: 'topic A' },
    snapshotState: new MemoryResponsesSnapshotState(),
  });
  await prepareCodexResponsesRequest({
    headers: headersB,
    payload: { model: 'gpt-test', instructions: 'Sys.', input: 'topic B' },
    snapshotState: new MemoryResponsesSnapshotState(),
  });
  assert(
    headersA.get(FLOWAY_CODEX_SESSION_ID_HEADER) !== headersB.get(FLOWAY_CODEX_SESSION_ID_HEADER),
    'expected distinct session-ids — first input item must feed into the seed',
  );
});

test('prepareCodexResponsesRequest derive seed is type-agnostic — post-compaction snapshots stay stable too', async () => {
  // Post-compaction stateful flow: the snapshot's compaction blob lands at
  // position 0 with no preceding user message. firstStableSeed must still
  // pick the compaction item so the new window's cache scope stays.
  const compactionItem = { type: 'compaction', id: 'cmp_a', encrypted_content: 'ENC' } as unknown as ResponsesPayload['input'] extends Array<infer X> ? X : never;
  const turn1Headers = new Headers();
  await prepareCodexResponsesRequest({
    headers: turn1Headers,
    payload: {
      model: 'gpt-test',
      instructions: 'Sys.',
      input: [
        compactionItem,
        { type: 'message', role: 'assistant', content: 'retained' },
        { type: 'message', role: 'user', content: 'first post-compact turn' },
      ],
    },
    snapshotState: new MemoryResponsesSnapshotState(),
  });
  const turn2Headers = new Headers();
  await prepareCodexResponsesRequest({
    headers: turn2Headers,
    payload: {
      model: 'gpt-test',
      instructions: 'Sys.',
      input: [
        compactionItem,
        { type: 'message', role: 'assistant', content: 'retained' },
        { type: 'message', role: 'user', content: 'first post-compact turn' },
        { type: 'message', role: 'assistant', content: 'reply' },
        { type: 'message', role: 'user', content: 'second post-compact turn' },
      ],
    },
    snapshotState: new MemoryResponsesSnapshotState(),
  });

  const sessionId = turn1Headers.get(FLOWAY_CODEX_SESSION_ID_HEADER);
  assert(sessionId !== null && UUID_RE.test(sessionId), `expected UUID, got ${sessionId}`);
  assertEquals(turn2Headers.get(FLOWAY_CODEX_SESSION_ID_HEADER), sessionId);
});

test('prepareCodexResponsesRequest falls back to UUIDv7 when the input array is empty', async () => {
  const headersA = new Headers();
  const headersB = new Headers();
  await prepareCodexResponsesRequest({ headers: headersA, payload: { model: 'gpt-test', input: [] }, snapshotState: new MemoryResponsesSnapshotState() });
  await prepareCodexResponsesRequest({ headers: headersB, payload: { model: 'gpt-test', input: [] }, snapshotState: new MemoryResponsesSnapshotState() });
  const a = headersA.get(FLOWAY_CODEX_SESSION_ID_HEADER);
  const b = headersB.get(FLOWAY_CODEX_SESSION_ID_HEADER);
  assert(a !== null && UUID_V7_RE.test(a), `expected UUIDv7, got ${a}`);
  assert(b !== null && UUID_V7_RE.test(b), `expected UUIDv7, got ${b}`);
  assert(a !== b, 'expected fresh fallback ids to differ between requests');
});
