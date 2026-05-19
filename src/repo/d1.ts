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

// Minimal D1 type definitions (subset of @cloudflare/workers-types)
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

const SEARCH_CONFIG_KEY = "search_config";
const GITHUB_ACCOUNT_ORDER_KEY = "github_account_order";

const serializeStoredConfig = (value: unknown): string =>
  JSON.stringify(value === undefined ? null : value);

class D1ApiKeyRepo implements ApiKeyRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys ORDER BY created_at",
      )
      .all<
        {
          id: string;
          name: string;
          key: string;
          created_at: string;
          last_used_at: string | null;
        }
      >();
    return results.map(toApiKey);
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE key = ?",
      )
      .bind(rawKey)
      .first<
        {
          id: string;
          name: string;
          key: string;
          created_at: string;
          last_used_at: string | null;
        }
      >();
    return row ? toApiKey(row) : null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare(
        "SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE id = ?",
      )
      .bind(id)
      .first<
        {
          id: string;
          name: string;
          key: string;
          created_at: string;
          last_used_at: string | null;
        }
      >();
    return row ? toApiKey(row) : null;
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at`,
      )
      .bind(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null)
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ?")
      .bind(id).run();
    return (result.meta.changes as number ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM api_keys").run();
  }
}

function toApiKey(
  row: {
    id: string;
    name: string;
    key: string;
    created_at: string;
    last_used_at: string | null;
  },
): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

class D1GitHubRepo implements GitHubRepo {
  constructor(private db: D1Database) {}

  private async listAccountIds(): Promise<number[]> {
    const { results } = await this.db
      .prepare("SELECT user_id FROM github_accounts ORDER BY user_id")
      .all<{ user_id: number }>();
    return results.map((row) => row.user_id);
  }

  private async readOrder(): Promise<number[]> {
    const orderRow = await this.db
      .prepare("SELECT value FROM config WHERE key = ?")
      .bind(GITHUB_ACCOUNT_ORDER_KEY)
      .first<{ value: string }>();

    if (orderRow?.value) {
      try {
        const parsed = JSON.parse(orderRow.value) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is number => Number.isInteger(id));
        }
      } catch {
        return [];
      }
    }

    return [];
  }

  private async writeOrder(userIds: number[]): Promise<void> {
    if (userIds.length === 0) {
      await this.db.prepare("DELETE FROM config WHERE key = ?")
        .bind(GITHUB_ACCOUNT_ORDER_KEY)
        .run();
      return;
    }

    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(GITHUB_ACCOUNT_ORDER_KEY, JSON.stringify(userIds))
      .run();
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
    const { results } = await this.db
      .prepare(
        "SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts ORDER BY user_id",
      )
      .all<
        {
          user_id: number;
          token: string;
          account_type: string;
          login: string;
          name: string | null;
          avatar_url: string;
        }
      >();
    const rank = new Map(
      (await this.readOrder()).map((id, index) => [id, index]),
    );
    return results.map(toGitHubAccount).sort((a, b) =>
      (rank.get(a.user.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.user.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.user.id - b.user.id
    );
  }

  async getAccount(userId: number): Promise<GitHubAccount | null> {
    const row = await this.db
      .prepare(
        "SELECT user_id, token, account_type, login, name, avatar_url FROM github_accounts WHERE user_id = ?",
      )
      .bind(userId)
      .first<
        {
          user_id: number;
          token: string;
          account_type: string;
          login: string;
          name: string | null;
          avatar_url: string;
        }
      >();
    return row ? toGitHubAccount(row) : null;
  }

  async saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO github_accounts (user_id, token, account_type, login, name, avatar_url) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, account_type = excluded.account_type, login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url`,
      )
      .bind(
        userId,
        account.token,
        account.accountType,
        account.user.login,
        account.user.name,
        account.user.avatar_url,
      )
      .run();
    const order = await this.readOrder();
    if (!order.includes(userId)) {
      await this.writeOrder(await this.normalizeOrder([...order, userId]));
    }
  }

  async deleteAccount(userId: number): Promise<void> {
    await this.db.prepare("DELETE FROM github_accounts WHERE user_id = ?").bind(
      userId,
    ).run();
    await this.writeOrder(await this.normalizeOrder(await this.readOrder()));
  }

  async setOrder(userIds: number[]): Promise<void> {
    await this.writeOrder(await this.normalizeOrder(userIds));
  }

  async deleteAllAccounts(): Promise<void> {
    await this.db.prepare("DELETE FROM github_accounts").run();
    await this.writeOrder([]);
  }
}

function toGitHubAccount(
  row: {
    user_id: number;
    token: string;
    account_type: string;
    login: string;
    name: string | null;
    avatar_url: string;
  },
): GitHubAccount {
  return {
    token: row.token,
    accountType: row.account_type,
    user: {
      id: row.user_id,
      login: row.login,
      name: row.name,
      avatar_url: row.avatar_url,
    },
  };
}

