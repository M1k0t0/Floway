import { assertEquals, assertRejects } from "@std/assert";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../shared/protocol/responses.ts";
import { chatProtocolEventsToSSEFrames } from "../../sources/chat-completions/events/to-sse.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import { responsesResultToEvents } from "../../targets/responses/events/from-result.ts";
import { translateToSourceEvents } from "./events.ts";

type UpstreamResponseStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

const makeResponse = (status: ResponsesResult["status"]): ResponsesResult => ({
  id: "resp_123",
  object: "response",
  model: "gpt-test",
  status,
  output_text: "hello",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "hello" }],
  }],
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toProtocolFrame = (
  event: ResponseStreamEvent,
): ProtocolFrame<UpstreamResponseStreamEvent> =>
  eventFrame({ ...event, sequence_number: 0 });

const countDoneSentinels = async (
  frames: ProtocolFrame<UpstreamResponseStreamEvent>[],
): Promise<number> => {
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (
    const frame of chatProtocolEventsToSSEFrames(
      translateToSourceEvents(stream()),
    )
  ) {
    if (frame.data === "[DONE]") doneCount++;
  }

  return doneCount;
};

const countAssistantStartChunksAndDone = async (
  frames: ProtocolFrame<UpstreamResponseStreamEvent>[],
): Promise<{ assistantStartCount: number; doneCount: number }> => {
  let assistantStartCount = 0;
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (
    const frame of chatProtocolEventsToSSEFrames(
      translateToSourceEvents(stream()),
    )
  ) {
    if (frame.data === "[DONE]") {
      doneCount++;
      continue;
    }

    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    if (parsed.choices?.[0]?.delta?.role === "assistant") assistantStartCount++;
  }

  return { assistantStartCount, doneCount };
};

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
  const collected = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

Deno.test("translateToSourceEvents emits exactly one [DONE] for structured responses stream", async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: "response.created",
      response: makeResponse("in_progress"),
    }),
    toProtocolFrame({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hello",
    }),
    toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    }),
  ]);

  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents emits exactly one [DONE] for fallback completion stream", async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: "response.output_text.done",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: "hello",
    }),
    toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    }),
  ]);

  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents avoids assistant-start duplication for created+completed fallback", async () => {
  const { assistantStartCount, doneCount } =
    await countAssistantStartChunksAndDone([
      toProtocolFrame({
        type: "response.created",
        response: makeResponse("in_progress"),
      }),
      toProtocolFrame({
        type: "response.completed",
        response: makeResponse("completed"),
      }),
    ]);

  assertEquals(assistantStartCount, 1);
  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents preserves refusal text from JSON fallback", async () => {
  async function* stream() {
    yield* responsesResultToEvents({
      id: "resp_refusal",
      object: "response",
      model: "gpt-test",
      status: "completed",
      output_text: "",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "No." }],
      }],
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  }

  const text: string[] = [];

  for await (const frame of translateToSourceEvents(stream())) {
    if (frame.type !== "event") continue;
    text.push(frame.event.choices[0]?.delta.content ?? "");
  }

  assertEquals(text.join(""), "No.");
});

Deno.test("translateToSourceEvents stops after Responses terminal completion", async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    }),
    toProtocolFrame({
      type: "error",
      message: "ignored after terminal",
      code: "ignored_error",
    }),
  ]);

  assertEquals(doneCount, 1);
});

Deno.test("translateToSourceEvents translates Responses error events to Chat errors", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "error",
      message: "upstream overloaded",
      code: "overloaded_error",
    });
  }

  const frames = await collect(translateToSourceEvents(stream()));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, "event");
  if (frames[0].type !== "event") throw new Error("expected event frame");
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: "upstream overloaded",
    type: "overloaded_error",
    code: "overloaded_error",
  });
});

Deno.test("translateToSourceEvents translates Responses failed terminal events to Chat errors", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.failed",
      response: {
        ...makeResponse("failed"),
        output_text: "",
        output: [],
        error: {
          type: "server_error",
          code: "server_error",
          message: "upstream failed",
        },
      },
    });
  }

  const frames = await collect(translateToSourceEvents(stream()));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, "event");
  if (frames[0].type !== "event") throw new Error("expected event frame");
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: "upstream failed",
    type: "server_error",
    code: "server_error",
  });
});

Deno.test("translateToSourceEvents rejects truncated Responses streams without terminal events", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    });
  }

  await assertRejects(
    async () => await drain(translateToSourceEvents(stream())),
    Error,
    "Upstream Responses stream ended without a terminal event.",
  );
});
