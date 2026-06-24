export const CODEX_SESSION_METADATA_KEY = 'codex_session_id';
export const CODEX_WINDOW_METADATA_KEY = 'codex_window_id';
export const CODEX_DOWNSTREAM_WINDOW_METADATA_KEY = 'codex_downstream_window_id';
export const CODEX_DOWNSTREAM_WINDOW_ADVANCED_METADATA_KEY = 'codex_downstream_window_advanced';
export const CODEX_CHILD_RESPONSE_ID_METADATA_KEY = 'codex_child_response_id';
export const CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY = 'codex_next_window_generation';

export const CODEX_NON_INHERITED_SNAPSHOT_METADATA_KEYS = new Set([
  CODEX_CHILD_RESPONSE_ID_METADATA_KEY,
  CODEX_NEXT_WINDOW_GENERATION_METADATA_KEY,
]);
