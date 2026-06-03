import { test } from 'vitest';

import { messagesTraits } from './traits.ts';
import { assertEquals } from '@floway-dev/test-utils';

// The same `LlmServeFailure` the Responses source renders as an OpenAI body must
// answer in the Anthropic envelope here, never borrowing OpenAI's shape — the
// failure carries no pre-shaped body, so each protocol owns its own rendering.

const decodeUpstreamError = (result: ReturnType<typeof messagesTraits.renderFailure>) => {
  if (result.type !== 'upstream-error') throw new Error(`expected upstream-error, got ${result.type}`);
  return { status: result.status, body: JSON.parse(new TextDecoder().decode(result.body)) as unknown };
};

test('Messages renders item-not-found in the Anthropic envelope', () => {
  const { status, body } = decodeUpstreamError(messagesTraits.renderFailure({ kind: 'item-not-found', itemId: 'rs_x' }, 'generate'));
  assertEquals(status, 400);
  assertEquals(body, { type: 'error', error: { type: 'invalid_request_error', message: "Item with id 'rs_x' not found." } });
});
