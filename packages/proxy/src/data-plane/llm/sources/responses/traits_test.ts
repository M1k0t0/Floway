import { test } from 'vitest';

import { responsesTraits } from './traits.ts';
import { assertEquals } from '@floway-dev/test-utils';

// The same `LlmServeFailure` is rendered into each source's own error envelope.
// Under the Responses protocol the gateway stands in for OpenAI's own item
// store, so these bodies must byte-match OpenAI's native responses: stateless
// clients compare the whole body verbatim.

const decodeUpstreamError = (result: ReturnType<typeof responsesTraits.renderFailure>) => {
  if (result.type !== 'upstream-error') throw new Error(`expected upstream-error, got ${result.type}`);
  return { status: result.status, body: JSON.parse(new TextDecoder().decode(result.body)) as unknown };
};

test('Responses renders item-not-found as the byte-exact OpenAI native body', () => {
  const { status, body } = decodeUpstreamError(responsesTraits.renderFailure({ kind: 'item-not-found', itemId: 'rs_x' }, 'generate'));
  assertEquals(status, 404);
  assertEquals(body, { error: { message: "Item with id 'rs_x' not found.", type: 'invalid_request_error', param: 'input', code: null } });
});

test('Responses tags routing-unavailable with the gateway-specific code', () => {
  const { status, body } = decodeUpstreamError(responsesTraits.renderFailure({ kind: 'routing-unavailable', message: 'no upstream' }, 'generate'));
  assertEquals(status, 400);
  assertEquals(body, { error: { message: 'no upstream', type: 'invalid_request_error', param: 'input', code: 'responses_item_routing_unavailable' } });
});
