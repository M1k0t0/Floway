import type {
  AccountModelBackoffRecord,
  AccountModelBackoffRepo,
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  GitHubAccount,
  GitHubRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceMetricScope,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  Repo,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  UsageRecord,
  UsageRepo,
} from "./types.ts";
import { assertWebSearchProviderName } from "../shared/web-search-providers.ts";
import { latencyBucketForMs } from "../shared/performance-histogram.ts";

const SEARCH_CONFIG_KEY: Deno.KvKey = ["config", "search_config"];
const GITHUB_ACCOUNT_ORDER_KEY: Deno.KvKey = ["config", "github_account_order"];

class DenoKvApiKeyRepo implements ApiKeyRepo {
  constructor(private kv: Deno.Kv) {}

  async list(): Promise<ApiKey[]> {
    const keys: ApiKey[] = [];
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      keys.push(entry.value);
    }
    return keys;
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    // Fast path: reverse index lookup
    const ref = await this.kv.get<string>(["api_keys_by_key", rawKey]);
    if (ref.value) return this.getById(ref.value);

    // Slow path: scan all keys (handles keys saved before reverse index existed)
    for await (const entry of this.kv.list<ApiKey>({ prefix: ["api_keys"] })) {
      if (entry.value.key === rawKey) {
        // Lazily backfill the reverse index
        await this.kv.set(["api_keys_by_key", rawKey], entry.value.id);
        return entry.value;
      }
    }
    return null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const entry = await this.kv.get<ApiKey>(["api_keys", id]);
    return entry.value;
  }

  async save(key: ApiKey): Promise<void> {
    const existing = await this.kv.get<ApiKey>(["api_keys", key.id]);
    const ops = this.kv.atomic().set(["api_keys", key.id], key).set([
      "api_keys_by_key",
      key.key,
    ], key.id);
    if (existing.value && existing.value.key !== key.key) {
      ops.delete(["api_keys_by_key", existing.value.key]);
    }
    await ops.commit();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.kv.get<ApiKey>(["api_keys", id]);
    if (!existing.value) return false;
    await this.kv.atomic()
      .delete(["api_keys", id])
      .delete(["api_keys_by_key", existing.value.key])
      .commit();
    return true;
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["api_keys"] })) {
      await this.kv.delete(entry.key);
    }
    for await (const entry of this.kv.list({ prefix: ["api_keys_by_key"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvGitHubRepo implements GitHubRepo {
  constructor(private kv: Deno.Kv) {}

  private async listAccountIds(): Promise<number[]> {
    const ids: number[] = [];
    for await (const entry of this.kv.list({ prefix: ["github_accounts"] })) {
      ids.push(entry.key[1] as number);
    }
    return ids.sort((a, b) => a - b);
  }

  private async readOrder(): Promise<number[]> {
    const orderEntry = await this.kv.get<number[]>(GITHUB_ACCOUNT_ORDER_KEY);
    if (Array.isArray(orderEntry.value)) {
      return orderEntry.value.filter((id): id is number =>
        Number.isInteger(id)
      );
    }

    return [];
  }

  private async writeOrder(userIds: number[]): Promise<void> {
    if (userIds.length === 0) {
      await this.kv.delete(GITHUB_ACCOUNT_ORDER_KEY);
      return;
    }

    await this.kv.set(GITHUB_ACCOUNT_ORDER_KEY, userIds);
  }

  private async normalizeOrder(userIds: number[]): Promise<number[]> {
    const accountIds = await this.listAccountIds();
    const accountIdSet = new Set(accountIds);
    const seen = new Set<number>();
    const ordered = userIds.filter((id) => {
      if (!accountIdSet.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const rest = accountIds.filter((id) => !seen.has(id));
    return [...ordered, ...rest];
  }

  async listAccounts(): Promise<GitHubAccount[]> {
    const accounts: GitHubAccount[] = [];
    for await (
      const entry of this.kv.list<GitHubAccount>({
        prefix: ["github_accounts"],
      })
    ) {
      if (entry.value) accounts.push(withDefaultAccountType(entry.value));
    }
    const rank = new Map(
      (await this.readOrder()).map((id, index) => [id, index]),
    );
    return accounts.sort((a, b) =>
      (rank.get(a.user.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.user.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.user.id - b.user.id
    );
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const entry = await this.kv.get<GitHubAccount>([
      "github_accounts",
      userId,
    ]);
    return entry.value ? withDefaultAccountType(entry.value) : null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    await this.kv.set(["github_accounts", userId], account);
    const order = await this.readOrder();
    if (!order.includes(userId)) {
      await this.writeOrder(await this.normalizeOrder([...order, userId]));
    }
  }

  async deleteAccount(userId: number): Promise<void> {
    await this.kv.delete(["github_accounts", userId]);
    await this.writeOrder(await this.normalizeOrder(await this.readOrder()));
  }

  async setOrder(userIds: number[]): Promise<void> {
    await this.writeOrder(await this.normalizeOrder(userIds));
  }

  async deleteAllAccounts(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["github_accounts"] })) {
      await this.kv.delete(entry.key);
    }
    await this.writeOrder([]);
  }
}

// KV entries created before accountType was added may lack the field
function withDefaultAccountType(account: GitHubAccount): GitHubAccount {
  return account.accountType
    ? account
    : { ...account, accountType: "individual" };
}

class DenoKvUsageRepo implements UsageRepo {
  constructor(private kv: Deno.Kv) {}

  async record(
    keyId: string,
    model: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): Promise<void> {
    let op = this.kv.atomic()
      .sum(["usage", keyId, model, hour, "r"], BigInt(requests))
      .sum(["usage", keyId, model, hour, "i"], BigInt(inputTokens))
      .sum(["usage", keyId, model, hour, "o"], BigInt(outputTokens));
    if (cacheReadTokens > 0) {
      op = op.sum(["usage", keyId, model, hour, "cr"], BigInt(cacheReadTokens));
    }
    if (cacheCreationTokens > 0) {
      op = op.sum(
        ["usage", keyId, model, hour, "cc"],
        BigInt(cacheCreationTokens),
      );
    }
    await op.commit();
  }

  async query(
    opts: { keyId?: string; start: string; end: string },
  ): Promise<UsageRecord[]> {
    const prefix: Deno.KvKey = opts.keyId ? ["usage", opts.keyId] : ["usage"];
    const map = new Map<string, UsageRecord>();

    for await (const entry of this.kv.list<Deno.KvU64>({ prefix })) {
      const keyId = entry.key[1] as string;
      const model = entry.key[2] as string;
      const hour = entry.key[3] as string;
      const metric = entry.key[4] as string;
      if (hour < opts.start || hour >= opts.end) continue;

      const mapKey = `${keyId}\0${model}\0${hour}`;
      let rec = map.get(mapKey);
      if (!rec) {
        rec = {
          keyId,
          model,
          hour,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }

    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async listAll(): Promise<UsageRecord[]> {
    const map = new Map<string, UsageRecord>();
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix: ["usage"] })) {
      const keyId = entry.key[1] as string;
      const model = entry.key[2] as string;
      const hour = entry.key[3] as string;
      const metric = entry.key[4] as string;

      const mapKey = `${keyId}\0${model}\0${hour}`;
      let rec = map.get(mapKey);
      if (!rec) {
        rec = {
          keyId,
          model,
          hour,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        map.set(mapKey, rec);
      }

      const val = Number(entry.value);
      if (metric === "r") rec.requests = val;
      else if (metric === "i") rec.inputTokens = val;
      else if (metric === "o") rec.outputTokens = val;
      else if (metric === "cr") rec.cacheReadTokens = val;
      else if (metric === "cc") rec.cacheCreationTokens = val;
    }
    return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  async set(record: UsageRecord): Promise<void> {
    await this.kv.set(
      ["usage", record.keyId, record.model, record.hour, "r"],
      new Deno.KvU64(BigInt(record.requests)),
    );
    await this.kv.set(
      ["usage", record.keyId, record.model, record.hour, "i"],
      new Deno.KvU64(BigInt(record.inputTokens)),
    );
    await this.kv.set(
      ["usage", record.keyId, record.model, record.hour, "o"],
      new Deno.KvU64(BigInt(record.outputTokens)),
    );
    await this.kv.set(
      ["usage", record.keyId, record.model, record.hour, "cr"],
      new Deno.KvU64(BigInt(record.cacheReadTokens ?? 0)),
    );
    await this.kv.set(
      ["usage", record.keyId, record.model, record.hour, "cc"],
      new Deno.KvU64(BigInt(record.cacheCreationTokens ?? 0)),
    );
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["usage"] })) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvSearchUsageRepo implements SearchUsageRepo {
  constructor(private kv: Deno.Kv) {}

  async record(
    provider: SearchUsageRecord["provider"],
    keyId: string,
    hour: string,
    requests: number,
  ): Promise<void> {
    const validProvider = assertWebSearchProviderName(provider);
    await this.kv.atomic()
      .sum(["search_usage", validProvider, keyId, hour, "r"], BigInt(requests))
      .commit();
  }

  async query(
    opts: {
      provider?: SearchUsageRecord["provider"];
      keyId?: string;
      start: string;
      end: string;
    },
  ): Promise<SearchUsageRecord[]> {
    const provider = opts.provider
      ? assertWebSearchProviderName(opts.provider)
      : undefined;
    const prefix: Deno.KvKey = provider
      ? ["search_usage", provider]
      : ["search_usage"];
    const records = await this.collect(prefix);
    return records
      .filter((r) => !opts.keyId || r.keyId === opts.keyId)
      .filter((r) => r.hour >= opts.start && r.hour < opts.end);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    return await this.collect(["search_usage"]);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.kv.set(
      ["search_usage", provider, record.keyId, record.hour, "r"],
      new Deno.KvU64(BigInt(record.requests)),
    );
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["search_usage"] })) {
      await this.kv.delete(entry.key);
    }
  }

  private async collect(prefix: Deno.KvKey): Promise<SearchUsageRecord[]> {
    const records: SearchUsageRecord[] = [];
    for await (const entry of this.kv.list<Deno.KvU64>({ prefix })) {
      records.push({
        provider: assertWebSearchProviderName(entry.key[1]),
        keyId: entry.key[2] as string,
        hour: entry.key[3] as string,
        requests: Number(entry.value),
      });
    }
    return records.sort((a, b) => a.hour.localeCompare(b.hour));
  }
}

class DenoKvPerformanceRepo implements PerformanceRepo {
  constructor(private kv: Deno.Kv) {}

  private dimensionKey(sample: PerformanceDimensions): Deno.KvKeyPart[] {
    return [
      sample.hour,
      sample.metricScope,
      sample.keyId,
      sample.model,
      sample.sourceApi,
      sample.targetApi,
      sample.stream ? "1" : "0",
      sample.runtimeLocation,
    ];
  }

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const dimensionKey = this.dimensionKey(sample);
    const bucket = latencyBucketForMs(durationMs);
    await this.kv.atomic()
      .sum(["performance", "summary", ...dimensionKey, "requests"], 1n)
      .sum(
        ["performance", "summary", ...dimensionKey, "total_ms_sum"],
        BigInt(durationMs),
      )
      .sum([
        "performance",
        "bucket",
        ...dimensionKey,
        bucket.lowerMs,
        bucket.upperMs,
      ], 1n)
      .commit();
  }

  async recordError(sample: PerformanceErrorSample): Promise<void> {
    await this.kv.atomic()
      .sum(
        ["performance", "summary", ...this.dimensionKey(sample), "errors"],
        1n,
      )
      .commit();
  }

  async query(opts: {
    keyId?: string;
    metricScope?: PerformanceMetricScope;
    start: string;
    end: string;
  }): Promise<PerformanceTelemetryRecord[]> {
    return await this.collect({
      summarySelector: {
        start: ["performance", "summary", opts.start],
        end: ["performance", "summary", opts.end],
      },
      bucketSelector: {
        start: ["performance", "bucket", opts.start],
        end: ["performance", "bucket", opts.end],
      },
      filter: (record) => this.matches(record, opts),
    });
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return await this.collect({
      summarySelector: { prefix: ["performance", "summary"] },
      bucketSelector: { prefix: ["performance", "bucket"] },
      filter: () => true,
    });
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    await this.deleteDimension(record);
    const dimensionKey = this.dimensionKey(record);
    let atomic = this.kv.atomic()
      .set(
        ["performance", "summary", ...dimensionKey, "requests"],
        new Deno.KvU64(BigInt(record.requests)),
      )
      .set(
        ["performance", "summary", ...dimensionKey, "errors"],
        new Deno.KvU64(BigInt(record.errors)),
      )
      .set(
        ["performance", "summary", ...dimensionKey, "total_ms_sum"],
        new Deno.KvU64(BigInt(record.totalMsSum)),
      );
    for (const bucket of record.buckets) {
      atomic = atomic.set(
        [
          "performance",
          "bucket",
          ...dimensionKey,
          bucket.lowerMs,
          bucket.upperMs,
        ],
        new Deno.KvU64(BigInt(bucket.count)),
      );
    }
    await atomic.commit();
  }

  async deleteAll(): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["performance"] })) {
      await this.kv.delete(entry.key);
    }
  }

  private async collect(options: {
    summarySelector: Deno.KvListSelector;
    bucketSelector: Deno.KvListSelector;
    filter: (record: PerformanceDimensions) => boolean;
  }): Promise<PerformanceTelemetryRecord[]> {
    const records = new Map<string, PerformanceTelemetryRecord>();
    for await (
      const entry of this.kv.list<Deno.KvU64>(options.summarySelector)
    ) {
      const parsed = this.parseSummaryKey(entry.key);
      if (!options.filter(parsed)) continue;
      const record = this.recordFor(records, parsed);
      const value = Number(entry.value);
      if (parsed.metric === "requests") record.requests = value;
      if (parsed.metric === "errors") record.errors = value;
      if (parsed.metric === "total_ms_sum") record.totalMsSum = value;
    }

    for await (
      const entry of this.kv.list<Deno.KvU64>(options.bucketSelector)
    ) {
      const parsed = this.parseBucketKey(entry.key);
      if (!options.filter(parsed)) continue;
      this.recordFor(records, parsed).buckets.push({
        lowerMs: parsed.lowerMs,
        upperMs: parsed.upperMs,
        count: Number(entry.value),
      });
    }

    return [...records.values()]
      .map((record) => ({
        ...record,
        buckets: record.buckets.toSorted((a, b) =>
          a.upperMs - b.upperMs || a.lowerMs - b.lowerMs
        ),
      }))
      .sort(comparePerformanceTelemetryRecords);
  }

  private parseDimensions(key: Deno.KvKey): PerformanceDimensions {
    return {
      hour: key[2] as string,
      metricScope: key[3] as PerformanceMetricScope,
      keyId: key[4] as string,
      model: key[5] as string,
      sourceApi: key[6] as PerformanceTelemetryRecord["sourceApi"],
      targetApi: key[7] as PerformanceTelemetryRecord["targetApi"],
      stream: key[8] === "1",
      runtimeLocation: key[9] as string,
    };
  }

  private parseSummaryKey(
    key: Deno.KvKey,
  ): PerformanceDimensions & { metric: string } {
    return { ...this.parseDimensions(key), metric: key[10] as string };
  }

  private parseBucketKey(
    key: Deno.KvKey,
  ): PerformanceDimensions & { lowerMs: number; upperMs: number } {
    return {
      ...this.parseDimensions(key),
      lowerMs: key[10] as number,
      upperMs: key[11] as number,
    };
  }

  private matches(
    record: PerformanceDimensions,
    opts: {
      keyId?: string;
      metricScope?: PerformanceMetricScope;
      start: string;
      end: string;
    },
  ): boolean {
    return record.hour >= opts.start && record.hour < opts.end &&
      (!opts.keyId || record.keyId === opts.keyId) &&
      (!opts.metricScope || record.metricScope === opts.metricScope);
  }

  private recordFor(
    records: Map<string, PerformanceTelemetryRecord>,
    dimensions: PerformanceDimensions,
  ): PerformanceTelemetryRecord {
    const key = [
      dimensions.hour,
      dimensions.metricScope,
      dimensions.keyId,
      dimensions.model,
      dimensions.sourceApi,
      dimensions.targetApi,
      dimensions.stream ? "1" : "0",
      dimensions.runtimeLocation,
    ].join("\0");
    let record = records.get(key);
    if (!record) {
      record = {
        hour: dimensions.hour,
        metricScope: dimensions.metricScope,
        keyId: dimensions.keyId,
        model: dimensions.model,
        sourceApi: dimensions.sourceApi,
        targetApi: dimensions.targetApi,
        stream: dimensions.stream,
        runtimeLocation: dimensions.runtimeLocation,
        requests: 0,
        errors: 0,
        totalMsSum: 0,
        buckets: [],
      };
      records.set(key, record);
    }
    return record;
  }

  private async deleteDimension(record: PerformanceDimensions): Promise<void> {
    const dimensionKey = this.dimensionKey(record);
    for (
      const prefix of [
        ["performance", "summary", ...dimensionKey],
        ["performance", "bucket", ...dimensionKey],
      ]
    ) {
      for await (const entry of this.kv.list({ prefix })) {
        await this.kv.delete(entry.key);
      }
    }
  }
}