class D1UsageRepo implements UsageRepo {
  constructor(private db: D1Database) {}

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
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens`,
      )
      .bind(
        keyId,
        model,
        hour,
        requests,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      )
      .run();
  }

  async query(
    opts: { keyId?: string; start: string; end: string },
  ): Promise<UsageRecord[]> {
    const sql = opts.keyId
      ? "SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour"
      : "SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour";
    const binds = opts.keyId
      ? [opts.keyId, opts.start, opts.end]
      : [opts.start, opts.end];
    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<
        {
          key_id: string;
          model: string;
          hour: string;
          requests: number;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_creation_tokens: number;
        }
      >();
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }));
  }

  async listAll(): Promise<UsageRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM usage ORDER BY hour",
      )
      .all<
        {
          key_id: string;
          model: string;
          hour: string;
          requests: number;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_creation_tokens: number;
        }
      >();
    return results.map((r) => ({
      keyId: r.key_id,
      model: r.model,
      hour: r.hour,
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheCreationTokens: r.cache_creation_tokens ?? 0,
    }));
  }

  async set(record: UsageRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO usage (key_id, model, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key_id, model, hour) DO UPDATE SET
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens`,
      )
      .bind(
        record.keyId,
        record.model,
        record.hour,
        record.requests,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens ?? 0,
        record.cacheCreationTokens ?? 0,
      )
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM usage").run();
  }
}

class D1SearchUsageRepo implements SearchUsageRepo {
  constructor(private db: D1Database) {}

  async record(
    provider: SearchUsageRecord["provider"],
    keyId: string,
    hour: string,
    requests: number,
  ): Promise<void> {
    const validProvider = assertWebSearchProviderName(provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, hour, requests) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, key_id, hour) DO UPDATE SET
           requests = requests + excluded.requests`,
      )
      .bind(validProvider, keyId, hour, requests)
      .run();
  }

  async query(
    opts: {
      provider?: SearchUsageRecord["provider"];
      keyId?: string;
      start: string;
      end: string;
    },
  ): Promise<SearchUsageRecord[]> {
    const filters = ["hour >= ?", "hour < ?"];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.provider) {
      const validProvider = assertWebSearchProviderName(opts.provider);
      filters.unshift("provider = ?");
      binds.unshift(validProvider);
    }
    if (opts.keyId) {
      filters.push("key_id = ?");
      binds.push(opts.keyId);
    }

    const { results } = await this.db
      .prepare(
        `SELECT provider, key_id, hour, requests FROM search_usage WHERE ${
          filters.join(" AND ")
        } ORDER BY hour`,
      )
      .bind(...binds)
      .all<{
        provider: string;
        key_id: string;
        hour: string;
        requests: number;
      }>();
    return results.map(toSearchUsageRecord);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT provider, key_id, hour, requests FROM search_usage ORDER BY hour",
      )
      .all<{
        provider: string;
        key_id: string;
        hour: string;
        requests: number;
      }>();
    return results.map(toSearchUsageRecord);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, hour, requests) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, key_id, hour) DO UPDATE SET
           requests = excluded.requests`,
      )
      .bind(provider, record.keyId, record.hour, record.requests)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM search_usage").run();
  }
}

