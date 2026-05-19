import { assertEquals } from "@std/assert";
import type { MessagesResponse } from "../../../shared/protocol/messages.ts";
import { jsonFrame, sseFrame } from "../../../shared/stream/types.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import {
  resolveMessagesDownstreamThinkingDisplay,
  withThinkingDisplayPromoted,
} from "./promote-thinking-display.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makeCtx = (
  thinking: EmitToMessagesInput["payload"]["thinking"],
  overrides: {
    model?: string;
    sourceApi?: EmitToMessagesInput["sourceApi"];
  } = {},
): EmitToMessagesInput => ({
  sourceApi: overrides.sourceApi ?? "messages",
  payload: {
    model: overrides.model ?? "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
    ...(thinking ? { thinking } : {}),
  },
  githubToken: "ghu_test",
  accountType: "individual",
  clientStream: true,
  runtimeLocation: "unknown",
});

const makeMessagesResponse = (
  content: MessagesResponse["content"],
): MessagesResponse => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  content,
  model: "claude-opus-4.7-1m-internal",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

Deno.test("resolveMessagesDownstreamThinkingDisplay exposes 4.7+ omitted by default and older Claude as summarized", () => {
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: "adaptive" })),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "claude-opus-4-7-20260219",
      },
    }),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "claude-opus-4.6",
      },
    }),
    "summarized",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "gpt-5.2",
      },
    }),
    "summarized",
  );
});

Deno.test("resolveMessagesDownstreamThinkingDisplay preserves explicit display", () => {
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "summarized" }),
    ),
    "summarized",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "omitted" }),
    ),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "full" }),
    ),
    "full",
  );
});

Deno.test("resolveMessagesDownstreamThinkingDisplay ignores unknown explicit display values", () => {
  const ctx = makeCtx({ type: "adaptive" });
  (ctx.payload.thinking as { display?: unknown }).display = "omit";

  assertEquals(resolveMessagesDownstreamThinkingDisplay(ctx), undefined);
});

Deno.test("withThinkingDisplayPromoted sends summarized upstream when thinking display is omitted", async () => {
  const ctx = makeCtx({ type: "adaptive" });

  await withThinkingDisplayPromoted(ctx, () =>
    Promise.resolve({
      type: "internal-error",
      status: 418,
      error: {
        type: "internal_error",
        name: "Error",
        message: "stop",
        stack: "",
        source_api: "messages",
        target_api: "messages",
      },
    }));

  assertEquals(ctx.payload.thinking?.display, "summarized");
});

Deno.test("withThinkingDisplayPromoted overrides omitted but preserves full", async () => {
  const omittedCtx = makeCtx({ type: "adaptive", display: "omitted" });
  const fullCtx = makeCtx({ type: "adaptive", display: "full" });

  const run = () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {})(),
    });

  await withThinkingDisplayPromoted(omittedCtx, run);
  await withThinkingDisplayPromoted(fullCtx, run);

  assertEquals(omittedCtx.payload.thinking?.display, "summarized");
  assertEquals(fullCtx.payload.thinking?.display, "full");
});

Deno.test("withThinkingDisplayPromoted leaves disabled or absent thinking untouched", async () => {
  const disabledCtx = makeCtx({ type: "disabled" });
  const absentCtx = makeCtx(undefined);

  await withThinkingDisplayPromoted(disabledCtx, () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {})(),
    }));
  await withThinkingDisplayPromoted(absentCtx, () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {})(),
    }));

  assertEquals(disabledCtx.payload.thinking, { type: "disabled" });
  assertEquals(absentCtx.payload.thinking, undefined);
});

Deno.test("withThinkingDisplayPromoted leaves unknown display values for upstream validation", async () => {
  const ctx = makeCtx({ type: "adaptive" });
  (ctx.payload.thinking as { display?: unknown }).display = "omit";

  await withThinkingDisplayPromoted(ctx, () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {})(),
    }));

  assertEquals((ctx.payload.thinking as { display?: unknown }).display, "omit");
});

Deno.test("withThinkingDisplayPromoted simulates omitted display on target SSE results", async () => {
  const ctx = makeCtx({ type: "adaptive" }, { sourceApi: "responses" });

  const result = await withThinkingDisplayPromoted(ctx, () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {
        yield sseFrame(JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "summary prefix" },
        }));
        yield sseFrame(JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "summary body" },
        }));
        yield sseFrame(JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_unchanged" },
        }));
      })(),
    }));

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events");

  assertEquals(await collect(result.events), [
    sseFrame(JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    })),
    sseFrame(JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_unchanged" },
    })),
  ]);
});

Deno.test("withThinkingDisplayPromoted simulates omitted display on target JSON results", async () => {
  const ctx = makeCtx({ type: "adaptive" });

  const result = await withThinkingDisplayPromoted(ctx, () =>
    Promise.resolve({
      type: "events" as const,
      events: (async function* () {
        yield jsonFrame(makeMessagesResponse([
          {
            type: "thinking",
            thinking: "private summary",
            signature: "sig_json",
          },
          { type: "text", text: "visible" },
        ]));
      })(),
    }));

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events");

  assertEquals(await collect(result.events), [
    jsonFrame(makeMessagesResponse([
      { type: "thinking", thinking: "", signature: "sig_json" },
      { type: "text", text: "visible" },
    ])),
  ]);
});
