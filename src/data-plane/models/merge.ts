// Merge Claude reasoning-effort and 1M-context variants into a single base id
// for /v1/models surfacing. The data plane keeps requesting upstream by their
// real ids — request planning still resolves the variant from intent in
// src/data-plane/llm/shared/models/resolve-model.ts. This merge is purely an
// outbound view so OpenAI/Anthropic-shaped clients see one Claude model id
// per family.
//
// Field policy:
//   id, version, name, policy.terms, capabilities.family    -> base
//   capabilities.limits.max_*_tokens                        -> max across siblings
//   capabilities.supports.reasoning_effort                  -> union
//   billing.multiplier                                      -> base
//   billing.restricted_to                                   -> union
//   everything else                                         -> identical across siblings, taken from base
//
// Notes on billing fields: the gateway's clients are OpenAI/Anthropic-shaped
// SDKs that do not consume billing.* — Copilot's vscode client owns those
// fields. The merged value cannot honestly represent the real per-effort
// cost (e.g. 4.7 base/high/xhigh have multipliers 15/30/45), so we expose the
// base value with this comment to head off "shouldn't this be max?" review
// questions. restricted_to is a union for the same reason: a permissive view
// for clients that do happen to read it; upstream still enforces real access.

import { displayModelName } from "../../shared/model-name.ts";
import type { ModelInfo, ModelsResponse } from "./types.ts";

const isClaudeModel = (model: ModelInfo): boolean =>
  model.id.startsWith("claude-");

const maxOf = (...values: (number | undefined)[]): number | undefined => {
  const defined = values.filter((v): v is number => typeof v === "number");
  return defined.length > 0 ? Math.max(...defined) : undefined;
};

const unionStrings = (
  ...lists: (readonly string[] | undefined)[]
): string[] | undefined => {
  // Returns undefined when no source had the field at all, vs [] when at least
  // one source had it explicitly empty. Callers (e.g. billing.restricted_to)
  // use the absent/present distinction to decide whether to set the key.
  const seen: string[] = [];
  let saw = false;
  for (const list of lists) {
    if (!list) continue;
    saw = true;
    for (const v of list) if (!seen.includes(v)) seen.push(v);
  }
  return saw ? seen : undefined;
};

const pickBase = (variants: ModelInfo[]): ModelInfo => {
  const baseId = displayModelName(variants[0].id);
  const exact = variants.find((m) => m.id === baseId);
  if (exact) return exact;
  // No exact base id (e.g. only suffixed variants exist); pick the shortest id
  // so the variant closest to the base wins.
  return [...variants].sort((a, b) => a.id.length - b.id.length)[0];
};

const mergeVariantGroup = (variants: ModelInfo[]): ModelInfo => {
  const base = pickBase(variants);
  const baseId = displayModelName(base.id);
  const limits = base.capabilities?.limits ?? {};
  const supports = base.capabilities?.supports ?? {};

  const merged: ModelInfo = {
    ...base,
    id: baseId,
    version: baseId,
    capabilities: {
      ...base.capabilities,
      family: baseId,
      limits: {
        ...limits,
        max_context_window_tokens: maxOf(
          ...variants.map((v) =>
            v.capabilities?.limits?.max_context_window_tokens
          ),
        ),
        max_prompt_tokens: maxOf(
          ...variants.map((v) => v.capabilities?.limits?.max_prompt_tokens),
        ),
        max_output_tokens: maxOf(
          ...variants.map((v) => v.capabilities?.limits?.max_output_tokens),
        ),
      },
      supports: {
        ...supports,
        reasoning_effort: unionStrings(
          ...variants.map((v) => v.capabilities?.supports?.reasoning_effort),
        ),
      },
    },
  };

  if (base.billing) {
    const restrictedUnion = unionStrings(
      ...variants.map((v) => v.billing?.restricted_to),
    );
    merged.billing = {
      ...base.billing,
      ...(restrictedUnion ? { restricted_to: restrictedUnion } : {}),
    };
  }

  return merged;
};

export const mergeClaudeVariants = (
  models: ModelsResponse,
): ModelsResponse => {
  const groups = new Map<string, ModelInfo[]>();
  const order: string[] = [];

  for (const model of models.data) {
    const key = isClaudeModel(model) ? displayModelName(model.id) : model.id;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(model);
  }

  return {
    object: models.object,
    data: order.map((key) => mergeVariantGroup(groups.get(key)!)),
  };
};