class D1PerformanceRepo implements PerformanceRepo {
  constructor(private db: D1Database) {}

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const bucket = latencyBucketForMs(durationMs);
    await this.runStatements([
      this.addSummaryStatement(sample, 1, 0, durationMs),
      this.addBucketStatement(sample, bucket.lowerMs, bucket.upperMs, 1),
    ]);
  }

  async recordError(sample: PerformanceErrorSample): Promise<void> {
    await this.addSummaryStatement(sample, 0, 1, 0).run();
  }

  async query(opts: {
    keyId?: string;
    metricScope?: PerformanceMetricScope;
    start: string;
    end: string;
  }): Promise<PerformanceTelemetryRecord[]> {
    const filters = ["hour >= ?", "hour < ?"];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.keyId) {
      filters.push("key_id = ?");
      binds.push(opts.keyId);
    }
    if (opts.metricScope) {
      filters.push("metric_scope = ?");
      binds.push(opts.metricScope);
    }
    return await this.queryWhere(filters.join(" AND "), binds);
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return await this.queryWhere("1 = 1", []);
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    await this.runStatements([
      this.setSummaryStatement(record),
      this.deleteBucketsStatement(record),
      ...record.buckets.map((bucket) =>
        this.setBucketStatement(
          record,
          bucket.lowerMs,
          bucket.upperMs,
          bucket.count,
        )
      ),
    ]);
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM performance_latency_buckets").run();
    await this.db.prepare("DELETE FROM performance_summary").run();
  }

  private async queryWhere(
    where: string,
    binds: unknown[],
  ): Promise<PerformanceTelemetryRecord[]> {
    const records = new Map<string, PerformanceTelemetryRecord>();

    const { results: summaries } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum
         FROM performance_summary WHERE ${where} ORDER BY hour`,
      )
      .bind(...binds)
      .all<PerformanceSummaryRow>();
    for (const row of summaries) {
      const dimensions = performanceDimensionsFromRow(row);
      records.set(performanceRecordKey(dimensions), {
        ...dimensions,
        requests: row.requests,
        errors: row.errors,
        totalMsSum: row.total_ms_sum,
        buckets: [],
      });
    }

    const { results: buckets } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count
         FROM performance_latency_buckets WHERE ${where} ORDER BY hour, upper_ms`,
      )
      .bind(...binds)
      .all<PerformanceBucketRow>();
    for (const row of buckets) {
      const dimensions = performanceDimensionsFromRow(row);
      const key = performanceRecordKey(dimensions);
      let record = records.get(key);
      if (!record) {
        record = {
          ...dimensions,
          requests: 0,
          errors: 0,
          totalMsSum: 0,
          buckets: [],
        };
        records.set(key, record);
      }
      record.buckets.push({
        lowerMs: row.lower_ms,
        upperMs: row.upper_ms,
        count: row.count,
      });
    }

    return [...records.values()].sort(comparePerformanceTelemetryRecords);
  }

  private async runStatements(
    statements: D1PreparedStatement[],
  ): Promise<void> {
    if (this.db.batch) {
      await this.db.batch(statements);
      return;
    }
    for (const statement of statements) await statement.run();
  }

  private addSummaryStatement(
    sample: PerformanceDimensions,
    requests: number,
    errors: number,
    totalMsSum: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location) DO UPDATE SET
           requests = requests + excluded.requests,
           errors = errors + excluded.errors,
           total_ms_sum = total_ms_sum + excluded.total_ms_sum`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.sourceApi,
        sample.targetApi,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        requests,
        errors,
        totalMsSum,
      );
  }

  private setSummaryStatement(
    record: PerformanceTelemetryRecord,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location) DO UPDATE SET
           requests = excluded.requests,
           errors = excluded.errors,
           total_ms_sum = excluded.total_ms_sum`,
      )
      .bind(
        record.hour,
        record.metricScope,
        record.keyId,
        record.model,
        record.sourceApi,
        record.targetApi,
        record.stream ? 1 : 0,
        record.runtimeLocation,
        record.requests,
        record.errors,
        record.totalMsSum,
      );
  }

  private deleteBucketsStatement(
    record: PerformanceDimensions,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM performance_latency_buckets
         WHERE hour = ? AND metric_scope = ? AND key_id = ? AND model = ? AND source_api = ? AND target_api = ? AND stream = ? AND runtime_location = ?`,
      )
      .bind(...performanceDimensionBinds(record));
  }

  private addBucketStatement(
    sample: PerformanceDimensions,
    lowerMs: number,
    upperMs: number,
    count: number,
  ): D1PreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, "add");
  }

  private setBucketStatement(
    sample: PerformanceDimensions,
    lowerMs: number,
    upperMs: number,
    count: number,
  ): D1PreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, "set");
  }

  private bucketStatement(
    sample: PerformanceDimensions,
    lowerMs: number,
    upperMs: number,
    count: number,
    mode: "add" | "set",
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hour, metric_scope, key_id, model, source_api, target_api, stream, runtime_location, lower_ms, upper_ms) DO UPDATE SET
           count = ${
          mode === "add" ? "count + excluded.count" : "excluded.count"
        }`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.sourceApi,
        sample.targetApi,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        lowerMs,
        upperMs,
        count,
      );
  }
}

type PerformanceDimensionRow = {
  hour: string;
  metric_scope: string;
  key_id: string;
  model: string;
  source_api: string;
  target_api: string;
  stream: number;
  runtime_location: string;
};

interface PerformanceSummaryRow extends PerformanceDimensionRow {
  requests: number;
  errors: number;
  total_ms_sum: number;
}

interface PerformanceBucketRow extends PerformanceDimensionRow {
  lower_ms: number;
  upper_ms: number;
  count: number;
}

function performanceDimensionsFromRow(
  row: PerformanceDimensionRow,
): PerformanceDimensions {
  return {
    hour: row.hour,
    metricScope: row.metric_scope as PerformanceMetricScope,
    keyId: row.key_id,
    model: row.model,
    sourceApi: row.source_api as PerformanceTelemetryRecord["sourceApi"],
    targetApi: row.target_api as PerformanceTelemetryRecord["targetApi"],
    stream: row.stream === 1,
    runtimeLocation: row.runtime_location,
  };
}

