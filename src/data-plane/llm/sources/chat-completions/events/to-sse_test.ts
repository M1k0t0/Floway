import { assertEquals, assertRejects } from "@std/assert";
import type { ChatCompletionChunk } from "../../../shared/protocol/chat-completions.ts";
import { doneFrame, eventFrame } from "../../../shared/stream/types.ts";
import { chatProtocolEventsToSSEFrames } from "./to-sse.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

Deno.test("chatProtocolEventsToSSEFrames passes through non-chunk JSON payloads", async () => {
  const payload = {
    error: { message: "boom" },
  } as unknown as ChatCompletionChunk;

  const frames = await collect(
    chatProtocolEventsToSSEFrames((async function* () {
      yield eventFrame(payload);
    })()),
  );

  assertEquals(frames, [{
    type: "sse",
    event: undefined,
    data: JSON.stringify(payload),
  }]);
});

Deno.test("chatProtocolEventsToSSEFrames stops at DONE", async () => {
  const chunk = {
    id: "chatcmpl_done",
    object: "chat.completion.chunk",
    created: 123,
    model: "gpt-test",
    choices: [{
      index: 0,
      delta: { role: "assistant", content: "hello" },
      finish_reason: null,
    }],
  } satisfies ChatCompletionChunk;

  const frames = await collect(
    chatProtocolEventsToSSEFrames((async function* () {
      yield eventFrame(chunk);
      yield doneFrame();
      yield eventFrame({
        ...chunk,
        id: "chatcmpl_after_done",
        choices: [{
          index: 0,
          delta: { content: "ignored" },
          finish_reason: null,
        }],
      });
    })()),
  );

  assertEquals(frames.map((frame) => frame.data), [
    JSON.stringify(chunk),
    "[DONE]",
  ]);
});

Deno.test("chatProtocolEventsToSSEFrames rejects streams without DONE", async () => {
  await assertRejects(
    async () => {
      await collect(chatProtocolEventsToSSEFrames((async function* () {
        yield eventFrame(
          {
            id: "chatcmpl_truncated",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-test",
            choices: [{
              index: 0,
              delta: { role: "assistant", content: "partial" },
              finish_reason: null,
            }],
          } satisfies ChatCompletionChunk,
        );
      })()));
    },
    Error,
    "Chat Completions stream ended without a DONE sentinel.",
  );
});