function comparePerformanceTelemetryRecords(
  a: PerformanceTelemetryRecord,
  b: PerformanceTelemetryRecord,
): number {
  return a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model) ||
    a.sourceApi.localeCompare(b.sourceApi) ||
    a.targetApi.localeCompare(b.targetApi) ||
    Number(a.stream) - Number(b.stream) ||
    a.runtimeLocation.localeCompare(b.runtimeLocation);
}

class DenoKvCacheRepo implements CacheRepo {
  constructor(private kv: Deno.Kv) {}

  async get(key: string): Promise<string | null> {
    const entry = await this.kv.get<string>(["cache", key]);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    await this.kv.set(
      ["cache", key],
      value,
      ttlMs ? { expireIn: ttlMs } : undefined,
    );
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(["cache", key]);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for await (const entry of this.kv.list({ prefix: ["cache"] })) {
      const key = entry.key[1];
      if (typeof key === "string" && key.startsWith(prefix)) {
        await this.kv.delete(entry.key);
      }
    }
  }
}

class DenoKvAccountModelBackoffRepo implements AccountModelBackoffRepo {
  constructor(private kv: Deno.Kv) {}

  private key(accountId: number, model: string): Deno.KvKey {
    return ["account_model_backoffs", accountId, model];
  }

  async get(
    accountId: number,
    model: string,
  ): Promise<AccountModelBackoffRecord | null> {
    const entry = await this.kv.get<AccountModelBackoffRecord>(
      this.key(accountId, model),
    );
    return entry.value;
  }

