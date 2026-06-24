import type { StatefulResponsesStore } from './items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER, FLOWAY_CODEX_THREAD_ID_HEADER, FLOWAY_CODEX_WINDOW_ID_HEADER, uuidV7 } from '@floway-dev/provider';

const CODEX_SESSION_METADATA_KEY = 'codex_session_id';
const CODEX_THREAD_METADATA_KEY = 'codex_thread_id';
const CODEX_WINDOW_METADATA_KEY = 'codex_window_id';
const CODEX_DOWNSTREAM_WINDOW_METADATA_KEY = 'codex_downstream_window_id';

export const attachCodexSessionHeader = (
  candidate: ProviderCandidate,
  store: StatefulResponsesStore,
  headers: Headers,
): void => {
  if (candidate.binding.providerKind !== 'codex') {
    headers.delete(FLOWAY_CODEX_SESSION_ID_HEADER);
    headers.delete(FLOWAY_CODEX_THREAD_ID_HEADER);
    headers.delete(FLOWAY_CODEX_WINDOW_ID_HEADER);
    return;
  }
  const downstreamSessionId = trimHeader(headers, 'session-id') ?? trimHeader(headers, 'session_id');
  const downstreamThreadId = trimHeader(headers, 'thread-id') ?? trimHeader(headers, 'x-client-request-id');
  const downstreamWindowId = trimHeader(headers, 'x-codex-window-id');
  headers.delete('x-codex-window-id');
  const sessionId = ensureCodexSessionId(store, downstreamSessionId);
  const threadId = ensureCodexThreadId(store, sessionId, downstreamThreadId);
  headers.set(FLOWAY_CODEX_SESSION_ID_HEADER, sessionId);
  headers.set(FLOWAY_CODEX_THREAD_ID_HEADER, threadId);
  headers.set(FLOWAY_CODEX_WINDOW_ID_HEADER, ensureCodexWindowId(store, threadId, downstreamWindowId));
};

const ensureCodexSessionId = (store: StatefulResponsesStore, downstreamSessionId: string | null): string => {
  if (downstreamSessionId !== null) {
    store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, downstreamSessionId);
    return downstreamSessionId;
  }
  const existing = stringMetadata(store, CODEX_SESSION_METADATA_KEY);
  if (existing !== null) return existing;
  const sessionId = uuidV7();
  store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, sessionId);
  return sessionId;
};

const ensureCodexThreadId = (store: StatefulResponsesStore, sessionId: string, downstreamThreadId: string | null): string => {
  if (downstreamThreadId !== null) {
    store.setSnapshotMetadata(CODEX_THREAD_METADATA_KEY, downstreamThreadId);
    return downstreamThreadId;
  }
  const existing = stringMetadata(store, CODEX_THREAD_METADATA_KEY);
  if (existing !== null) return existing;
  store.setSnapshotMetadata(CODEX_THREAD_METADATA_KEY, sessionId);
  return sessionId;
};

const ensureCodexWindowId = (store: StatefulResponsesStore, threadId: string, downstreamWindowId: string | null): string => {
  const existingWindowId = codexWindowMetadata(store, threadId);
  const existingDownstreamWindowId = stringMetadata(store, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);

  if (downstreamWindowId !== null) {
    if (codexWindowGeneration(downstreamWindowId, threadId) !== null) {
      store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, downstreamWindowId);
      store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
      return downstreamWindowId;
    }
    if (existingWindowId !== null && existingDownstreamWindowId === downstreamWindowId) return existingWindowId;
    const existingGeneration = existingWindowId === null ? null : codexWindowGeneration(existingWindowId, threadId);
    const windowId = formatCodexWindowId(threadId, existingGeneration === null ? 0 : existingGeneration + 1);
    store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
    return windowId;
  }

  if (existingWindowId !== null) return existingWindowId;
  const windowId = formatCodexWindowId(threadId, 0);
  store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
  return windowId;
};

const codexWindowMetadata = (store: StatefulResponsesStore, threadId: string): string | null => {
  const value = stringMetadata(store, CODEX_WINDOW_METADATA_KEY);
  return value !== null && codexWindowGeneration(value, threadId) !== null ? value : null;
};

const formatCodexWindowId = (threadId: string, generation: number): string => `${threadId}:${generation}`;

const codexWindowGeneration = (windowId: string, threadId: string): number | null => {
  const prefix = `${threadId}:`;
  if (!windowId.startsWith(prefix)) return null;
  const generationText = windowId.slice(prefix.length);
  if (!/^(0|[1-9]\d*)$/.test(generationText)) return null;
  const generation = Number(generationText);
  return Number.isSafeInteger(generation) ? generation : null;
};

const stringMetadata = (store: StatefulResponsesStore, key: string): string | null => {
  const value = store.getSnapshotMetadata(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  return value || null;
};
