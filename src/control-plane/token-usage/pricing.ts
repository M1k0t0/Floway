// Per-model pricing table and per-record cost computation.
//
// Keys match displayModelName(rawModel) output (Claude variants/dates/dotted
// versions are normalized to a single dashed base id; non-Claude models are
// passed through unchanged). Prices are USD per 1M tokens.
//
// Pricing is intentionally backend-owned: the dashboard renders cost as a
// pre-computed number on each usage record, so the frontend has no model-name
// parsing or pricing logic. Storage and export/import remain raw-model.

import { displayModelName } from "../../shared/model-name.ts";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const MODEL_PRICING: readonly PricingRule[] = [
  [/^claude-opus-4-[567]$/, {
    input: 5,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    output: 25,
  }],
  [/^claude-sonnet-4(-[56])?$/, {
    input: 3,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15,
  }],
  ["claude-haiku-4-5", {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5,
  }],
  ["gpt-5.5", { input: 5, cacheRead: 0.5, output: 30 }],
  ["gpt-5.4", { input: 2.5, cacheRead: 0.25, output: 15 }],
  ["gpt-5.4-mini", { input: 0.75, cacheRead: 0.075, output: 4.5 }],
  ["gpt-5.4-nano", { input: 0.2, cacheRead: 0.02, output: 1.25 }],
  [/^gpt-5[.][23](-codex)?$/, { input: 1.75, cacheRead: 0.175, output: 14 }],
  ["gpt-5.1-codex-mini", { input: 0.25, cacheRead: 0.025, output: 2 }],
  [/^gpt-5[.]1/, { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["gpt-5-mini", { input: 0.25, cacheRead: 0.025, output: 2 }],
  [/^gpt-4[.]1/, { input: 2, cacheRead: 0.5, output: 8 }],
  ["gpt-41-copilot", { input: 2, cacheRead: 0.5, output: 8 }],
  [/^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, {
    input: 2.5,
    cacheRead: 1.25,
    output: 10,
  }],
  ["gpt-4-o-preview", { input: 2.5, cacheRead: 1.25, output: 10 }],
  [/^gpt-4o-mini/, { input: 0.15, cacheRead: 0.075, output: 0.6 }],
  [/^gpt-4(-0613)?$/, { input: 30, output: 60 }],
  ["gpt-4-0125-preview", { input: 10, output: 30 }],
  ["gpt-3.5-turbo", { input: 0.5, output: 1.5 }],
  ["gpt-3.5-turbo-0613", { input: 1.5, output: 2 }],
  ["gemini-2.5-pro", { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["gemini-3-flash-preview", { input: 0.5, cacheRead: 0.05, output: 3 }],
  ["gemini-3.1-pro-preview", { input: 2, cacheRead: 0.2, output: 12 }],
  [/^grok-code-fast/, { input: 0.2, output: 1.5 }],
  ["goldeneye", { input: 1.25, cacheRead: 0.125, output: 10 }],
  ["raptor-mini", { input: 0.25, cacheRead: 0.025, output: 2 }],
  ["minimax-m2.5", { input: 0.3, output: 1.2 }],
  [/^text-embedding-3-small/, { input: 0.02, output: 0 }],
  ["text-embedding-ada-002", { input: 0.1, output: 0 }],
];

const matchPricing = (displayName: string): ModelPricing | null => {
  for (const [key, pricing] of MODEL_PRICING) {
    if (typeof key === "string" ? displayName === key : key.test(displayName)) {
      return pricing;
    }
  }
  return null;
};

export const getModelPricing = (rawModel: string): ModelPricing | null =>
  matchPricing(displayModelName(rawModel));

export const recordCostUsd = (
  rawModel: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number => {
  const pricing = getModelPricing(rawModel);
  if (!pricing) return 0;
  const prefillInput = inputTokens - cacheReadTokens - cacheCreationTokens;
  const inputCost = prefillInput * pricing.input;
  const cacheReadCost = cacheReadTokens * (pricing.cacheRead ?? pricing.input);
  const cacheWriteCost = cacheCreationTokens *
    (pricing.cacheWrite ?? pricing.input);
  const outputCost = outputTokens * pricing.output;
  return (inputCost + cacheReadCost + cacheWriteCost + outputCost) / 1e6;
};