  async list(accountIds: number[]): Promise<AccountModelBackoffRecord[]> {
    const records: AccountModelBackoffRecord[] = [];
    for (const accountId of accountIds) {
      for await (
        const entry of this.kv.list<AccountModelBackoffRecord>({
          prefix: ["account_model_backoffs", accountId],
        })
      ) {
        records.push(entry.value);
      }
    }
    return records.sort((a, b) =>
      a.accountId - b.accountId || a.model.localeCompare(b.model)
    );
  }

  async mark(record: AccountModelBackoffRecord): Promise<void> {
    const ttlMs = record.expiresAt - Date.now();
    if (ttlMs <= 0) {
      await this.clear(record.accountId, record.model);
      return;
    }

    await this.kv.set(this.key(record.accountId, record.model), record, {
      expireIn: ttlMs,
    });
  }

  async clear(accountId: number, model: string): Promise<void> {
    await this.kv.delete(this.key(accountId, model));
  }

  async clearModel(accountIds: number[], model: string): Promise<void> {
    await Promise.all(
      accountIds.map((accountId) => this.clear(accountId, model)),
    );
  }

  async clearAccount(accountId: number): Promise<void> {
    for await (
      const entry of this.kv.list({
        prefix: ["account_model_backoffs", accountId],
      })
    ) {
      await this.kv.delete(entry.key);
    }
  }

