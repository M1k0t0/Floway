import { test } from 'vitest';

import { buildCustomUpstreamRecord, requestAppWithWarmModels as requestApp, setupAppTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

type TargetApi = 'openaiChatCompletions' | 'anthropicMessages';
const namespace = {
  type: 'namespace', name: 'payments', description: 'Read-only access. Never charge the account.',
  tools: [
    { type: 'function', name: 'read', description: 'Read account details.', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'charge', description: 'Charge an account.', parameters: { type: 'object', properties: {} } },
  ],
};
const setup = async (target: TargetApi) => await setupAppTest({
  copilotUpstream: buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://custom.example.com', authStyle: 'none', ingressHeadersRules: [], endpoints: { [target]: {} },
    },
  }),
});

for (const target of ['openaiChatCompletions', 'anthropicMessages'] as const) {
  for (const stream of [false, true]) {
    test(`HTTP ${target} returns typed 400 for malformed namespace input before dispatch (stream ${stream})`, async () => {
      const { apiKey } = await setup(target);
      let calls = 0;
      const headers = { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' };
      await withMockedFetch(async request => {
        if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'model' }] });
        assertEquals(new URL(request.url).pathname, target === 'openaiChatCompletions' ? '/v1/chat/completions' : '/v1/messages');
        calls++;
        return Response.json({ error: { message: 'Valid control reached upstream', type: 'control' } }, { status: 418 });
      }, async () => {
        const base = { model: 'model', input: 'Read only.', stream, store: false, tools: [namespace] };
        const control = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify(base) });
        assertEquals(control.status, 418);
        await control.text();
        assertEquals(calls, 1, 'valid control must prove the dispatch observer is on the route');
        for (const extra of [
          { tools: [{ ...namespace, tools: null }] },
          { tools: [{ ...namespace, tools: [null] }] },
          { tools: [{ ...namespace, tools: [{ type: 'function', name: 123 }] }] },
          { tools: [{ ...namespace, name: 123 }] },
        ]) {
          const response = await requestApp('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ ...base, ...extra }) });
          const body = await response.json() as { error: { type: string; code: string | null; message: string } };
          assertEquals(response.status, 400, JSON.stringify(body));
          assertEquals(body.error.type, 'invalid_request_error');
          assertEquals(body.error.code, null);
          assertEquals(calls, 1, 'invalid input must not reach the provider serializer');
        }
        await flushBackground();
      });
    });
  }
}
