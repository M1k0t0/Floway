import type { StatefulResponsesStore } from './items/store.ts';
import type { ProviderCandidate } from '@floway-dev/provider';
import { FLOWAY_CODEX_SESSION_ID_HEADER, FLOWAY_CODEX_TURN_ID_HEADER, FLOWAY_CODEX_WINDOW_ID_HEADER, uuidV7 } from '@floway-dev/provider';

const CODEX_SESSION_METADATA_KEY = 'codex_session_id';
const CODEX_WINDOW_METADATA_KEY = 'codex_window_id';
const CODEX_DOWNSTREAM_WINDOW_METADATA_KEY = 'codex_downstream_window_id';
const CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY = 'codex_downstream_window_advanced';

export const attachCodexSessionHeader = (
  candidate: ProviderCandidate,
  store: StatefulResponsesStore,
  headers: Headers,
): void => {
  if (candidate.provider.providerKind !== 'codex') {
    headers.delete(FLOWAY_CODEX_SESSION_ID_HEADER);
    headers.delete(FLOWAY_CODEX_TURN_ID_HEADER);
    headers.delete(FLOWAY_CODEX_WINDOW_ID_HEADER);
    return;
  }
  const downstreamWindowId = trimHeader(headers, 'x-codex-window-id');
  const downstreamSessionId = trimHeader(headers, 'session-id') ?? trimHeader(headers, 'session_id');
  headers.delete('x-codex-window-id');
  const sessionId = ensureCodexSessionId(store, downstreamSessionId);
  headers.set(FLOWAY_CODEX_SESSION_ID_HEADER, sessionId);
  headers.set(FLOWAY_CODEX_TURN_ID_HEADER, ensureCodexTurnId(headers));
  headers.set(FLOWAY_CODEX_WINDOW_ID_HEADER, ensureCodexWindowId(store, sessionId, downstreamWindowId));
};

const ensureCodexSessionId = (store: StatefulResponsesStore, downstreamSessionId: string | null): string => {
  if (downstreamSessionId !== null) {
    store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, downstreamSessionId);
    return downstreamSessionId;
  }
  const existing = store.getSnapshotMetadata(CODEX_SESSION_METADATA_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const sessionId = uuidV7();
  store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, sessionId);
  return sessionId;
};

const ensureCodexTurnId = (headers: Headers): string =>
  trimHeader(headers, FLOWAY_CODEX_TURN_ID_HEADER) ?? uuidV7();

const ensureCodexWindowId = (store: StatefulResponsesStore, sessionId: string, downstreamWindowId: string | null): string => {
  const existingWindowId = codexWindowMetadata(store, sessionId);
  const existingDownstreamWindowId = stringMetadata(store, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);
  const downstreamWindowAlreadyAdvanced = store.getSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY) === true;

  if (downstreamWindowId !== null) {
    if (existingWindowId !== null && existingDownstreamWindowId === downstreamWindowId) return existingWindowId;
    if (existingWindowId !== null && downstreamWindowAlreadyAdvanced) {
      store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
      store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
      return existingWindowId;
    }
    const existingGeneration = existingWindowId === null ? null : codexWindowGeneration(existingWindowId, sessionId);
    const windowId = formatCodexWindowId(sessionId, existingGeneration === null ? 0 : existingGeneration + 1);
    store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
    return windowId;
  }

  if (existingWindowId !== null) return existingWindowId;
  const windowId = formatCodexWindowId(sessionId, 0);
  store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
  store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
  return windowId;
};

export const advanceCodexSnapshotWindowGeneration = (store: StatefulResponsesStore): void => {
  const sessionId = stringMetadata(store, CODEX_SESSION_METADATA_KEY);
  if (sessionId === null) return;
  const existingWindowId = codexWindowMetadata(store, sessionId);
  const existingGeneration = existingWindowId === null ? 0 : codexWindowGeneration(existingWindowId, sessionId);
  const nextWindowId = formatCodexWindowId(sessionId, existingGeneration === null ? 1 : existingGeneration + 1);
  store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, nextWindowId);

  const downstreamWindowId = stringMetadata(store, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);
  const nextDownstreamWindowId = downstreamWindowId === null ? null : advanceWindowId(downstreamWindowId);
  if (nextDownstreamWindowId !== null) {
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, nextDownstreamWindowId);
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
    return;
  }
  if (downstreamWindowId !== null) store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, true);
};

const codexWindowMetadata = (store: StatefulResponsesStore, sessionId: string): string | null => {
  const value = stringMetadata(store, CODEX_WINDOW_METADATA_KEY);
  return value !== null && codexWindowGeneration(value, sessionId) !== null ? value : null;
};

const formatCodexWindowId = (sessionId: string, generation: number): string => `${sessionId}:${generation}`;

const advanceWindowId = (windowId: string): string | null => {
  const match = /^(.*):(0|[1-9]\d*)$/.exec(windowId);
  if (match === null) return null;
  const [, prefix, generationText] = match;
  if (prefix === undefined || generationText === undefined) return null;
  const generation = Number(generationText);
  return Number.isSafeInteger(generation) ? `${prefix}:${generation + 1}` : null;
};

const codexWindowGeneration = (windowId: string, sessionId: string): number | null => {
  const prefix = `${sessionId}:`;
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
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};
