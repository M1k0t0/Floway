import type { StatefulResponsesStore } from './items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER, FLOWAY_CODEX_WINDOW_ID_HEADER, uuidV7 } from '@floway-dev/provider';

const CODEX_SESSION_METADATA_KEY = 'codex_session_id';
const CODEX_WINDOW_METADATA_KEY = 'codex_window_id';
const CODEX_DOWNSTREAM_WINDOW_METADATA_KEY = 'codex_downstream_window_id';

export const attachCodexSessionHeader = (
  candidate: ProviderCandidate,
  store: StatefulResponsesStore,
  headers: Headers,
): void => {
  if (candidate.binding.providerKind !== 'codex') {
    headers.delete(FLOWAY_CODEX_SESSION_ID_HEADER);
    headers.delete(FLOWAY_CODEX_WINDOW_ID_HEADER);
    return;
  }
  const downstreamWindowId = trimHeader(headers, 'x-codex-window-id');
  headers.delete('x-codex-window-id');
  headers.set(FLOWAY_CODEX_SESSION_ID_HEADER, ensureCodexSessionId(store));
  headers.set(FLOWAY_CODEX_WINDOW_ID_HEADER, ensureCodexWindowId(store, downstreamWindowId));
};

const ensureCodexSessionId = (store: StatefulResponsesStore): string => {
  const existing = store.getSnapshotMetadata(CODEX_SESSION_METADATA_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const sessionId = uuidV7();
  store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, sessionId);
  return sessionId;
};

const ensureCodexWindowId = (store: StatefulResponsesStore, downstreamWindowId: string | null): string => {
  const existingWindowId = stringMetadata(store, CODEX_WINDOW_METADATA_KEY);
  const existingDownstreamWindowId = stringMetadata(store, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);

  if (downstreamWindowId !== null) {
    if (existingWindowId !== null && existingDownstreamWindowId === downstreamWindowId) return existingWindowId;
    const windowId = uuidV7();
    store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
    store.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
    return windowId;
  }

  if (existingWindowId !== null) return existingWindowId;
  const windowId = uuidV7();
  store.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
  return windowId;
};

const stringMetadata = (store: StatefulResponsesStore, key: string): string | null => {
  const value = store.getSnapshotMetadata(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim();
  return value || null;
};
