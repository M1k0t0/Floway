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
import type { ResponsesSnapshotState } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

test('prepareCodexResponsesRequest prefers official downstream session scope and scrubs forged private headers', () => {
  const state = new MemoryResponsesSnapshotState({ [CODEX_SESSION_METADATA_KEY]: 'snapshot-session' });
  const headers = new Headers({
    [FLOWAY_CODEX_SESSION_ID_HEADER]: 'forged-session',
    [FLOWAY_CODEX_TURN_ID_HEADER]: 'forged-turn',
    [FLOWAY_CODEX_WINDOW_ID_HEADER]: 'forged-window',
    'session-id': 'caller-session',
    'x-codex-window-id': 'downstream-window-a',
  });

  prepareCodexResponsesRequest({ headers, snapshotState: state });

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

test('prepareCodexResponsesRequest keeps turn id stable for repeated dispatches in one gateway attempt', () => {
  const state = new MemoryResponsesSnapshotState({ [CODEX_SESSION_METADATA_KEY]: 'stable-session' });
  const headers = new Headers({ 'session-id': 'stable-session' });

  prepareCodexResponsesRequest({ headers, snapshotState: state });
  const firstTurnId = headers.get(FLOWAY_CODEX_TURN_ID_HEADER);
  assert(firstTurnId !== null && UUID_V7_RE.test(firstTurnId), `expected UUIDv7 turn id, got ${firstTurnId}`);

  headers.set(FLOWAY_CODEX_TURN_ID_HEADER, 'forged-retry-turn');
  prepareCodexResponsesRequest({ headers, snapshotState: state });

  assertEquals(headers.get(FLOWAY_CODEX_TURN_ID_HEADER), firstTurnId);
  assertEquals(state.committedSnapshotMetadata(), {
    [CODEX_SESSION_METADATA_KEY]: 'stable-session',
    [CODEX_WINDOW_METADATA_KEY]: 'stable-session:0',
    [CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY]: false,
  });
});

test('prepareCodexResponsesRequest advances window generation when a loaded snapshot was already continued', () => {
  const parentMetadata = {
    [CODEX_SESSION_METADATA_KEY]: 'session-a',
    [CODEX_WINDOW_METADATA_KEY]: 'session-a:0',
  };
  const continuedParent = new MemoryResponsesSnapshotState(parentMetadata);
  prepareCodexResponsesRequest({ headers: new Headers(), snapshotState: continuedParent });
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
  prepareCodexResponsesRequest({ headers: firstForkHeaders, snapshotState: firstFork });
  assertEquals(firstForkHeaders.get(FLOWAY_CODEX_WINDOW_ID_HEADER), 'session-a:1');
  beforeCodexResponsesSnapshotCommit({ snapshotState: firstFork, snapshotMode: 'append', responseId: 'resp_fork_1' });

  const secondFork = new MemoryResponsesSnapshotState({
    ...parentMetadata,
    [CODEX_CHILD_RESPONSE_ID_METADATA_KEY]: 'resp_fork_1',
    [CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY]: 2,
  });
  const secondForkHeaders = new Headers();
  prepareCodexResponsesRequest({ headers: secondForkHeaders, snapshotState: secondFork });
  assertEquals(secondForkHeaders.get(FLOWAY_CODEX_WINDOW_ID_HEADER), 'session-a:2');
});

test('beforeCodexResponsesSnapshotCommit advances stored window scope for replacement snapshots', () => {
  const state = new MemoryResponsesSnapshotState({
    [CODEX_SESSION_METADATA_KEY]: 'session-a',
    [CODEX_WINDOW_METADATA_KEY]: 'session-a:0',
    [CODEX_DOWNSTREAM_WINDOW_METADATA_KEY]: 'session-a:0',
  });
  const headers = new Headers({ 'session-id': 'session-a', 'x-codex-window-id': 'session-a:0' });
  prepareCodexResponsesRequest({ headers, snapshotState: state });

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
