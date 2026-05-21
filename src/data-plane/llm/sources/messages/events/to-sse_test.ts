import { assertEquals, assertRejects } from "@std/assert";
import type { MessagesStreamEventData } from "../../../../shared/protocol/messages.ts";
import { eventFrame } from "../../../shared/stream/types.ts";
import { messagesProtocolEventsToSSEFrames } from "./to-sse.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const ignoreUsage = { onUsage: () => {} };

Deno.test("messagesProtocolEventsToSSEFrames stops at message_stop", async () => {
  const frames = await collect(
    messagesProtocolEventsToSSEFrames(
      (async function* () {
        yield eventFrame(
          { type: "message_stop" } satisfies MessagesStreamEventData,
        );
        yield eventFrame({ type: "ping" } satisfies MessagesStreamEventData);
      })(),
      ignoreUsage,
    ),
  );

  assertEquals(frames.map((frame) => frame.event), ["message_stop"]);
});

Deno.test("messagesProtocolEventsToSSEFrames rejects streams without message_stop", async () => {
  await assertRejects(
    async () => {
      await collect(messagesProtocolEventsToSSEFrames(
        (async function* () {
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
        })(),
        ignoreUsage,
      ));
    },
    Error,
    "Messages stream ended without a message_stop event.",
  );
});

Deno.test("messagesProtocolEventsToSSEFrames maps search_result_location url to SSE source", async () => {
  const frames = await collect(
    messagesProtocolEventsToSSEFrames(
      (async function* () {
        yield eventFrame(
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "citations_delta",
              citation: {
                type: "search_result_location",
                url: "https://example.com/protocol",
                title: "Protocol Citation",
                search_result_index: 0,
                start_block_index: 0,
                end_block_index: 0,
              },
            },
          } satisfies MessagesStreamEventData,
        );
        yield eventFrame(
          { type: "message_stop" } satisfies MessagesStreamEventData,
        );
      })(),
      ignoreUsage,
    ),
  );

  const payload = JSON.parse(frames[0].data) as {
    delta: { citation: Record<string, unknown> };
  };

  assertEquals(payload.delta.citation, {
    type: "search_result_location",
    source: "https://example.com/protocol",
    title: "Protocol Citation",
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });
});
