import type { ChatCompletionsPayload } from "../protocol/chat-completions.ts";
import {
  getMessagesRequestedReasoningEffort,
  type MessagesPayload,
} from "../protocol/messages.ts";
import type { ModelInfo, ModelsResponse } from "../../../models/types.ts";
import { loadModels } from "../../../models/cache.ts";
import { normalizeModelName } from "../../../../shared/model-name.ts";
import type { ResponsesPayload } from "../protocol/responses.ts";
import { getRepo } from "../../../../repo/index.ts";

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const CLAUDE_DATE_SUFFIX = /-\d{8}$/;
const STANDARD_CLAUDE_BASE_ID = /^claude-[a-z0-9-]+-\d+(?:\.\d+)?$/;
const KNOWN_CLAUDE_VARIANT_SUFFIXES = new Set([
  "high",
  "xhigh",
  "1m",
  "1m-internal",
]);

export interface ModelResolutionIntent {
  context1m?: boolean;
  reasoningEffort?: string;
}

const normalizeReasoningEffort = (effort: string | null | undefined) =>
  effort && effort !== "none" ? effort : undefined;

const hasContext1mBeta = (rawBeta: string | undefined): boolean =>
  rawBeta?.split(",").map((part) => part.trim()).includes(CONTEXT_1M_BETA) ===
    true;

export const messagesModelResolutionIntent = (
  payload: MessagesPayload,
  rawBeta: string | undefined,
): ModelResolutionIntent => ({
  context1m: hasContext1mBeta(rawBeta),
  reasoningEffort: normalizeReasoningEffort(
    getMessagesRequestedReasoningEffort(payload),
  ),
});

export const responsesModelResolutionIntent = (
  payload: ResponsesPayload,
): ModelResolutionIntent => ({
  reasoningEffort: normalizeReasoningEffort(payload.reasoning?.effort),
});

export const chatModelResolutionIntent = (
  payload: ChatCompletionsPayload,
): ModelResolutionIntent => ({
  reasoningEffort: normalizeReasoningEffort(payload.reasoning_effort),
});

const stripClaudeDateSuffix = (id: string): string =>
  id.startsWith("claude-") ? id.replace(CLAUDE_DATE_SUFFIX, "") : id;

const normalizedClaudeLookupId = (id: string): string =>
  normalizeModelName(stripClaudeDateSuffix(id));

export const fallbackModelId = (id: string): string =>
  normalizedClaudeLookupId(id);

const standardClaudeBaseId = (id: string): string | undefined => {
  if (!id.startsWith("claude-")) return undefined;
  return STANDARD_CLAUDE_BASE_ID.test(id) ? id : undefined;
};

const claudeVariantSuffix = (baseId: string, id: string): string | undefined =>
  id === baseId
    ? ""
    : id.startsWith(`${baseId}-`)
    ? id.slice(baseId.length + 1)
    : undefined;

const isClaudeVariantForBase = (baseId: string, model: ModelInfo): boolean => {
  const suffix = claudeVariantSuffix(baseId, model.id);
  return suffix === "" ||
    (suffix !== undefined && KNOWN_CLAUDE_VARIANT_SUFFIXES.has(suffix));
};

export const supportsOneMillionContext = (model: ModelInfo): boolean => {
  const limits = model.capabilities?.limits;
  const explicit = limits?.max_context_window_tokens;
  if (typeof explicit === "number") return explicit >= 1_000_000;

  const prompt = limits?.max_prompt_tokens ?? 0;
  const output = limits?.max_output_tokens ?? 0;
  return prompt + output >= 1_000_000 || /-1m(?:-|$)/.test(model.id);
};

const supportsReasoningEffort = (
  model: ModelInfo,
  effort: string | undefined,
): boolean => {
  if (!effort) return true;
  return model.capabilities?.supports?.reasoning_effort?.includes(effort) ===
    true;
};

const byModelPreference = (a: ModelInfo, b: ModelInfo): number => {
  const aBase = a.id.split("-").length;
  const bBase = b.id.split("-").length;
  return aBase - bBase || a.id.localeCompare(b.id);
};

const firstPreferred = (models: ModelInfo[]): ModelInfo | undefined =>
  [...models].sort(byModelPreference)[0];

const chooseClaudeVariant = (
  candidates: ModelInfo[],
  exactBase: ModelInfo | undefined,
  intent: ModelResolutionIntent,
): ModelInfo | undefined => {
  const effort = intent.reasoningEffort;
  if (!intent.context1m && !effort) {
    return exactBase ?? firstPreferred(candidates);
  }

  if (intent.context1m) {
    const oneMillion = candidates.filter(supportsOneMillionContext);
    const oneMillionWithEffort = oneMillion.filter((model) =>
      supportsReasoningEffort(model, effort)
    );
    return firstPreferred(oneMillionWithEffort) ?? firstPreferred(oneMillion) ??
      exactBase ?? firstPreferred(candidates);
  }

  const withEffort = candidates.filter((model) =>
    supportsReasoningEffort(model, effort)
  );
  return firstPreferred(withEffort.filter(supportsOneMillionContext)) ??
    firstPreferred(withEffort) ?? exactBase ?? firstPreferred(candidates);
};

export const resolveModelInModels = (
  models: ModelsResponse,
  modelId: string,
  intent: ModelResolutionIntent = {},
): ModelInfo | undefined => {
  const normalized = normalizedClaudeLookupId(modelId);
  const exact = models.data.find((model) => model.id === normalized);
  const exactBase = exact && STANDARD_CLAUDE_BASE_ID.test(exact.id)
    ? exact
    : undefined;

  if (exact && !exactBase) return exact;

  const baseId = standardClaudeBaseId(normalized);
  if (!baseId) return exact;

  const candidates = models.data.filter((model) =>
    isClaudeVariantForBase(baseId, model)
  );
  if (candidates.length === 0) return exact;

  return chooseClaudeVariant(candidates, exactBase, intent);
};

export const resolveModelForRequest = async (
  modelId: string,
  intent: ModelResolutionIntent = {},
): Promise<string> => {
  const accounts = await getRepo().github.listAccounts();
  const byId = new Map<string, ModelInfo>();

  for (const account of accounts) {
    const result = await loadModels(account.token, account.accountType);
    if (result.type !== "models") continue;

    for (const model of result.data.data) {
      // Model IDs are treated as global upstream contracts: if multiple
      // accounts expose the same id, their capability metadata is expected to
      // describe the same model. Account fallback handles visibility and
      // backoff, not per-account capability variants for the same id.
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
  }

  const info = resolveModelInModels(
    { object: "list", data: [...byId.values()] },
    modelId,
    intent,
  );

  return info?.id ?? fallbackModelId(modelId);
};