function performanceRecordKey(record: PerformanceDimensions): string {
  return [
    record.hour,
    record.metricScope,
    record.keyId,
    record.model,
    record.sourceApi,
    record.targetApi,
    record.stream ? "1" : "0",
    record.runtimeLocation,
  ].join("\0");
}

function performanceDimensionBinds(record: PerformanceDimensions): unknown[] {
  return [
    record.hour,
    record.metricScope,
    record.keyId,
    record.model,
    record.sourceApi,
    record.targetApi,
    record.stream ? 1 : 0,
    record.runtimeLocation,
  ];
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

function toSearchUsageRecord(
  row: {
    provider: string;
    key_id: string;
    hour: string;
    requests: number;
  },
): SearchUsageRecord {
  return {
    provider: assertWebSearchProviderName(row.provider),
    keyId: row.key_id,
    hour: row.hour,
    requests: row.requests,
  };
}

class D1CacheRepo implements CacheRepo {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM config WHERE key = ?")
      .bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(key, value)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key = ?").bind(key).run();
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db.prepare("DELETE FROM config WHERE key >= ? AND key < ?")
      .bind(prefix, `${prefix}\uffff`)
      .run();
  }
}

class D1AccountModelBackoffRepo implements AccountModelBackoffRepo {
  constructor(private db: D1Database) {}

  async get(
    accountId: number,
    model: string,
  ): Promise<AccountModelBackoffRecord | null> {
    const row = await this.db.prepare(
      "SELECT account_id, model, status, expires_at FROM account_model_backoffs WHERE account_id = ? AND model = ?",
    )
      .bind(accountId, model)
      .first<{
        account_id: number;
        model: string;
        status: number;
        expires_at: number;
      }>();
    return row
      ? {
        accountId: row.account_id,
        model: row.model,
        status: row.status,
        expiresAt: row.expires_at,
      }
      : null;
  }

  async list(accountIds: number[]): Promise<AccountModelBackoffRecord[]> {
    if (accountIds.length === 0) return [];

    const placeholders = accountIds.map(() => "?").join(", ");
    const { results } = await this.db.prepare(
      `SELECT account_id, model, status, expires_at FROM account_model_backoffs WHERE account_id IN (${placeholders}) ORDER BY account_id, model`,
    )
      .bind(...accountIds)
      .all<{
        account_id: number;
        model: string;
        status: number;
        expires_at: number;
      }>();
    return results.map((row) => ({
      accountId: row.account_id,
      model: row.model,
      status: row.status,
      expiresAt: row.expires_at,
    }));
  }

  async mark(record: AccountModelBackoffRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO account_model_backoffs (account_id, model, status, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, model) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at`,
    )
      .bind(record.accountId, record.model, record.status, record.expiresAt)
      .run();
  }

  async clear(accountId: number, model: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM account_model_backoffs WHERE account_id = ? AND model = ?",
    )
      .bind(accountId, model)
      .run();
  }

  async clearModel(accountIds: number[], model: string): Promise<void> {
    if (accountIds.length === 0) return;

    const placeholders = accountIds.map(() => "?").join(", ");
    await this.db.prepare(
      `DELETE FROM account_model_backoffs WHERE model = ? AND account_id IN (${placeholders})`,
    )
      .bind(model, ...accountIds)
      .run();
  }

  async clearAccount(accountId: number): Promise<void> {
    await this.db.prepare(
      "DELETE FROM account_model_backoffs WHERE account_id = ?",
    )
      .bind(accountId)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare("DELETE FROM account_model_backoffs").run();
  }
}

class D1SearchConfigRepo implements SearchConfigRepo {
  constructor(private db: D1Database) {}

  async get(): Promise<unknown | null> {
    const row = await this.db
      .prepare("SELECT value FROM config WHERE key = ?")
      .bind(SEARCH_CONFIG_KEY)
      .first<{ value: string }>();

    if (!row?.value) {
      return null;
    }

    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  async save(config: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(SEARCH_CONFIG_KEY, serializeStoredConfig(config))
      .run();
  }
}

export class D1Repo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  accountModelBackoffs: AccountModelBackoffRepo;
  searchConfig: SearchConfigRepo;

  constructor(db: D1Database) {
    this.apiKeys = new D1ApiKeyRepo(db);
    this.github = new D1GitHubRepo(db);
    this.usage = new D1UsageRepo(db);
    this.searchUsage = new D1SearchUsageRepo(db);
    this.performance = new D1PerformanceRepo(db);
    this.cache = new D1CacheRepo(db);
    this.accountModelBackoffs = new D1AccountModelBackoffRepo(db);
    this.searchConfig = new D1SearchConfigRepo(db);
  }
}
