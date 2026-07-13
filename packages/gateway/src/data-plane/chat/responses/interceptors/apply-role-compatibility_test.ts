import { test } from 'vitest';

import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import type { ResponsesInvocation } from './types.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

const applyRoles = async (
  input: ResponsesInputItem[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: ResponsesInvocation['targetApi'] = 'responses',
): Promise<ResponsesInputItem[]> => {
  const invocation: ResponsesInvocation = {
    payload: { model: 'test-model', input },
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.input;
};

test('leaves roles unchanged without flags or at a translated target', async () => {
  const input: ResponsesInputItem[] = [
    { type: 'message', role: 'system', content: 'rules' },
    { type: 'message', role: 'developer', content: 'developer rules' },
  ];

  assertEquals(await applyRoles(input, new Set()), input);
  assertEquals(await applyRoles(input, new Set(['promote-system-to-developer']), 'chat-completions'), input);
});

test('applies promotion and developer demotion independently', async () => {
  assertEquals(
    await applyRoles(
      [{ type: 'message', role: 'system', content: 'rules' }],
      new Set(['promote-system-to-developer']),
    ),
    [{ type: 'message', role: 'developer', content: 'rules' }],
  );
  assertEquals(
    await applyRoles(
      [{ type: 'message', role: 'developer', content: 'rules' }],
      new Set(['demote-developer-to-system']),
    ),
    [{ type: 'message', role: 'system', content: 'rules' }],
  );
});

test('uses non-message items as the boundary before demoting later system', async () => {
  assertEquals(
    await applyRoles(
      [
        { type: 'message', role: 'system', content: 'base rules' },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'system', content: 'inline rules' },
      ],
      new Set(['demote-interleaved-system-to-user']),
    ),
    [
      { type: 'message', role: 'system', content: 'base rules' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'user', content: 'inline rules' },
    ],
  );
});

test('applies overlapping flags in promotion then demotion order', async () => {
  assertEquals(
    await applyRoles(
      [
        { type: 'message', role: 'system', content: 'base rules' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline rules' },
      ],
      new Set([
        'promote-system-to-developer',
        'demote-developer-to-system',
        'demote-interleaved-system-to-user',
      ]),
    ),
    [
      { type: 'message', role: 'system', content: 'base rules' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'user', content: 'inline rules' },
    ],
  );
});
