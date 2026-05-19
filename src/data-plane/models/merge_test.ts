import { assertEquals } from "@std/assert";
import { mergeClaudeVariants } from "./merge.ts";
import type { ModelInfo, ModelsResponse } from "./types.ts";

const assertSameSet = <T>(actual: readonly T[] | undefined, expected: T[]) => {
  // Union order in merge.ts follows the input variant order, which is an
  // implementation detail of upstream /models. Assert membership only so the
  // tests do not flake when upstream reorders.
  assertEquals(new Set(actual), new Set(expected));
  assertEquals(actual?.length, expected.length);
};

const claudeVariant = (
  id: string,
  overrides: {
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
    reasoningEfforts?: string[];
    multiplier?: number;
    restrictedTo?: string[];
  } = {},
): ModelInfo => ({
  id,
  name: id,
  version: id,
  object: "model",
  capabilities: {
    family: id,
    type: "chat",
    limits: {
      ...(overrides.maxContextWindowTokens !== undefined
        ? { max_context_window_tokens: overrides.maxContextWindowTokens }
        : {}),
      ...(overrides.maxPromptTokens !== undefined
        ? { max_prompt_tokens: overrides.maxPromptTokens }
        : {}),
      ...(overrides.maxOutputTokens !== undefined
        ? { max_output_tokens: overrides.maxOutputTokens }
        : {}),
    },
    supports: {
      ...(overrides.reasoningEfforts !== undefined
        ? { reasoning_effort: overrides.reasoningEfforts }
        : {}),
    },
  },
  supported_endpoints: ["/v1/messages", "/chat/completions"],
  ...(overrides.multiplier !== undefined || overrides.restrictedTo !== undefined
    ? {
      billing: {
        is_premium: true,
        ...(overrides.multiplier !== undefined
          ? { multiplier: overrides.multiplier }
          : {}),
        ...(overrides.restrictedTo !== undefined
          ? { restricted_to: overrides.restrictedTo }
          : {}),
      },
    }
    : {}),
});

Deno.test("mergeClaudeVariants merges 4.7 base + high + xhigh + 1m-internal", () => {
  const input: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7-1m-internal", {
        maxContextWindowTokens: 1_000_000,
        maxPromptTokens: 936_000,
        maxOutputTokens: 64_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        multiplier: 10,
        restrictedTo: ["enterprise"],
      }),
      claudeVariant("claude-opus-4.7-high", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["high"],
        multiplier: 30,
        restrictedTo: ["pro_plus", "business", "enterprise", "max"],
      }),
      claudeVariant("claude-opus-4.7-xhigh", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["xhigh"],
        multiplier: 45,
        restrictedTo: ["pro_plus", "business", "enterprise", "max"],
      }),
      claudeVariant("claude-opus-4.7", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["medium"],
        multiplier: 15,
        restrictedTo: ["pro_plus", "business", "enterprise", "max"],
      }),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.length, 1);
  const m = merged.data[0];

  assertEquals(m.id, "claude-opus-4-7");
  assertEquals(m.version, "claude-opus-4-7");
  assertEquals(m.capabilities.family, "claude-opus-4-7");
  assertEquals(m.capabilities.limits.max_context_window_tokens, 1_000_000);
  assertEquals(m.capabilities.limits.max_prompt_tokens, 936_000);
  assertEquals(m.capabilities.limits.max_output_tokens, 64_000);
  assertSameSet(m.capabilities.supports.reasoning_effort, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // billing.multiplier intentionally takes the base value (15), not max.
  assertEquals(m.billing?.multiplier, 15);
  // billing.restricted_to takes the union across siblings.
  assertSameSet(m.billing?.restricted_to, [
    "enterprise",
    "pro_plus",
    "business",
    "max",
  ]);
});

Deno.test("mergeClaudeVariants merges 4.6 base + 1m", () => {
  const input: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.6-1m", {
        maxContextWindowTokens: 1_000_000,
        maxPromptTokens: 936_000,
        maxOutputTokens: 64_000,
        multiplier: 6,
        restrictedTo: ["pro", "pro_plus", "business", "enterprise", "max"],
      }),
      claudeVariant("claude-opus-4.6", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        multiplier: 3,
        restrictedTo: [
          "pro",
          "pro_plus",
          "individual_trial",
          "business",
          "enterprise",
          "max",
        ],
      }),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.length, 1);
  const m = merged.data[0];

  assertEquals(m.id, "claude-opus-4-6");
  assertEquals(m.capabilities.limits.max_context_window_tokens, 1_000_000);
  assertEquals(m.capabilities.limits.max_prompt_tokens, 936_000);
  assertEquals(m.capabilities.limits.max_output_tokens, 64_000);
  assertEquals(m.billing?.multiplier, 3);
  assertSameSet(m.billing?.restricted_to, [
    "pro",
    "pro_plus",
    "business",
    "enterprise",
    "max",
    "individual_trial",
  ]);
});

Deno.test("mergeClaudeVariants leaves non-Claude models untouched", () => {
  const input: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("gpt-5.4", { maxContextWindowTokens: 272_000 }),
      claudeVariant("gemini-2.5-pro", { maxContextWindowTokens: 1_000_000 }),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.map((m) => m.id), ["gpt-5.4", "gemini-2.5-pro"]);
  assertEquals(
    merged.data[0].capabilities.limits.max_context_window_tokens,
    272_000,
  );
});

Deno.test("mergeClaudeVariants preserves order across mixed claude/non-claude models", () => {
  const input: ModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7-1m-internal"),
      claudeVariant("gpt-5.5"),
      claudeVariant("claude-opus-4.7"),
      claudeVariant("claude-sonnet-4.6"),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.map((m) => m.id), [
    "claude-opus-4-7",
    "gpt-5.5",
    "claude-sonnet-4-6",
  ]);
});
