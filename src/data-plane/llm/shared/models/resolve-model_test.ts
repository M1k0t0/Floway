import { assertEquals } from "@std/assert";
import type { ModelInfo, ModelsResponse } from "../../../models/types.ts";
import { fallbackModelId, resolveModelInModels } from "./resolve-model.ts";

const model = (
  id: string,
  options: {
    reasoningEfforts?: string[];
    contextWindow?: number;
  } = {},
): ModelInfo => ({
  id,
  name: id,
  version: id,
  object: "model",
  supported_endpoints: ["/v1/messages"],
  capabilities: {
    family: id,
    type: "chat",
    limits: {
      max_context_window_tokens: options.contextWindow ?? 200_000,
      max_prompt_tokens: options.contextWindow === 1_000_000
        ? 936_000
        : 168_000,
      max_output_tokens: options.contextWindow === 1_000_000 ? 64_000 : 32_000,
    },
    supports: {
      reasoning_effort: options.reasoningEfforts,
    },
  },
} as unknown as ModelInfo);

const models = (...data: ModelInfo[]): ModelsResponse => ({
  object: "list",
  data,
});

Deno.test("resolveModelInModels strips Claude date aliases before variant selection", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-haiku-4.5"),
      model("claude-haiku-4.5-1m", { contextWindow: 1_000_000 }),
    ),
    "claude-haiku-4-5-20251001",
    { context1m: true },
  );

  assertEquals(resolved?.id, "claude-haiku-4.5-1m");
});

Deno.test("resolveModelInModels keeps explicit suffix models as exact upstream ids", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-opus-4.7"),
      model("claude-opus-4.7-xhigh", { reasoningEfforts: ["xhigh"] }),
      model("claude-opus-4.7-1m-internal", {
        contextWindow: 1_000_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      }),
    ),
    "claude-opus-4.7-xhigh",
    { context1m: true, reasoningEffort: "medium" },
  );

  assertEquals(resolved?.id, "claude-opus-4.7-xhigh");
});

Deno.test("resolveModelInModels strips date aliases before explicit suffix exact match", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-opus-4.7"),
      model("claude-opus-4.7-xhigh", { reasoningEfforts: ["xhigh"] }),
      model("claude-opus-4.7-1m-internal", {
        contextWindow: 1_000_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      }),
    ),
    "claude-opus-4-7-xhigh-20251001",
    { context1m: true, reasoningEffort: "medium" },
  );

  assertEquals(resolved?.id, "claude-opus-4.7-xhigh");
});

Deno.test("resolveModelInModels supports integer-version Claude date aliases", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-sonnet-4"),
      model("claude-sonnet-4-1m", { contextWindow: 1_000_000 }),
    ),
    "claude-sonnet-4-20250514",
    { context1m: true },
  );

  assertEquals(resolved?.id, "claude-sonnet-4-1m");
});

Deno.test("resolveModelInModels strips integer-version date aliases before explicit suffix exact match", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-sonnet-4"),
      model("claude-sonnet-4-1m", { contextWindow: 1_000_000 }),
    ),
    "claude-sonnet-4-1m-20250514",
    {},
  );

  assertEquals(resolved?.id, "claude-sonnet-4-1m");
});

Deno.test("resolveModelInModels prefers 1m variants when they satisfy requested reasoning", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-opus-4.7", { reasoningEfforts: ["medium"] }),
      model("claude-opus-4.7-high", { reasoningEfforts: ["high"] }),
      model("claude-opus-4.7-xhigh", { reasoningEfforts: ["xhigh"] }),
      model("claude-opus-4.7-1m-internal", {
        contextWindow: 1_000_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      }),
    ),
    "claude-opus-4-7",
    { reasoningEffort: "xhigh" },
  );

  assertEquals(resolved?.id, "claude-opus-4.7-1m-internal");
});

Deno.test("resolveModelInModels prioritizes explicit 1m intent even when effort cannot be met", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-opus-4.6", { reasoningEfforts: ["low", "medium", "high"] }),
      model("claude-opus-4.6-xhigh", { reasoningEfforts: ["xhigh"] }),
      model("claude-opus-4.6-1m", {
        contextWindow: 1_000_000,
        reasoningEfforts: ["low", "medium", "high"],
      }),
    ),
    "claude-opus-4-6",
    { context1m: true, reasoningEffort: "xhigh" },
  );

  assertEquals(resolved?.id, "claude-opus-4.6-1m");
});

Deno.test("resolveModelInModels keeps the base Claude id when there is no routing intent", () => {
  const resolved = resolveModelInModels(
    models(
      model("claude-opus-4.7"),
      model("claude-opus-4.7-1m-internal", { contextWindow: 1_000_000 }),
    ),
    "claude-opus-4-7",
    {},
  );

  assertEquals(resolved?.id, "claude-opus-4.7");
});

Deno.test("fallbackModelId strips Claude date aliases for direct upstream fallback", () => {
  assertEquals(
    fallbackModelId("claude-opus-4-7-20251001"),
    "claude-opus-4.7",
  );
  assertEquals(
    fallbackModelId("claude-opus-4-7-xhigh-20251001"),
    "claude-opus-4.7-xhigh",
  );
  assertEquals(
    fallbackModelId("claude-sonnet-4-20250514"),
    "claude-sonnet-4",
  );
});
