import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { inboundHeadersForUpstream } from './inbound-headers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

describe('inboundHeadersForUpstream', () => {
  test('copies inbound headers and strips the gateway-private set', async () => {
    const app = new Hono();
    let headers: Headers | undefined;
    app.get('/test', c => {
      headers = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', {
      headers: {
        // Mixed-case for `Authorization` exercises Headers' case-insensitive
        // lookup so a scrub spelt 'authorization' still hits a wire header
        // written 'Authorization'.
        'Authorization': 'Bearer gateway-api-key',
        'api-key': 'azure-key',
        'x-api-key': 'gateway-api-key',
        'x-floway-session': 'sess-1',
        'x-goog-api-key': 'goog-key',
        'proxy-authorization': 'Basic abcdef',
        'cookie': 'session=abc',
        'host': 'gateway.example.com',
        'content-type': 'multipart/form-data; boundary=abc',
        'anthropic-beta': 'context-1m',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-sdk/1.0',
      },
    });
    assertExists(headers);
    assertEquals(headers.has('authorization'), false);
    assertEquals(headers.has('api-key'), false);
    assertEquals(headers.has('x-api-key'), false);
    assertEquals(headers.has('x-floway-session'), false);
    assertEquals(headers.has('x-goog-api-key'), false);
    assertEquals(headers.has('proxy-authorization'), false);
    assertEquals(headers.has('cookie'), false);
    assertEquals(headers.has('host'), false);
    assertEquals(headers.has('content-type'), false);
    assertEquals(headers.get('anthropic-beta'), 'context-1m');
    assertEquals(headers.get('anthropic-version'), '2023-06-01');
    assertEquals(headers.get('user-agent'), 'claude-sdk/1.0');
  });

  test('returns a fresh Headers each call so mutations do not leak across requests', async () => {
    const app = new Hono();
    let first: Headers | undefined;
    let second: Headers | undefined;
    app.get('/test', c => {
      first = inboundHeadersForUpstream(c);
      second = inboundHeadersForUpstream(c);
      return c.text('ok');
    });
    await app.request('/test', { headers: { 'anthropic-beta': 'context-1m' } });
    assertExists(first);
    assertExists(second);
    if (first === second) throw new Error('inboundHeadersForUpstream returned the same Headers instance twice');
    first.set('anthropic-beta', 'mutated');
    assertEquals(second.get('anthropic-beta'), 'context-1m');
  });
});
