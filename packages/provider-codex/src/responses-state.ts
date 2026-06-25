import { uuidV7, type ProviderResponsesRequestContext, type ProviderResponsesSnapshotCommitContext, type ResponsesSnapshotState } from '@floway-dev/provider';

export const FLOWAY_CODEX_SESSION_ID_HEADER = 'x-floway-codex-session-id';
export const FLOWAY_CODEX_TURN_ID_HEADER = 'x-floway-codex-turn-id';
export const FLOWAY_CODEX_WINDOW_ID_HEADER = 'x-floway-codex-window-id';

export const CODEX_SESSION_METADATA_KEY = 'codex_session_id';
export const CODEX_WINDOW_METADATA_KEY = 'codex_window_id';
export const CODEX_DOWNSTREAM_WINDOW_METADATA_KEY = 'codex_downstream_window_id';
export const CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY = 'codex_downstream_window_advanced';
export const CODEX_CHILD_RESPONSE_ID_METADATA_KEY = 'codex_child_response_id';
export const CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY = 'codex_next_window_generation';

export const prepareCodexResponsesRequest = ({ headers, snapshotState }: ProviderResponsesRequestContext): void => {
  const downstreamWindowId = trimHeader(headers, 'x-codex-window-id');
  const downstreamSessionId = trimHeader(headers, 'session-id') ?? trimHeader(headers, 'session_id');
  headers.delete(FLOWAY_CODEX_SESSION_ID_HEADER);
  headers.delete(FLOWAY_CODEX_TURN_ID_HEADER);
  headers.delete(FLOWAY_CODEX_WINDOW_ID_HEADER);
  headers.delete('x-codex-window-id');

  const sessionId = ensureCodexSessionId(snapshotState, downstreamSessionId);
  headers.set(FLOWAY_CODEX_SESSION_ID_HEADER, sessionId);
  headers.set(FLOWAY_CODEX_TURN_ID_HEADER, uuidV7());
  headers.set(FLOWAY_CODEX_WINDOW_ID_HEADER, ensureCodexWindowId(snapshotState, sessionId, downstreamWindowId));
};

export const beforeCodexResponsesSnapshotCommit = ({ snapshotState, snapshotMode, responseId }: ProviderResponsesSnapshotCommitContext): void => {
  if (snapshotMode === 'replace') advanceCodexSnapshotWindowGeneration(snapshotState);
  markCodexSnapshotContinued(snapshotState, responseId);
};

const ensureCodexSessionId = (state: ResponsesSnapshotState, downstreamSessionId: string | null): string => {
  if (downstreamSessionId !== null) {
    state.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, downstreamSessionId);
    return downstreamSessionId;
  }
  const existing = stringMetadata(state, CODEX_SESSION_METADATA_KEY);
  if (existing !== null) return existing;
  const sessionId = uuidV7();
  state.setSnapshotMetadata(CODEX_SESSION_METADATA_KEY, sessionId);
  return sessionId;
};

const ensureCodexWindowId = (state: ResponsesSnapshotState, sessionId: string, downstreamWindowId: string | null): string => {
  const existingWindowId = codexWindowMetadata(state, sessionId);
  const existingDownstreamWindowId = stringMetadata(state, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);
  const downstreamWindowAlreadyAdvanced = state.getSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY) === true;
  const forkedFromLoadedSnapshot = loadedStringMetadata(state, CODEX_CHILD_RESPONSE_ID_METADATA_KEY) !== null;
  const nextWindowGeneration = loadedNumberMetadata(state, CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY);

  if (downstreamWindowId !== null) {
    if (!forkedFromLoadedSnapshot && existingWindowId !== null && existingDownstreamWindowId === downstreamWindowId) return existingWindowId;
    if (existingWindowId !== null && downstreamWindowAlreadyAdvanced) {
      state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
      state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
      return existingWindowId;
    }
    const windowId = nextCodexWindowId(sessionId, existingWindowId, nextWindowGeneration);
    state.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
    state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, downstreamWindowId);
    state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
    return windowId;
  }

  if (existingWindowId !== null) {
    if (!forkedFromLoadedSnapshot) return existingWindowId;
    const windowId = nextCodexWindowId(sessionId, existingWindowId, nextWindowGeneration);
    state.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
    state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
    return windowId;
  }
  const windowId = formatCodexWindowId(sessionId, 0);
  state.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, windowId);
  state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
  return windowId;
};

const advanceCodexSnapshotWindowGeneration = (state: ResponsesSnapshotState): void => {
  const sessionId = stringMetadata(state, CODEX_SESSION_METADATA_KEY);
  if (sessionId === null) return;
  const existingWindowId = codexWindowMetadata(state, sessionId);
  const existingGeneration = existingWindowId === null ? 0 : codexWindowGeneration(existingWindowId, sessionId);
  const nextWindowId = formatCodexWindowId(sessionId, existingGeneration === null ? 1 : existingGeneration + 1);
  state.setSnapshotMetadata(CODEX_WINDOW_METADATA_KEY, nextWindowId);

  const downstreamWindowId = stringMetadata(state, CODEX_DOWNSTREAM_WINDOW_METADATA_KEY);
  const nextDownstreamWindowId = downstreamWindowId === null ? null : advanceWindowId(downstreamWindowId);
  if (nextDownstreamWindowId !== null) {
    state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_METADATA_KEY, nextDownstreamWindowId);
    state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, false);
    return;
  }
  if (downstreamWindowId !== null) state.setSnapshotMetadata(CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY, true);
};

const markCodexSnapshotContinued = (state: ResponsesSnapshotState, childResponseId: string): void => {
  const sessionId = stringMetadata(state, CODEX_SESSION_METADATA_KEY);
  if (sessionId === null) return;
  const windowId = stringMetadata(state, CODEX_WINDOW_METADATA_KEY);
  const childGeneration = windowId === null ? null : codexWindowGeneration(windowId, sessionId);
  const existingNextGeneration = loadedNumberMetadata(state, CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY);
  state.setLoadedSnapshotMetadata(CODEX_CHILD_RESPONSE_ID_METADATA_KEY, childResponseId);
  if (childGeneration !== null || existingNextGeneration !== null) {
    state.setLoadedSnapshotMetadata(
      CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY,
      Math.max(existingNextGeneration ?? 0, childGeneration === null ? 0 : childGeneration + 1),
    );
  }
};

const codexWindowMetadata = (state: ResponsesSnapshotState, sessionId: string): string | null => {
  const value = stringMetadata(state, CODEX_WINDOW_METADATA_KEY);
  return value !== null && codexWindowGeneration(value, sessionId) !== null ? value : null;
};

const formatCodexWindowId = (sessionId: string, generation: number): string => `${sessionId}:${generation}`;

const nextCodexWindowId = (sessionId: string, existingWindowId: string | null, minimumGeneration: number | null): string => {
  const existingGeneration = existingWindowId === null ? null : codexWindowGeneration(existingWindowId, sessionId);
  const nextGeneration = existingGeneration === null ? 0 : existingGeneration + 1;
  return formatCodexWindowId(sessionId, Math.max(nextGeneration, minimumGeneration ?? 0));
};

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

const stringMetadata = (state: ResponsesSnapshotState, key: string): string | null => {
  const value = state.getSnapshotMetadata(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const loadedStringMetadata = (state: ResponsesSnapshotState, key: string): string | null => {
  const value = state.getLoadedSnapshotMetadata(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const loadedNumberMetadata = (state: ResponsesSnapshotState, key: string): number | null => {
  const value = state.getLoadedSnapshotMetadata(key);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? '';
  return value.length > 0 ? value : null;
};
