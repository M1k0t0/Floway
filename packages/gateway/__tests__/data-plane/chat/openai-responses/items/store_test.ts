import { afterEach, describe, expect, test, vi } from 'vitest';

import { hashOpenAIResponsesItem } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { createNonOpenAIResponsesSourceStore, createOpenAIResponsesHttpStore, createOpenAIResponsesWsSession, LayeredOpenAIResponsesStatefulStore, MemoryOpenAIResponsesStatefulBacking } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { quantizeOpenAIResponsesRefreshedAt } from '../../../../../src/repo/openai-responses-retention.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';
import type { OpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DAY = Date.UTC(2026, 0, 10);

type AdditionalToolsItem = Extract<OpenAIResponsesInputItem, { type: 'additional_tools' }>;
type MessageItem = Extract<OpenAIResponsesInputItem, { type: 'message' }>;

const liteToolSource = (id: string, tools: readonly OpenAIResponsesTool[]): AdditionalToolsItem => ({
  type: 'additional_tools', id, role: 'developer', tools: [...tools],
});

const liteInstructionsSource = (id: string, text: string): MessageItem => ({
  type: 'message', id, role: 'developer', content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
} as MessageItem);

const messageItem = (id: string, content: string): MessageItem => ({
  type: 'message', id, role: 'user', content,
});

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
    await store.stageSourceItems([liteInstructionsSource('source_store_false', 'private context')]);
    await store.commitSnapshot('resp_none', 'append', []);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_none', 0)).toBeNull();
  });

  test('HTTP store=false skips snapshot staging for idless input', async () => {
    initRepo(new InMemoryRepo());
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.stageSourceItems([liteInstructionsSource('source_store_false', 'private context')]);

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

  test('WebSocket store=true promotes every direct source row from a local snapshot without a codec callback', async () => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const source = liteToolSource('source_ws_tools', [
      { type: 'function', name: 'read_ws', parameters: { type: 'object' } },
    ]);
    const history = messageItem('msg_ws_local', 'local request');
    const local = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    await local.stageInputItems([source, history]);
    await local.stageSourceItems([source]);
    await local.commitSnapshot('resp_ws_local', 'append', []);

    const foreignKey = session.createStore(testOpenAIResponsesStatePolicy('key-b'), Date.now(), true);
    expect(await foreignKey.loadSnapshot('resp_ws_local')).toBeNull();

    const durable = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const promoted = await durable.loadSnapshot('resp_ws_local');
    expect(promoted).toMatchObject({
      itemIds: [source.id!, history.id!],
      sourceItemIds: [source.id!],
    });
    expect(durable.getItemById(source.id!)?.payload.item).toEqual(source);

    // A later Standard continuation does not stage sources, but the direct
    // source references loaded above still carry forward.
    const standardHistory = messageItem('msg_ws_standard', 'standard continuation');
    await durable.stageInputItems([standardHistory]);
    await durable.commitSnapshot('resp_ws_standard', 'append', []);
    const durableSnapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_ws_standard', 0);
    expect(durableSnapshot).toMatchObject({
      itemIds: [source.id!, history.id!, standardHistory.id!],
      sourceItemIds: [source.id!],
    });
    if (durableSnapshot === null) throw new Error('Expected durable snapshot');
    const durableIds = [...new Set([...durableSnapshot.itemIds, ...(durableSnapshot.sourceItemIds ?? [])])];
    const rows = await repo.openaiResponsesItems.lookupMany('key-a', durableIds, 0);
    expect(rows).toHaveLength(durableIds.length);
    expect(rows.every(row => row.payload.item !== null && row.payload.private === undefined)).toBe(true);
    expect(await repo.openaiResponsesSnapshots.lookup('key-b', 'resp_ws_local', 0)).toBeNull();
    expect(await repo.openaiResponsesItems.lookupMany('key-b', durableIds, 0)).toEqual([]);

    const http = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect((await http.loadSnapshot('resp_ws_standard'))?.sourceItemIds).toEqual([source.id]);
    expect(http.getItemById(source.id!)?.payload.item).toEqual(source);
  });

  test('loadSnapshot promotes the full direct-source union across layered backings', async () => {
    const snapshotBacking = new MemoryOpenAIResponsesStatefulBacking();
    const sourceBacking = new MemoryOpenAIResponsesStatefulBacking();
    const promotedBacking = new MemoryOpenAIResponsesStatefulBacking();
    const history = {
      id: 'msg_layered_history',
      apiKeyId: 'key-a',
      payload: { item: messageItem('msg_layered_history', 'history') },
      itemHash: 'layered-history-hash',
      refreshedAt: Date.now(),
    };
    const source = {
      id: 'source_layered',
      apiKeyId: 'key-a',
      payload: { item: liteToolSource('source_layered', [{ type: 'function', name: 'layered', parameters: { type: 'object' } }]) },
      itemHash: 'layered-source-hash',
      refreshedAt: Date.now(),
    };
    await snapshotBacking.insertItems([history]);
    await sourceBacking.insertItems([source]);
    await snapshotBacking.insertSnapshot({
      id: 'resp_layered',
      apiKeyId: 'key-a',
      itemIds: [history.id],
      sourceItemIds: [source.id, source.id],
      refreshedAt: Date.now(),
    });
    const store = new LayeredOpenAIResponsesStatefulStore({
      apiKeyId: 'key-a',
      reads: [snapshotBacking, sourceBacking],
      writes: [promotedBacking],
    });

    expect(await store.loadSnapshot('resp_layered')).toMatchObject({
      itemIds: [history.id],
      sourceItemIds: [source.id, source.id],
    });
    expect(store.getItemById(source.id)?.payload.item).toEqual(source.payload.item);
    expect(await promotedBacking.lookupItems({ apiKeyId: 'key-a', ids: [history.id, source.id], itemHashes: [] }))
      .toHaveLength(2);
    expect(await promotedBacking.lookupSnapshot('key-a', 'resp_layered')).toMatchObject({
      itemIds: [history.id],
      sourceItemIds: [source.id, source.id],
    });
  });

  test('Responses Lite snapshots keep source IDs direct, ordered and duplicated without allocating private rows', async () => {
    const repo = installRepo();
    const inserts = vi.spyOn(repo.openaiResponsesItems, 'insertMany');
    const originalTools = liteToolSource('source_tools_original', [
      { type: 'function', name: 'read_original', parameters: { type: 'object' } },
    ]);
    const originalToolsCopy = structuredClone(originalTools);
    const originalInstructions = liteInstructionsSource('source_instructions_original', 'original instructions');
    const originalHistory = messageItem('msg_original', 'original request');
    const first = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    await first.stageInputItems([originalTools, originalInstructions, originalHistory]);
    await first.stageSourceItems([
      originalInstructions,
      originalTools,
      { type: 'item_reference', id: originalInstructions.id! },
    ]);
    // Both staging paths must retain their own clones of immutable input rows.
    (originalTools.tools[0] as { name: string }).name = 'mutated after staging';
    await first.commitSnapshot('resp_original', 'append', []);

    const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_original', 0);
    expect(snapshot).toMatchObject({
      itemIds: [originalTools.id!, originalInstructions.id!, originalHistory.id!],
      sourceItemIds: [originalInstructions.id!, originalTools.id!, originalInstructions.id!],
    });
    const rows = await repo.openaiResponsesItems.lookupMany(
      'key-a', [originalTools.id!, originalInstructions.id!, originalHistory.id!], 0,
    );
    expect(rows.map(row => row.payload.item)).toEqual([originalToolsCopy, originalInstructions, originalHistory]);
    const written = inserts.mock.calls.flatMap(([items]) => items);
    expect(written.map(row => row.id)).toEqual([originalTools.id!, originalInstructions.id!, originalHistory.id!]);
    expect(written.every(row => row.payload.item !== null && row.payload.private === undefined)).toBe(true);

    const continuation = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const loaded = await continuation.loadSnapshot('resp_original');
    if (loaded?.sourceItemIds === undefined) throw new Error('Expected direct source references');
    // Callers cannot mutate the store's retained history or source ordering.
    loaded.itemIds.reverse();
    (loaded.sourceItemIds as string[]).reverse();
    const mutableSource = continuation.getItemById(originalTools.id!)!;
    ((mutableSource.payload.item as { tools: Array<{ name: string }> }).tools[0]!).name = 'caller mutation';
    expect(continuation.getItemById(originalTools.id!)?.payload.item).toEqual(originalToolsCopy);

    const standardHistory = messageItem('msg_standard_after_lite', 'standard continuation');
    await continuation.stageInputItems([standardHistory]);
    await continuation.commitSnapshot('resp_standard_after_lite', 'append', []);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_standard_after_lite', 0)).toMatchObject({
      itemIds: [originalTools.id!, originalInstructions.id!, originalHistory.id!, standardHistory.id!],
      sourceItemIds: [originalInstructions.id!, originalTools.id!, originalInstructions.id!],
    });
  });

  test('loaded source refs carry by default while explicit staging replaces or clears them', async () => {
    const repo = installRepo();
    const policy = testOpenAIResponsesStatePolicy();
    const originalSource = liteToolSource('source_original', [
      { type: 'function', name: 'original', parameters: { type: 'object' } },
    ]);
    const replacementSource = liteInstructionsSource('source_replacement', 'replacement instructions');
    const initial = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await initial.stageInputItems([originalSource, messageItem('msg_initial', 'initial')]);
    await initial.stageSourceItems([originalSource]);
    await initial.commitSnapshot('resp_initial', 'append', []);

    // This represents a Standard continuation: no Lite staging call occurs.
    const inherited = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    expect((await inherited.loadSnapshot('resp_initial'))?.sourceItemIds).toEqual([originalSource.id]);
    await inherited.stageInputItems([messageItem('msg_standard', 'standard')]);
    await inherited.commitSnapshot('resp_standard', 'append', []);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_standard', 0))?.sourceItemIds).toEqual([originalSource.id]);

    const replaced = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await replaced.loadSnapshot('resp_standard');
    await replaced.stageInputItems([messageItem('msg_replaced', 'replaced')]);
    await replaced.stageSourceItems([replacementSource]);
    await replaced.commitSnapshot('resp_replaced', 'append', []);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_replaced', 0))?.sourceItemIds)
      .toEqual([replacementSource.id]);

    const cleared = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await cleared.loadSnapshot('resp_replaced');
    await cleared.stageInputItems([messageItem('msg_cleared', 'cleared')]);
    await cleared.stageSourceItems(undefined);
    await cleared.commitSnapshot('resp_cleared', 'append', []);
    const clearedSnapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_cleared', 0);
    expect(clearedSnapshot).not.toHaveProperty('sourceItemIds');

    const empty = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await empty.stageSourceItems([]);
    await empty.commitSnapshot('resp_explicit_empty', 'replace', []);
    const emptySnapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_explicit_empty', 0);
    expect(emptySnapshot).toMatchObject({ itemIds: [], sourceItemIds: [] });
    expect(Number.isFinite(emptySnapshot?.refreshedAt)).toBe(true);
  });

  test('Responses Lite replacement refreshes direct source dependencies without putting them in replacement history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + 1_000);
    const repo = installRepo();
    const policy = testOpenAIResponsesStatePolicy();
    const sourceItems = [
      liteToolSource('source_compaction_tools', [{ type: 'function', name: 'read_compaction', parameters: { type: 'object' } }]),
      liteInstructionsSource('source_compaction_instructions', 'compaction instructions'),
    ];
    const sourceItemIds = sourceItems.map(item => item.id!);
    const first = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    await first.stageInputItems([...sourceItems, messageItem('msg_before_compaction', 'before')]);
    await first.stageSourceItems(sourceItems);
    await first.commitSnapshot('resp_before_compaction', 'append', []);

    vi.setSystemTime(TEST_DAY + DAY_MS + 1_000);
    const replacement = createOpenAIResponsesHttpStore(policy, Date.now(), true);
    expect((await replacement.loadSnapshot('resp_before_compaction'))?.sourceItemIds).toEqual(sourceItemIds);
    const compactedOutput = {
      id: 'msg_compacted',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_compacted', role: 'assistant', content: [] } },
      itemHash: 'compacted-output-hash',
      refreshedAt: Date.now(),
    };
    await replacement.persistOutputItem(compactedOutput);
    await replacement.commitSnapshot('resp_compacted', 'replace', [compactedOutput.id]);

    const compacted = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_compacted', 0);
    expect(compacted).toMatchObject({ itemIds: [compactedOutput.id], sourceItemIds });
    const dependencies = await repo.openaiResponsesItems.lookupMany('key-a', [...sourceItemIds, compactedOutput.id], 0);
    expect(dependencies).toHaveLength(sourceItemIds.length + 1);
    expect(dependencies.every(row => row.refreshedAt === TEST_DAY + DAY_MS)).toBe(true);

    const reader = createOpenAIResponsesHttpStore(policy, Date.now(), false);
    expect((await reader.loadSnapshot('resp_compacted'))?.itemIds).toEqual([compactedOutput.id]);
    expect(sourceItemIds.map(id => reader.getItemById(id)?.payload.item)).toEqual(sourceItems);
  });

  test('a missing direct source dependency prevents a partial snapshot refresh or promotion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + 1_000);
    const repo = installRepo();
    const history = {
      id: 'msg_valid_history',
      apiKeyId: 'key-a',
      payload: { item: messageItem('msg_valid_history', 'valid history') },
      itemHash: 'valid-history-hash',
      refreshedAt: TEST_DAY,
    };
    const source = {
      id: 'source_valid',
      apiKeyId: 'key-a',
      payload: { item: liteToolSource('source_valid', [{ type: 'function', name: 'valid_source', parameters: { type: 'object' } }]) },
      itemHash: 'valid-source-hash',
      refreshedAt: TEST_DAY,
    };
    await repo.openaiResponsesItems.insertMany([history, source], 0);
    await repo.openaiResponsesSnapshots.insert({
      id: 'resp_missing_source',
      apiKeyId: 'key-a',
      itemIds: [history.id],
      sourceItemIds: [source.id, 'source_missing'],
      refreshedAt: TEST_DAY,
    });

    vi.setSystemTime(TEST_DAY + DAY_MS + 1_000);
    const reader = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(await reader.loadSnapshot('resp_missing_source')).toBeNull();
    const existingRows = await repo.openaiResponsesItems.lookupMany('key-a', [history.id, source.id], 0);
    expect(existingRows).toHaveLength(2);
    expect(existingRows.every(row => row.refreshedAt === TEST_DAY)).toBe(true);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_missing_source', 0))?.refreshedAt).toBe(TEST_DAY);
  });

  test('incremental direct source snapshots retain schemas once in ordinary item rows', async () => {
    const repo = installRepo();
    const inserts = vi.spyOn(repo.openaiResponsesItems, 'insertMany');
    const policy = testOpenAIResponsesStatePolicy();
    const turns = 20;
    const toolsPerTurn = 5;
    const sourceItemIds: string[] = [];
    const historyItemIds: string[] = [];
    const snapshots: Array<{ sourceItemIds?: readonly string[] }> = [];
    let previousResponseId: string | undefined;

    for (let turn = 0; turn < turns; turn += 1) {
      const store = createOpenAIResponsesHttpStore(policy, Date.now(), true);
      if (previousResponseId !== undefined) {
        expect((await store.loadSnapshot(previousResponseId))?.sourceItemIds).toEqual(sourceItemIds);
      }
      const sourceId = `source_turn_${String(turn)}`;
      const historyId = `msg_turn_${String(turn)}`;
      const source = liteToolSource(sourceId, Array.from({ length: toolsPerTurn }, (_, tool) => ({
        type: 'function' as const,
        name: `turn_${String(turn)}_tool_${String(tool)}`,
        parameters: { type: 'object' },
      })));
      await store.stageInputItems([source, messageItem(historyId, `turn ${String(turn)}`)]);
      await store.stageSourceItems([
        ...sourceItemIds.map(id => ({ type: 'item_reference' as const, id })),
        source,
      ]);
      const responseId = `resp_turn_${String(turn)}`;
      await store.commitSnapshot(responseId, 'append', []);
      sourceItemIds.push(sourceId);
      historyItemIds.push(historyId);
      const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', responseId, 0);
      expect(snapshot?.sourceItemIds).toEqual(sourceItemIds);
      expect(snapshot).not.toHaveProperty('contextItemId');
      snapshots.push(snapshot!);
      previousResponseId = responseId;
    }

    const sourceRows = await repo.openaiResponsesItems.lookupMany('key-a', sourceItemIds, 0);
    expect(sourceRows).toHaveLength(turns);
    const storedSchemaCount = sourceRows.reduce((count, row) => {
      const item = row.payload.item as OpenAIResponsesInputItem;
      return count + (item.type === 'additional_tools' ? item.tools.length : 0);
    }, 0);
    expect(storedSchemaCount).toBe(turns * toolsPerTurn);
    // Direct source IDs grow in snapshots, but each schema body is stored once
    // in the ordinary items table: no cumulative private context rows exist.
    const writtenIds = new Set(inserts.mock.calls.flatMap(([items]) => items.map(item => item.id)));
    expect([...writtenIds].toSorted()).toEqual([...sourceItemIds, ...historyItemIds].toSorted());
    expect(snapshots.every(snapshot => snapshot.sourceItemIds !== undefined)).toBe(true);
    expect(inserts.mock.calls.flatMap(([items]) => items).every(row => row.payload.item !== null && row.payload.private === undefined)).toBe(true);
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
