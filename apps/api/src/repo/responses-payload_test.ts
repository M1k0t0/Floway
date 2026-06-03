import { test } from 'vitest';

import { parseStoredResponsesPayload, serializeStoredResponsesPayload, sweepExpiredResponsesItemPayloadFiles } from './responses-payload.ts';
import { initFileProvider, MemoryFileProvider } from '../runtime/file-provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('the reserved private payload field round-trips through both inline and file storage', async () => {
  initFileProvider(new MemoryFileProvider());

  const inline = await serializeStoredResponsesPayload('msg_inline', null, 0, {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });
  assertEquals(await parseStoredResponsesPayload('msg_inline', inline), {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });

  // A payload past the inline limit spills its body to the file provider; the
  // private slot must survive that path too.
  const spilled = await serializeStoredResponsesPayload('msg_spilled', null, 0, {
    item: { type: 'message', id: 'msg_big', content: 'x'.repeat(600 * 1024) },
    private: { results: 'preserved' },
  });
  const parsed = await parseStoredResponsesPayload('msg_spilled', spilled);
  assertEquals(parsed?.private, { results: 'preserved' });
});

test('spilled payload file keys include the content hash to avoid overwrites', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const createdAt = Date.UTC(2026, 4, 28, 12);

  const first = await serializeStoredResponsesPayload('msg_same_id', 'key_a', createdAt, {
    item: { type: 'message', id: 'msg_big', content: `a${'x'.repeat(600 * 1024)}` },
  });
  const second = await serializeStoredResponsesPayload('msg_same_id', 'key_a', createdAt, {
    item: { type: 'message', id: 'msg_big', content: `b${'x'.repeat(600 * 1024)}` },
  });

  assertEquals((await files.listKeys('responses-items/v1/expires/')).length, 2);
  assertEquals((await parseStoredResponsesPayload('msg_same_id', first))?.item, { type: 'message', id: 'msg_big', content: `a${'x'.repeat(600 * 1024)}` });
  assertEquals((await parseStoredResponsesPayload('msg_same_id', second))?.item, { type: 'message', id: 'msg_big', content: `b${'x'.repeat(600 * 1024)}` });
});

test('sweepExpiredResponsesItemPayloadFiles deletes every elapsed hour bucket and leaves the current and future buckets intact', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);

  // Two buckets older than the previous hour, the previous hour, the current
  // hour, and a future hour. A bucket is expired iff its hour is strictly
  // before the current hour, so only the first three should be deleted.
  await files.put('responses-items/v1/expires/2026/06/27/08/scope/a.json', new Uint8Array([1]));
  await files.put('responses-items/v1/expires/2026/06/27/09/scope/b.json', new Uint8Array([2]));
  await files.put('responses-items/v1/expires/2026/06/27/10/scope/c.json', new Uint8Array([3]));
  await files.put('responses-items/v1/expires/2026/06/27/11/scope/d.json', new Uint8Array([4]));
  await files.put('responses-items/v1/expires/2026/06/27/12/scope/e.json', new Uint8Array([5]));

  // now=2026-06-27T11:30 — the current hour is 11.
  await sweepExpiredResponsesItemPayloadFiles(Date.UTC(2026, 5, 27, 11, 30));

  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/08/scope/a.json'), null);
  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/09/scope/b.json'), null);
  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/10/scope/c.json'), null);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/11/scope/d.json'))!], [4]);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/12/scope/e.json'))!], [5]);
});
