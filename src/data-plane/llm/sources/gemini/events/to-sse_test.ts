import { assertEquals } from "@std/assert";
import type { GeminiStreamEvent } from "../../../shared/protocol/gemini.ts";
import { doneFrame, eventFrame } from "../../../shared/stream/types.ts";
import { geminiProtocolEventsToSSEFrames } from "./to-sse.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

Deno.test("geminiProtocolEventsToSSEFrames emits data-only JSON chunks", async () => {
  const chunk = {
    candidates: [{
      index: 0,
      content: { role: "model", parts: [{ text: "Hello" }] },
    }],
    modelVersion: "gemini-test",
  } satisfies GeminiStreamEvent;

  const frames = await collect(
    geminiProtocolEventsToSSEFrames((async function* () {
      yield eventFrame(chunk);
      yield doneFrame();
    })()),
  );

  assertEquals(frames, [{
    type: "sse",
    event: undefined,
    data: JSON.stringify(chunk),
  }]);
});

Deno.test("geminiProtocolEventsToSSEFrames stops at finishReason without DONE", async () => {
  const first = {
    candidates: [{
      index: 0,
      content: { role: "model", parts: [{ text: "Hello" }] },
    }],
  } satisfies GeminiStreamEvent;
  const terminal = {
    candidates: [{
      index: 0,
      content: { role: "model", parts: [{ text: " world" }] },
      finishReason: "STOP",
    }],
  } satisfies GeminiStreamEvent;
  const afterTerminal = {
    candidates: [{
      index: 0,
      content: { role: "model", parts: [{ text: " ignored" }] },
    }],
  } satisfies GeminiStreamEvent;

  const frames = await collect(
    geminiProtocolEventsToSSEFrames((async function* () {
      yield eventFrame(first);
      yield eventFrame(terminal);
      yield eventFrame(afterTerminal);
    })()),
  );

  assertEquals(frames.map((frame) => frame.data), [
    JSON.stringify(first),
    JSON.stringify(terminal),
  ]);
  assertEquals(frames.some((frame) => frame.data === "[DONE]"), false);
});
