import { afterEach, describe, expect, test, vi } from 'vitest';

import { hashOpenAIResponsesItem } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { createNonOpenAIResponsesSourceStore, createOpenAIResponsesHttpStore, createOpenAIResponsesWsSession } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { quantizeOpenAIResponsesRefreshedAt } from '../../../../../src/repo/openai-responses-retention.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DAY = Date.UTC(2026, 0, 10);

afterEach(() => vi.useRealTimers());

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

describe('OpenAIResponsesStatefulStore', () => {
  test('HTTP store=false performs no state writes', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(store.writesState).toBe(false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.stageSnapshotContext({ instructions: 'private context' });
    await store.commitSnapshot('resp_none', 'append', []);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_none', 0)).toBeNull();
  });

  test('HTTP store=false skips snapshot staging for idless input', async () => {
    initRepo(new InMemoryRepo());
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.stageSnapshotContext({ instructions: 'private context' });

    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  test('HTTP store=false still reads durably-stored items and snapshots', async () => {
    installRepo();
    const writer = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await writer.persistOutputItem(output);
    await writer.commitSnapshot('resp_saved', 'append', [output.id]);

    // A store=false turn writes nothing but must still resolve a
    // previous_response_id and echoed item ids against durable state.
    const reader = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(reader.writesState).toBe(false);
    expect((await reader.loadSnapshot('resp_saved'))?.itemIds).toEqual([output.id]);
    expect(reader.getItemById(output.id)).toMatchObject({ id: 'msg_public' });
  });

  test('HTTP default stores complete input and output snapshots', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), undefined);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_saved', 'append', [output.id]);

    const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_saved', 0);
    expect(snapshot?.itemIds).toHaveLength(2);
    const [storedOutput] = await repo.openaiResponsesItems.lookupMany('key-a', [output.id], 0);
    expect(storedOutput).toMatchObject({ ...output, refreshedAt: snapshot?.refreshedAt });
  });

  test('reuses an input item hash between lookup and staging', async () => {
    installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    let contentReads = 0;
    const input = { type: 'message' as const, role: 'user' as const } as { type: 'message'; role: 'user'; content: string };
    Object.defineProperty(input, 'content', {
      enumerable: true,
      get() {
        contentReads += 1;
        return 'hello';
      },
    });

    await store.loadInputItems([input], [input]);
    expect(contentReads).toBe(1);
    await store.stageInputItems([input]);

    // Staging reads the item once to clone it into request-owned state, but
    // does not traverse it again to recompute the lookup hash.
    expect(contentReads).toBe(2);
  });

  test('replace snapshots persist only their output state', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'discarded history' };
    await store.stageInputItems([input]);
    const output = {
      id: 'cmp_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'compaction', id: 'cmp_public', encrypted_content: 'opaque' } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_compact', 'replace', [output.id]);

    expect(await repo.openaiResponsesItems.lookupManyByItemHash('key-a', [await hashOpenAIResponsesItem(input)], 0)).toEqual([]);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_compact', 0))?.itemIds).toEqual([output.id]);
  });

  test('append snapshots refresh the lifetime of every referenced item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const initialRefreshedAt = TEST_DAY - DAY_MS / 2;
    const item = {
      id: 'msg_old',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_old', role: 'assistant', content: [] } },
      itemHash: 'old-hash',
      refreshedAt: initialRefreshedAt,
    };
    await repo.openaiResponsesItems.insertMany([item], 0);
    await repo.openaiResponsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: initialRefreshedAt });
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(await store.loadSnapshot('resp_old')).not.toBeNull();
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_old', 0)).not.toBeNull();
    await store.commitSnapshot('resp_new', 'append', []);

    const [refreshed] = await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0);
    expect(refreshed.refreshedAt).toBe(TEST_DAY);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_new', 0))?.itemIds).toEqual([item.id]);
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
  });

  test('same-day snapshot reuse does not call the durable item refresher', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const item = {
      id: 'msg_current_day',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_current_day', role: 'assistant', content: [] } },
      itemHash: 'current-day-hash',
      refreshedAt: TEST_DAY + 1_000,
    };
    await repo.openaiResponsesItems.insertMany([item], 0);
    await repo.openaiResponsesSnapshots.insert({ id: 'resp_current_day', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: item.refreshedAt });
    const refreshItems = vi.spyOn(repo.openaiResponsesItems, 'refreshMany');

    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(await store.loadSnapshot('resp_current_day')).not.toBeNull();
    await store.commitSnapshot('resp_current_day_next', 'append', []);

    expect(refreshItems).not.toHaveBeenCalled();
  });

  test('a store crossing UTC midnight refreshes items into the new day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS - 1_000);
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg_before_midnight',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_before_midnight', role: 'assistant', content: [] } },
      itemHash: 'before-midnight-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);

    vi.setSystemTime(TEST_DAY + DAY_MS + 1_000);
    await store.commitSnapshot('resp_after_midnight', 'append', [output.id]);

    expect((await repo.openaiResponsesItems.lookupMany('key-a', [output.id], 0))[0].refreshedAt).toBe(TEST_DAY + DAY_MS);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_after_midnight', 0))?.refreshedAt).toBe(TEST_DAY + DAY_MS);
  });

  test('a request keeps its retention snapshot when the visibility window ends mid-request', async () => {
    vi.useFakeTimers();
    const retentionSeconds = 24 * 60 * 60;
    const requestStartedAt = TEST_DAY + 2 * DAY_MS - 1_000;
    vi.setSystemTime(requestStartedAt);
    const repo = installRepo();
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: retentionSeconds });
    const item = {
      id: 'msg_cutoff_edge',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_cutoff_edge', role: 'assistant', content: [] } },
      itemHash: 'cutoff-edge-hash',
      refreshedAt: TEST_DAY + DAY_MS,
    };
    await repo.openaiResponsesItems.insertMany([item], 0);
    const store = createOpenAIResponsesHttpStore({ id: 'key-a', openaiResponsesRetentionSeconds: retentionSeconds }, requestStartedAt, true);

    vi.setSystemTime(TEST_DAY + 3 * DAY_MS + 1_000);
    const reference = { type: 'item_reference' as const, id: item.id };
    await store.loadInputItems([reference], []);
    await store.stageInputItems([reference]);
    await store.commitSnapshot('resp_after_cutoff', 'append', []);

    expect((await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt)
      .toBe(TEST_DAY + 3 * DAY_MS);
  });

  test('append snapshots refresh direct-id and content-hash input reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const directInput = { type: 'message' as const, id: 'msg_direct', role: 'user' as const, content: 'direct' };
    const hashedInput = { type: 'message' as const, role: 'user' as const, content: 'hashed' };
    const initialRefreshedAt = TEST_DAY - DAY_MS / 2;
    const directRow = {
      id: directInput.id,
      apiKeyId: 'key-a',
      payload: { item: directInput },
      itemHash: await hashOpenAIResponsesItem(directInput),
      refreshedAt: initialRefreshedAt,
    };
    const hashedRow = {
      id: 'msg_hashed',
      apiKeyId: 'key-a',
      payload: { item: hashedInput },
      itemHash: await hashOpenAIResponsesItem(hashedInput),
      refreshedAt: initialRefreshedAt,
    };
    await repo.openaiResponsesItems.insertMany([directRow, hashedRow], 0);
    await store.loadInputItems([directInput, hashedInput], [directInput, hashedInput]);
    await store.stageInputItems([directInput, hashedInput]);
    await store.commitSnapshot('resp_reused', 'append', []);

    const refreshed = await repo.openaiResponsesItems.lookupMany('key-a', [directRow.id, hashedRow.id], 0);
    expect(refreshed.every(row => row.refreshedAt === TEST_DAY)).toBe(true);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_reused', 0))?.itemIds).toEqual([directRow.id, hashedRow.id]);
  });

  test('snapshot lifetime follows a newer backing item timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'future lifetime' };
    const futureRefreshedAt = TEST_DAY + DAY_MS + 60_000;
    const quantizedFutureRefreshedAt = quantizeOpenAIResponsesRefreshedAt(futureRefreshedAt);
    const row = {
      id: 'msg_future',
      apiKeyId: 'key-a',
      payload: { item: input },
      itemHash: await hashOpenAIResponsesItem(input),
      refreshedAt: futureRefreshedAt,
    };
    await repo.openaiResponsesItems.insertMany([row], 0);
    await store.loadInputItems([input], [input]);
    await store.stageInputItems([input]);
    await store.commitSnapshot('resp_future', 'append', []);

    expect((await repo.openaiResponsesItems.lookupMany('key-a', [row.id], 0))[0].refreshedAt).toBe(quantizedFutureRefreshedAt);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_future', 0))?.refreshedAt).toBe(quantizedFutureRefreshedAt);
  });

  test('disable between output-item done and terminal preserves the in-flight request snapshot', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg-before-disable',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg-before-disable', role: 'assistant', content: [] } },
      itemHash: 'before-disable-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: 0 });
    await store.commitSnapshot('resp-after-disable', 'append', [output.id]);

    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp-after-disable', 0)).not.toBeNull();
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const first = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(first.writesState).toBe(true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append', []);

    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_local', 0)).toBeNull();
    expect(await session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('WebSocket store=true promotes every item referenced by a prior local snapshot', async () => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const local = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    await local.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await local.stageSnapshotContext({ instructions: 'local instructions' });
    await local.commitSnapshot('resp_local', 'append', []);

    const durable = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const previous = await durable.loadSnapshot('resp_local');
    expect(previous?.contextItemId).toBeDefined();
    await durable.stageSnapshotContext(durable.getItemById(previous!.contextItemId!)?.payload.private);
    await durable.stageInputItems([{ type: 'message', role: 'user', content: 'durable' }]);
    await durable.commitSnapshot('resp_durable', 'append', []);

    const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_durable', 0);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected durable snapshot');
    expect(await repo.openaiResponsesItems.lookupMany('key-a', snapshot.itemIds, 0)).toHaveLength(snapshot.itemIds.length);
    expect(snapshot.contextItemId).toBe(previous!.contextItemId);
    const http = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect((await http.loadSnapshot('resp_durable'))?.contextItemId).toBe(snapshot.contextItemId);
    expect(http.getItemById(snapshot.contextItemId!)?.payload.private).toEqual({ instructions: 'local instructions' });
  });

  test.each([
    ['store=false', TEST_OPENAI_RESPONSES_RETENTION_SECONDS, false],
    ['retention off', 0, true],
  ] as const)('WebSocket %s retains private context without public history or durable rows', async (_name, retention, store) => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const policy = { ...testOpenAIResponsesStatePolicy(), openaiResponsesRetentionSeconds: retention };
    const first = session.createStore(policy, Date.now(), store);
    const context = { tools: [{ name: 'read_file' }], instructions: 'read before answering' };
    await first.stageSnapshotContext(context);
    context.tools[0].name = 'mutated';
    await first.commitSnapshot('resp_context_only', 'append', []);

    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_context_only', 0)).toBeNull();
    const next = session.createStore(policy, Date.now(), store);
    const snapshot = await next.loadSnapshot('resp_context_only');
    expect(snapshot?.itemIds).toEqual([]);
    expect(Number.isFinite(snapshot?.refreshedAt)).toBe(true);
    expect(snapshot?.contextItemId).toBeDefined();
    const row = next.getItemById(snapshot!.contextItemId!);
    expect(row?.payload).toEqual({ item: null, private: { tools: [{ name: 'read_file' }], instructions: 'read before answering' } });
    (row!.payload.private as typeof context).tools[0].name = 'changed after reading';
    expect(next.getItemById(snapshot!.contextItemId!)?.payload.private).toEqual({ tools: [{ name: 'read_file' }], instructions: 'read before answering' });
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [snapshot!.contextItemId!], 0)).toEqual([]);
  });

  test('context follows the referenced branch and survives compact replacement without entering history', async () => {
    const repo = installRepo();
    const policy = testOpenAIResponsesStatePolicy();
    const initial = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await initial.stageInputItems([{ type: 'message', role: 'user', content: 'initial' }]);
    await initial.stageSnapshotContext({ instructions: 'initial instructions' });
    await initial.commitSnapshot('resp_initial', 'append', []);
    const first = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_initial', 0);

    const updated = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await updated.loadSnapshot('resp_initial');
    await updated.stageSnapshotContext({ instructions: 'updated instructions' });
    await updated.commitSnapshot('resp_updated', 'append', []);
    const updatedSnapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_updated', 0);
    expect(updatedSnapshot?.contextItemId).not.toBe(first?.contextItemId);

    const fork = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    const original = await fork.loadSnapshot('resp_initial');
    await fork.stageSnapshotContext(fork.getItemById(original!.contextItemId!)?.payload.private);
    await fork.commitSnapshot('resp_compact', 'replace', []);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_compact', 0)).toMatchObject({
      itemIds: [], contextItemId: first!.contextItemId,
    });
    expect(updatedSnapshot?.itemIds).toEqual(first?.itemIds);
  });

  test('loading a context does not implicitly inherit it and staging undefined clears it', async () => {
    const repo = installRepo();
    const policy = testOpenAIResponsesStatePolicy();
    const first = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'initial' }]);
    await first.stageSnapshotContext({ instructions: 'initial instructions' });
    await first.commitSnapshot('resp_initial', 'append', []);

    for (const stageThenClear of [false, true]) {
      const next = createOpenAIResponsesHttpStore(policy, Date.now(), true);
      await next.loadSnapshot('resp_initial');
      if (stageThenClear) {
        await next.stageSnapshotContext({ instructions: 'temporary instructions' });
        await next.stageSnapshotContext(undefined);
      }
      const responseId = `resp_standard_${String(stageThenClear)}`;
      await next.commitSnapshot(responseId, 'append', []);
      const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', responseId, 0);
      expect(snapshot?.itemIds).toHaveLength(1);
      expect(snapshot).not.toHaveProperty('contextItemId');
    }
  });

  test('a snapshot with missing private context cannot be partially resumed', async () => {
    const repo = installRepo();
    const policy = testOpenAIResponsesStatePolicy();
    const initial = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await initial.stageInputItems([{ type: 'message', role: 'user', content: 'initial' }]);
    await initial.commitSnapshot('resp_initial', 'append', []);
    const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_initial', 0);
    await repo.openaiResponsesSnapshots.insert({ ...snapshot!, id: 'resp_missing_context', contextItemId: 'missing' });

    const next = createOpenAIResponsesHttpStore(policy, Date.now(), false);
    expect(await next.loadSnapshot('resp_missing_context')).toBeNull();
  });

  test('per-attempt private payloads reset on each beginAttempt', () => {
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    store.beginAttempt(new Map([['item', { first: true }]]));

    expect(store.getPrivatePayload('item')).toEqual({ first: true });

    store.registerPrivatePayload('ws_aabbccdd', { value: 2 });
    expect(store.getPrivatePayload('ws_aabbccdd')).toEqual({ value: 2 });

    store.beginAttempt(new Map());
    expect(store.getPrivatePayload('item')).toBeUndefined();
    expect(store.getPrivatePayload('ws_aabbccdd')).toBeUndefined();
  });

  test('non-OpenAI-Responses-source store holds request-private tool state but persists and reads nothing', async () => {
    // Translated sources (Anthropic Messages/Gemini generateContent/OpenAI Chat Completions) still run the server-tool shim,
    // whose per-attempt private-payload scratchpad lives on the store; the
    // no-backing store keeps that working without any durable state.
    const store = createNonOpenAIResponsesSourceStore('key-a');
    expect(store.writesState).toBe(false);
    store.beginAttempt(new Map());
    store.registerPrivatePayload('ws_aabbccdd', { ir: 'search result' });
    expect(store.getPrivatePayload('ws_aabbccdd')).toEqual({ ir: 'search result' });
    expect(store.getItemById('anything')).toBeUndefined();
    expect(await store.loadSnapshot('resp_x')).toBeNull();
  });
});
