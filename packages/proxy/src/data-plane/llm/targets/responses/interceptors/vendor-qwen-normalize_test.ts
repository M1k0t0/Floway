import { test } from 'vitest';

import { withVendorQwenResponsesNormalize } from './vendor-qwen-normalize.ts';
import type { RequestContext, ResponsesInvocation } from '../../../interceptors.ts';
import { createHttpStatefulResponsesStore } from '../../../sources/responses/stateful-store.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { eventResult } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  apiKeyUpstreamIds: null,
  runtimeLocation: 'test',
  scheduleBackground: () => {},
  clientStream: false,
  statefulResponsesStore: createHttpStatefulResponsesStore(null, undefined),
};

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: ResponsesPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen'])): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags,
  headers: {},
});

test("vendor-qwen translates canonical reasoning.effort: 'none' into top-level enable_thinking:false", async () => {
  const input = invocation({
    model: 'qwen-max',
    input: 'hi',
    reasoning: { effort: 'none' },
  });

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.enable_thinking, false);
});

test('vendor-qwen leaves a real reasoning.effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'high' } });

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'high' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('vendor-qwen early-returns when its flag is not set on the binding', async () => {
  const input = invocation({ model: 'qwen-max', input: 'hi', reasoning: { effort: 'none' } }, new Set());

  await withVendorQwenResponsesNormalize(input, stubRequest, okEvents);

  assertEquals(input.payload.reasoning, { effort: 'none' });
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
