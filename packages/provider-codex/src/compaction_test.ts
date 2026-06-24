import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callCodexResponsesCompact } from './compaction.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexUpstreamState } from './state.ts';
import { initProviderRepo, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

const compactionSseResponse = (): Response => {
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"cmp_x","type":"compaction","encrypted_content":"PARTIAL"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_x","type":"compaction","encrypted_content":"FULL_BLOB"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null,"usage":{"input_tokens":550,"output_tokens":167,"total_tokens":717}}}\n\n',
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(e));
        c.close();
      },
    }),
    { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) },
  );
};

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', accessToken: null, quotaSnapshot: null };
const model: UpstreamModel = { id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set() };

const upstreamId = 'up';

const freshAccessToken: CodexAccessTokenEntry = {
  token: 'at',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: freshAccessToken }] });
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as CodexUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

describe('callCodexResponsesCompact', () => {
  test('appends compaction_trigger, forces store:false & stream:true, returns rebuilt envelope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactionSseResponse());
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hello' }] },
      headers: new Headers(), effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} }, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.input.at(-1)).toEqual({ type: 'compaction_trigger' });
    expect(sentBody.store).toBe(false);
    expect(sentBody.stream).toBe(true);
    const sentHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(sentHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.request_kind).toBe('compaction');
    expect(turnMetadata.compaction).toEqual({
      trigger: 'manual',
      reason: 'user_requested',
      implementation: 'responses_compaction_v2',
      phase: 'standalone_turn',
      strategy: 'memento',
    });
    expect(sentBody.client_metadata['x-codex-turn-metadata']).toBe(sentHeaders.get('x-codex-turn-metadata'));

    expect(result.result.object).toBe('response.compaction');
    expect(result.result.output).toHaveLength(2);
    expect(result.result.output[1]).toMatchObject({ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' });
  });

  test('errors if upstream returns zero compaction items', async () => {
    const badResponse = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n'));
          c.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null}}\n\n'));
          c.close();
        },
      }),
      { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) },
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(badResponse);
    await expect(callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hi' }] },
      headers: new Headers(), effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} }, call: noopUpstreamCallOptions(),
    })).rejects.toThrow(/compaction/);
  });

  test('propagates upstream ok:false (non-2xx) unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream-error', { status: 500 }));
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hi' }] },
      headers: new Headers(), effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} }, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });
});
