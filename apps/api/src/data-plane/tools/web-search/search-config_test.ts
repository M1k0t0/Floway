import { test } from 'vitest';

import { DEFAULT_SEARCH_CONFIG, FIXED_SEARCH_CONFIG_TEST_QUERY, loadSearchConfig, parseSearchConfigDefault, parseSearchConfigStrict, saveSearchConfig } from './search-config.ts';
import { type D1Database, D1Repo } from '../../../repo/d1.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

class FakeD1PreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeD1Database, private query: string) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    this.binds = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query === 'SELECT value FROM config WHERE key = ?') {
      const value = this.db.config.get(String(this.binds[0]));
      return Promise.resolve(value == null ? null : ({ value } as T));
    }

    throw new Error(`Unsupported D1 first() query in test: ${this.query}`);
  }

  all(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    throw new Error(`Unsupported D1 all() query in test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (
      this.query ===
      `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    ) {
      this.db.config.set(String(this.binds[0]), String(this.binds[1]));
      return Promise.resolve({ results: [], success: true, meta: {} });
    }

    throw new Error(`Unsupported D1 run() query in test: ${this.query}`);
  }
}

class FakeD1Database implements D1Database {
  readonly config = new Map<string, string>();

  prepare(query: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, query);
  }
}

test('search config repo defaults to disabled and round-trips provider keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  assertEquals(await loadSearchConfig(), DEFAULT_SEARCH_CONFIG);

  await saveSearchConfig({
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
  });

  assertEquals(await loadSearchConfig(), {
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
  });
  assertEquals(FIXED_SEARCH_CONFIG_TEST_QUERY, 'React documentation');
});

test('loadSearchConfig strict-parses a stored row and rejects unknown provider values', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.searchConfig.save({
    provider: 'unknown-provider',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftGrounding: { apiKey: '  ms-test  ' },
  });

  await assertRejects(() => loadSearchConfig(), Error, 'provider');
});

test('loadSearchConfig strict-parses a stored row and trims valid api keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.searchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: '  tvly-trim  ' },
    microsoftGrounding: { apiKey: '  ms-trim  ' },
  });

  assertEquals(await loadSearchConfig(), {
    provider: 'tavily',
    tavily: { apiKey: 'tvly-trim' },
    microsoftGrounding: { apiKey: 'ms-trim' },
  });
});

test('parseSearchConfigDefault returns a fresh deep copy so callers cannot corrupt the singleton', () => {
  const a = parseSearchConfigDefault();
  const b = parseSearchConfigDefault();
  a.tavily.apiKey = 'mutated';
  assertEquals(b.tavily.apiKey, '');
  assertEquals(DEFAULT_SEARCH_CONFIG.tavily.apiKey, '');
});

test('parseSearchConfigStrict throws on missing required fields', () => {
  assertThrows(() => parseSearchConfigStrict({}), Error);
  assertThrows(() => parseSearchConfigStrict({ provider: 'disabled' }), Error);
  assertThrows(
    () => parseSearchConfigStrict({ provider: 'disabled', tavily: { apiKey: '' } }),
    Error,
    'microsoftGrounding',
  );
  assertThrows(
    () => parseSearchConfigStrict({ provider: 'disabled', tavily: {}, microsoftGrounding: { apiKey: '' } }),
    Error,
    'tavily.apiKey',
  );
});

test('loadSearchConfig surfaces malformed D1 stored JSON instead of silently defaulting', async () => {
  const db = new FakeD1Database();
  db.config.set('search_config', 'not-json');
  initRepo(new D1Repo(db));

  await assertRejects(() => loadSearchConfig(), Error, 'Malformed search_config JSON');
});

test('saveSearchConfig stores normalized D1 JSON', async () => {
  const db = new FakeD1Database();
  initRepo(new D1Repo(db));

  const saved = await saveSearchConfig({
    provider: 'disabled',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftGrounding: { apiKey: '  ms-test  ' },
  });

  assertEquals(saved, {
    provider: 'disabled',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
  });
  assertEquals(db.config.get('search_config'), JSON.stringify(saved));
});
