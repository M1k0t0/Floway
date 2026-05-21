import { test } from 'vitest';

import { doneFrame, eventFrame, sseCommentFrame, sseFrame } from './types.ts';
import { assertEquals } from '../../../../test-assert.ts';

test('eventFrame carries structured protocol events', () => {
  assertEquals(eventFrame({ type: 'message_stop' }), {
    type: 'event',
    event: { type: 'message_stop' },
  });
});

test('doneFrame marks protocol sentinels without raw SSE text', () => {
  assertEquals(doneFrame(), { type: 'done' });
});

test('sseFrame preserves upstream payload shape', () => {
  assertEquals(sseFrame('{}', 'message_stop'), {
    type: 'sse',
    event: 'message_stop',
    data: '{}',
  });
});

test('sseCommentFrame carries comment keepalive payloads', () => {
  assertEquals(sseCommentFrame('keepalive'), {
    type: 'sse-comment',
    comment: 'keepalive',
  });
});
