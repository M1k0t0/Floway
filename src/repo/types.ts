import type { WebSearchProviderName } from "../shared/web-search-providers.ts";
import type { HistogramBucket } from "../shared/performance-histogram.ts";

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface GitHubAccount {
  token: string;
  accountType: string;
  user: {
    login: string;
    avatar_url: string;
    name: string | null;
    id: number;
  };
}

export interface UsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface SearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  hour: string;
  requests: number;
}

export type PerformanceMetricScope = "request_total" | "upstream_success";
export type PerformanceApiName =
  | "messages"
  | "responses"
  | "chat-completions"
  | "gemini";

export interface PerformanceDimensions {
  hour: string;
  metricScope: PerformanceMetricScope;
  keyId: string;
  model: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

export interface PerformanceLatencySample extends PerformanceDimensions {
  durationMs: number;
}

export interface PerformanceErrorSample extends PerformanceDimensions {}

export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  errors: number;
  totalMsSum: number;
  buckets: HistogramBucket[];
}

export interface AccountModelBackoffRecord {
  accountId: number;
  model: string;
  status: number;
  expiresAt: number;
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface GitHubRepo {
  listAccounts(): Promise<GitHubAccount[]>;
  getAccount(userId: number): Promise<GitHubAccount | null>;
  saveAccount(userId: number, account: GitHubAccount): Promise<void>;
  deleteAccount(userId: number): Promise<void>;
  setOrder(userIds: number[]): Promise<void>;
  deleteAllAccounts(): Promise<void>;
}

export interface UsageRepo {
  record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): Promise<void>;
  query(
    opts: { keyId?: string; start: string; end: string },
  ): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchUsageRepo {
  record(
    provider: WebSearchProviderName,
    keyId: string,
    hour: string,
    requests: number,
  ): Promise<void>;
  query(
    opts: {
      provider?: WebSearchProviderName;
      keyId?: string;
      start: string;
      end: string;
    },
  ): Promise<SearchUsageRecord[]>;
  listAll(): Promise<SearchUsageRecord[]>;
  set(record: SearchUsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface PerformanceRepo {
  recordLatency(sample: PerformanceLatencySample): Promise<void>;
  recordError(sample: PerformanceErrorSample): Promise<void>;
  query(opts: {
    keyId?: string;
    metricScope?: PerformanceMetricScope;
    start: string;
    end: string;
  }): Promise<PerformanceTelemetryRecord[]>;
  listAll(): Promise<PerformanceTelemetryRecord[]>;
  set(record: PerformanceTelemetryRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface AccountModelBackoffRepo {
  get(
    accountId: number,
    model: string,
  ): Promise<AccountModelBackoffRecord | null>;
  list(accountIds: number[]): Promise<AccountModelBackoffRecord[]>;
  mark(record: AccountModelBackoffRecord): Promise<void>;
  clear(accountId: number, model: string): Promise<void>;
  clearModel(accountIds: number[], model: string): Promise<void>;
  clearAccount(accountId: number): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown | null>;
  save(config: unknown): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  accountModelBackoffs: AccountModelBackoffRepo;
  searchConfig: SearchConfigRepo;
}
