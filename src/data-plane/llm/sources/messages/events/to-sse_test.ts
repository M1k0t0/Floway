import { assertEquals, assertRejects } from "@std/assert";
import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import { eventFrame } from "../../../shared/stream/types.ts";
import { messagesProtocolEventsToSSEFrames } from "./to-sse.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

Deno.test("messagesProtocolEventsToSSEFrames stops at message_stop", async () => {
  const frames = await collect(
    messagesProtocolEventsToSSEFrames((async function* () {
      yield eventFrame(
        { type: "message_stop" } satisfies MessagesStreamEventData,
      );
      yield eventFrame({ type: "ping" } satisfies MessagesStreamEventData);
    })()),
  );

  assertEquals(frames.map((frame) => frame.event), ["message_stop"]);
});

Deno.test("messagesProtocolEventsToSSEFrames rejects streams without message_stop", async () => {
  await assertRejects(
    async () => {
      await collect(messagesProtocolEventsToSSEFrames((async function* () {
        yield eventFrame(
          {
            type: "message_start",
            message: {
              id: "msg_truncated",
              type: "message",
              role: "assistant",
              content: [],
              model: "claude-test",
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          } satisfies MessagesStreamEventData,
        );
      })()));
    },
    Error,
    "Messages stream ended without a message_stop event.",
  );
});
