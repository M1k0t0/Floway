import { assertEquals, assertRejects } from "@std/assert";
import type { GeminiStreamEvent } from "../../../../lib/gemini-types.ts";
import type {
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../../lib/messages-types.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../shared/stream/types.ts";
import { translateToSourceEvents } from "./translate-to-source-events.ts";

const messageStart = (
  usage: MessagesResponse["usage"] = { input_tokens: 0, output_tokens: 0 },
): MessagesStreamEventData => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-test",
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
});

const collect = async (
  input: ProtocolFrame<MessagesStreamEventData>[],
): Promise<ProtocolFrame<GeminiStreamEvent>[]> => {
  const output: ProtocolFrame<GeminiStreamEvent>[] = [];

  async function* frames() {
    yield* input;
  }

  for await (const frame of translateToSourceEvents(frames())) {
    output.push(frame);
  }

  return output;
};

const geminiFrame = (
  event: GeminiStreamEvent,
): ProtocolFrame<GeminiStreamEvent> => eventFrame(event);

const drain = async (
  input: ProtocolFrame<MessagesStreamEventData>[],
): Promise<void> => {
  await collect(input);
};

Deno.test("translateToSourceEvents maps text chunks, finish reason, and usage without DONE", async () => {
  const frames = await collect([
    eventFrame(messageStart({ input_tokens: 10, output_tokens: 0 })),
    eventFrame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello " },
    }),
    eventFrame({ type: "content_block_stop", index: 0 }),
    eventFrame({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "world" },
    }),
    eventFrame({ type: "content_block_stop", index: 1 }),
    eventFrame({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    }),
    eventFrame({ type: "message_stop" }),
    doneFrame(),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: "Hello " }] },
      }],
    }),
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: "world" }] },
      }],
    }),
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    }),
  ]);
});

Deno.test("translateToSourceEvents maps thinking text and attaches signature to the next text action", async () => {
  const frames = await collect([
    eventFrame(messageStart()),
    eventFrame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "trace" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_1" },
    }),
    eventFrame({ type: "content_block_stop", index: 0 }),
    eventFrame({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "answer" },
    }),
    eventFrame({ type: "content_block_stop", index: 1 }),
    eventFrame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    eventFrame({ type: "message_stop" }),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: "trace", thought: true }] },
      }],
    }),
    geminiFrame({
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{ text: "answer", thoughtSignature: "sig_1" }],
        },
      }],
    }),
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "STOP",
      }],
    }),
  ]);
});

Deno.test("translateToSourceEvents accumulates tool call JSON and attaches pending signature", async () => {
  const frames = await collect([
    eventFrame(messageStart()),
    eventFrame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_tool" },
    }),
    eventFrame({ type: "content_block_stop", index: 0 }),
    eventFrame({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tu_1",
        name: "lookup",
        input: {},
      },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"query"' },
    }),
    eventFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: ':"deno"}' },
    }),
    eventFrame({ type: "content_block_stop", index: 1 }),
    eventFrame({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    eventFrame({ type: "message_stop" }),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{
            functionCall: {
              id: "tu_1",
              name: "lookup",
              args: { query: "deno" },
            },
            thoughtSignature: "sig_tool",
          }],
        },
      }],
    }),
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "STOP",
      }],
    }),
  ]);
});

Deno.test("translateToSourceEvents maps max token and refusal finish reasons", async () => {
  const maxTokenFrames = await collect([
    eventFrame(messageStart({ input_tokens: 8, output_tokens: 0 })),
    eventFrame({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 3 },
    }),
    eventFrame({ type: "message_stop" }),
  ]);

  assertEquals(maxTokenFrames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "MAX_TOKENS",
      }],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 3,
        totalTokenCount: 11,
      },
    }),
  ]);

  const refusalFrames = await collect([
    eventFrame(messageStart()),
    eventFrame({ type: "message_delta", delta: { stop_reason: "refusal" } }),
    eventFrame({ type: "message_stop" }),
  ]);

  assertEquals(refusalFrames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "SAFETY",
      }],
    }),
  ]);
});

Deno.test("translateToSourceEvents throws on Messages error events", async () => {
  await assertRejects(
    async () =>
      await drain([
        eventFrame({
          type: "error",
          error: { type: "invalid_request_error", message: "bad request" },
        }),
      ]),
    Error,
    "Upstream Messages stream error: invalid_request_error: bad request",
  );
});

Deno.test("translateToSourceEvents folds Anthropic cache fields into Gemini promptTokenCount and cachedContentTokenCount", async () => {
  const frames = await collect([
    eventFrame(messageStart({
      input_tokens: 10,
      output_tokens: 0,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })),
    eventFrame({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 7 },
    }),
    eventFrame({ type: "message_stop" }),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [] },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 45,
        candidatesTokenCount: 7,
        totalTokenCount: 52,
        cachedContentTokenCount: 30,
      },
    }),
  ]);
});
