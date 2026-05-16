import { assertEquals, assertFalse } from "@std/assert";
import {
  translateResponsesToMessages,
  translateResponsesToMessagesResponse,
} from "./responses-to-messages.ts";

const stubRemoteImageLoader = (
  result: { mediaType: string | null; data: Uint8Array } | null,
) =>
() => Promise.resolve(result);

Deno.test("translateResponsesToMessages maps reasoning.effort none to thinking.disabled", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: "none", summary: "detailed" },
  });

  assertEquals(result.thinking, { type: "disabled" });
  assertFalse("output_config" in result);
});

Deno.test("translateResponsesToMessages maps reasoning.effort directly to output_config.effort", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: "minimal", summary: "detailed" },
  });

  assertEquals(result.output_config, { effort: "minimal" });
  assertFalse("thinking" in result);
});

Deno.test("translateResponsesToMessages leaves max_tokens undefined when neither source nor fallbackMaxOutputTokens supplies one", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.max_tokens, undefined);
});

Deno.test("translateResponsesToMessages uses fallbackMaxOutputTokens when the source omitted max_output_tokens", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  }, { fallbackMaxOutputTokens: 4096 });

  assertEquals(result.max_tokens, 4096);
});

Deno.test("translateResponsesToMessages preserves reasoning.encrypted_content without encoding the reasoning id", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{
      type: "reasoning",
      id: "rs_42",
      summary: [{ type: "summary_text", text: "trace" }],
      encrypted_content: "enc_abc",
    }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  const assistant = result.messages[0];
  if (assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
    throw new Error("expected assistant message with content blocks");
  }

  assertEquals(assistant.content[0], {
    type: "thinking",
    thinking: "trace",
    signature: "enc_abc",
  });
});

Deno.test("translateResponsesToMessagesResponse omits signature for text-only reasoning", () => {
  const result = translateResponsesToMessagesResponse({
    id: "resp_123",
    object: "response",
    model: "gpt-test",
    output: [{
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "trace" }],
    }],
    output_text: "",
    status: "completed",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  const block = result.content[0];
  assertEquals(block, { type: "thinking", thinking: "trace" });
  assertFalse("signature" in block);
});

Deno.test("translateResponsesToMessages omits generic metadata instead of coercing it to metadata.user_id", async () => {
  const result = await translateResponsesToMessages({
    model: "claude-test",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: "auto",
    metadata: { trace_id: "trace_123" },
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertFalse("metadata" in result);
});

Deno.test("translateResponsesToMessages resolves remote input images through the shared loader", async () => {
  const result = await translateResponsesToMessages(
    {
      model: "claude-test",
      input: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_image",
          image_url: "https://example.com/image.png",
          detail: "auto",
        }],
      }],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: "auto",
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    },
    {
      loadRemoteImage: stubRemoteImageLoader({
        mediaType: "image/png",
        data: new Uint8Array([1, 2, 3]),
      }),
    },
  );

  const message = result.messages[0];
  if (message.role !== "user" || !Array.isArray(message.content)) {
    throw new Error("expected user message with content blocks");
  }

  assertEquals(message.content, [{
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "AQID",
    },
  }]);
});

Deno.test("translateResponsesToMessagesResponse maps opaque-only reasoning to redacted_thinking", () => {
  const result = translateResponsesToMessagesResponse({
    id: "resp_123",
    object: "response",
    model: "gpt-test",
    output: [{
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "opaque_sig",
    }],
    output_text: "",
    status: "completed",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  assertEquals(result.content, [{
    type: "redacted_thinking",
    data: "opaque_sig",
  }]);
});
