// Per-account Copilot model cache. Soft expiry drives refresh attempts; hard
// expiry bounds how long switchable upstream failures may silently reuse stale
// model metadata for account-pool routing.

import {
  copilotFetch,
  isAccountSwitchableStatus,
  isCopilotTokenFetchError,
} from "../../shared/copilot.ts";
import { dateSuffixedClaudeModelAliasTarget } from "../../shared/model-name.ts";
import { getRepo } from "../../repo/index.ts";
import type { GitHubAccount } from "../../repo/types.ts";
import type { ModelInfo, ModelsResponse } from "./types.ts";

export type { ModelInfo, ModelsResponse } from "./types.ts";

interface ModelsCacheEntry {
  fetchedAt: number;
  hardExpiresAt: number;
  data: ModelsResponse;
}

export interface ModelsLoadSuccess {
  type: "models";
  data: ModelsResponse;
  stale: boolean;
}

export interface ModelsLoadFailure {
  type: "error";
  error: unknown;
}

export type ModelsLoadResult = ModelsLoadSuccess | ModelsLoadFailure;

export class ModelsFetchError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly headers: Headers,
  ) {
    super(`Copilot models fetch failed: ${status} ${body}`);
    this.name = "ModelsFetchError";
  }
}

const IN_PROCESS_TTL_MS = 120_000;
const SOFT_TTL_MS = 600_000;
const HARD_TTL_MS = 2 * 60 * 60 * 1000;
const MODELS_CACHE_KEY_PREFIX = "models_cache_v2";

const inProcessCache = new Map<string, {
  entry: ModelsCacheEntry;
  cachedAt: number;
}>();

export function clearModelsCache(): void {
  inProcessCache.clear();
}

async function modelsCacheKey(
  githubToken: string,
  accountType: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${accountType}:${githubToken}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${MODELS_CACHE_KEY_PREFIX}:${hash}`;
}

const isSoftFresh = (entry: ModelsCacheEntry, now: number): boolean =>
  now - entry.fetchedAt < SOFT_TTL_MS;

const isHardFresh = (entry: ModelsCacheEntry, now: number): boolean =>
  entry.hardExpiresAt > now;

const isCacheEntry = (value: unknown): value is ModelsCacheEntry => {
  const entry = value as ModelsCacheEntry;
  return typeof entry?.fetchedAt === "number" &&
    typeof entry.hardExpiresAt === "number" &&
    Boolean(entry.data) &&
    Array.isArray(entry.data.data);
};

const isModelsResponse = (value: unknown): value is ModelsResponse => {
  const response = value as ModelsResponse;
  return response?.object === "list" && Array.isArray(response.data);
};

async function readRepoCache(
  cacheKey: string,
): Promise<ModelsCacheEntry | null> {
  try {
    const raw = await getRepo().cache.get(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isCacheEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRepoCache(
  cacheKey: string,
  entry: ModelsCacheEntry,
): Promise<void> {
  try {
    await getRepo().cache.set(cacheKey, JSON.stringify(entry));
  } catch {
    // Repo cache is an optimization; fetch result is still usable without persisting it.
  }
}

export const isSwitchableModelsLoadError = (error: unknown): boolean => {
  if (error instanceof ModelsFetchError) {
    return isAccountSwitchableStatus(error.status);
  }
  return isCopilotTokenFetchError(error) &&
    isAccountSwitchableStatus(error.status);
};

async function fetchModels(
  githubToken: string,
  accountType: string,
): Promise<ModelsResponse> {
  const resp = await copilotFetch(
    "/models",
    { method: "GET" },
    githubToken,
    accountType,
  );

  if (!resp.ok) {
    throw new ModelsFetchError(
      resp.status,
      await resp.text(),
      new Headers(resp.headers),
    );
  }

  const data = await resp.json() as unknown;
  if (!isModelsResponse(data)) {
    throw new Error("Invalid Copilot models response");
  }

  return data;
}

export async function loadModels(
  githubToken: string,
  accountType: string,
): Promise<ModelsLoadResult> {
  const now = Date.now();
  const cacheKey = await modelsCacheKey(githubToken, accountType);
  const cached = inProcessCache.get(cacheKey);

  if (
    cached &&
    now - cached.cachedAt < IN_PROCESS_TTL_MS &&
    isHardFresh(cached.entry, now)
  ) {
    return {
      type: "models",
      data: cached.entry.data,
      stale: !isSoftFresh(cached.entry, now),
    };
  }

  const repoEntry = await readRepoCache(cacheKey);
  if (repoEntry && isSoftFresh(repoEntry, now)) {
    inProcessCache.set(cacheKey, { entry: repoEntry, cachedAt: now });
    return { type: "models", data: repoEntry.data, stale: false };
  }

  try {
    const data = await fetchModels(githubToken, accountType);
    const entry = {
      fetchedAt: now,
      hardExpiresAt: now + HARD_TTL_MS,
      data,
    } satisfies ModelsCacheEntry;
    inProcessCache.set(cacheKey, { entry, cachedAt: now });
    await writeRepoCache(cacheKey, entry);
    return { type: "models", data, stale: false };
  } catch (error) {
    if (
      repoEntry &&
      isHardFresh(repoEntry, now) &&
      isSwitchableModelsLoadError(error)
    ) {
      inProcessCache.set(cacheKey, { entry: repoEntry, cachedAt: now });
      return { type: "models", data: repoEntry.data, stale: true };
    }

    if (
      cached &&
      isHardFresh(cached.entry, now) &&
      isSwitchableModelsLoadError(error)
    ) {
      return { type: "models", data: cached.entry.data, stale: true };
    }

    return { type: "error", error };
  }
}

export const loadModelsForAccount = (
  account: GitHubAccount,
): Promise<ModelsLoadResult> => loadModels(account.token, account.accountType);

export const findModelInModels = (
  models: ModelsResponse,
  modelId: string,
): ModelInfo | undefined => {
  const exact = models.data.find((model) => model.id === modelId);
  if (exact) return exact;

  // Date-suffixed Claude IDs are client aliases for the same Copilot model,
  // but exact /models IDs must win first so future upstream dated releases are
  // not rewritten to their base model.
  const aliasTarget = dateSuffixedClaudeModelAliasTarget(modelId);
  if (!aliasTarget) return undefined;
  return models.data.find((model) => model.id === aliasTarget);
};