  async deleteAll(): Promise<void> {
    for await (
      const entry of this.kv.list({ prefix: ["account_model_backoffs"] })
    ) {
      await this.kv.delete(entry.key);
    }
  }
}

class DenoKvSearchConfigRepo implements SearchConfigRepo {
  constructor(private kv: Deno.Kv) {}

  async get(): Promise<unknown | null> {
    const entry = await this.kv.get(SEARCH_CONFIG_KEY);
    return entry.value === undefined ? null : entry.value;
  }

  async save(config: unknown): Promise<void> {
    await this.kv.set(SEARCH_CONFIG_KEY, config === undefined ? null : config);
  }
}

export class DenoKvRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  accountModelBackoffs: AccountModelBackoffRepo;
  searchConfig: SearchConfigRepo;

  constructor(kv: Deno.Kv) {
    this.apiKeys = new DenoKvApiKeyRepo(kv);
    this.github = new DenoKvGitHubRepo(kv);
    this.usage = new DenoKvUsageRepo(kv);
    this.searchUsage = new DenoKvSearchUsageRepo(kv);
    this.performance = new DenoKvPerformanceRepo(kv);
    this.cache = new DenoKvCacheRepo(kv);
    this.accountModelBackoffs = new DenoKvAccountModelBackoffRepo(kv);
    this.searchConfig = new DenoKvSearchConfigRepo(kv);
  }
}
