import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInFlightForTesting, fetchUpstreamModelsCached } from './models-cache.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { directFetcher, type ModelProviderInstance, type UpstreamModel, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

const aModel = (id: string): UpstreamModel => stubUpstreamModel({ id });

const stubInstance = (
  upstreamId: string,
  fetchFn: () => Promise<UpstreamModel[]>,
  providerKind: UpstreamProviderKind = 'custom',
): ModelProviderInstance => ({
  upstream: upstreamId,
  providerKind,
  name: upstreamId,
  disabledPublicModelIds: [],
  modelPrefix: null,
  supportsResponsesItemReference: false,
  provider: stubProvider({ getProvidedModels: fetchFn }),
});

const setupRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const codexRecord = (flagOverrides: Record<string, boolean> = {}): UpstreamRecord => ({
  id: 'up_codex',
  provider: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {},
  state: null,
  flagOverrides,
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

beforeEach(() => {
  clearInFlightForTesting();
});

describe('fetchUpstreamModelsCached', () => {
  test('cold cache: fetches, stores, returns models', async () => {
    const repo = setupRepo();
    const fetchFn = vi.fn(async () => [aModel('m1')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['m1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['m1']);
  });

  test('within SOFT: no fetch, returns stored', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('cached')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['cached']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('within SOFT: codex cached models are rehydrated with current default flags', async () => {
    const repo = setupRepo();
    await repo.upstreams.save(codexRecord());
    await repo.modelsCache.put('up_codex', { fetchedAt: Date.now() - 1000, models: [aModel('cached')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_codex', fetchFn, 'codex'),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['cached']);
    expect([...result[0]!.enabledFlags].sort()).toEqual(['promote-system-to-developer', 'strip-billing-attribution']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('within SOFT: codex cached model flags honor current operator opt-out', async () => {
    const repo = setupRepo();
    await repo.upstreams.save(codexRecord({ 'promote-system-to-developer': false }));
    await repo.modelsCache.put('up_codex', {
      fetchedAt: Date.now() - 1000,
      models: [stubUpstreamModel({
        id: 'cached',
        enabledFlags: new Set(['promote-system-to-developer', 'strip-billing-attribution']),
      })],
    });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_codex', fetchFn, 'codex'),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['cached']);
    expect([...result[0]!.enabledFlags].sort()).toEqual(['strip-billing-attribution']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('past SOFT within HARD: returns stored + schedules revalidate', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('past HARD: blocks on fetch', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 25 * 60 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('force=true: bypasses cache and blocks on fetch', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('two concurrent cold callers join one fetch', async () => {
    setupRepo();
    let resolveFetch: ((v: UpstreamModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<UpstreamModel[]>(r => { resolveFetch = r; }));
    const instance = stubInstance('up_a', fetchFn);

    const p1 = fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });
    const p2 = fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });

    // Yield once so both calls reach the L1 lookup before we resolve the fetch.
    await Promise.resolve();
    resolveFetch!([aModel('m1')]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.map(m => m.id)).toEqual(['m1']);
    expect(r2.map(m => m.id)).toEqual(['m1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('background revalidate failure preserves stored row and writes lastError', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['stale']);
    expect(row?.lastError?.message).toContain('boom');
  });

  test('cold + fetch failure: throws and writes nothing', async () => {
    const repo = setupRepo();
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    )).rejects.toThrow('boom');

    expect(await repo.modelsCache.get('up_a')).toBeNull();
  });

  test('force=true + fetch failure: throws (no fallback) and annotates lastError', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    )).rejects.toThrow('boom');

    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['stored']);
    expect(row?.lastError?.message).toContain('boom');
  });
});
