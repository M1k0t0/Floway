import type { StatefulResponsesStore } from './items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { FLOWAY_CODEX_SESSION_ID_HEADER, uuidV7 } from '@floway-dev/provider';

const CODEX_SESSION_METADATA_KEY = 'codex_session_id';

export const attachCodexSessionHeader = (
  candidate: ProviderCandidate,
  store: StatefulResponsesStore,
  headers: Headers,
): void => {
  if (candidate.binding.providerKind !== 'codex') {
    headers.delete(FLOWAY_CODEX_SESSION_ID_HEADER);
    return;
  }
  headers.set(FLOWAY_CODEX_SESSION_ID_HEADER, ensureCodexSessionId(store));
};

const ensureCodexSessionId = (store: StatefulResponsesStore): string => {
  const existing = store.getSnapshotMetadata(CODEX_SESSION_METADATA_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const sessionId = uuidV7();
  store.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, sessionId);
  return sessionId;
};
