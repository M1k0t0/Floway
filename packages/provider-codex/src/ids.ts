import { v4, v7 } from 'uuid';

import { sha256Json } from '@floway-dev/provider';

// Format SHA-256 digests as UUIDv4-shaped opaque identifiers for Floway-owned
// stable ids where we intentionally do not mimic Codex's random persisted device id.
const digestUuid = (digest: Uint8Array): string => v4({ random: digest });

export const sha256JsonUuid = (value: unknown, prefix: string): string =>
  digestUuid(sha256Json(value, prefix));

// CLIProxyAPI likewise derives identity UUIDs from the selected auth id, identity
// kind, and original value. Keep Floway's tuple structural and its hash domain
// versioned so adding another identity kind cannot alias an existing mapping.
// https://github.com/router-for-me/CLIProxyAPI/blob/5208aec703b5ce7e3445f6e9d91cc13b3e78003a/internal/runtime/executor/codex_executor_request.go#L268-L278
const CODEX_IDENTITY_NICKNAME_PREFIX = 'floway:codex:identity-nickname:v1';

export const nickCodexIdentityUuid = (
  selectedAuthId: string,
  identityKind: string,
  originalValue: string,
): string => sha256JsonUuid(
  [selectedAuthId, identityKind, originalValue],
  CODEX_IDENTITY_NICKNAME_PREFIX,
);

export const uuidV7 = (): string => v7();
