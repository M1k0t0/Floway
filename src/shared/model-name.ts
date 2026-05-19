// Low-level Claude syntax helpers. The LLM compatibility resolver owns route-time
// model selection; this module only converts dashed Claude version aliases into
// Copilot's dotted upstream form for lookup/fallback paths.

const CLAUDE_MINOR_VERSION_DATE_SUFFIX = /^(.*(?:\d+\.\d+|\d+-\d+))-\d{8}$/;
const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/;
const CLAUDE_DATE_SUFFIX = /-\d{8}$/;

/** Canonical upstream form — for calls into Copilot. */
export function normalizeModelName(id: string): string {
  if (!id.startsWith("claude-")) return id;
  return id.replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, "$1.$2");
}

export function dateSuffixedClaudeModelAliasTarget(
  id: string,
): string | undefined {
  if (!id.startsWith("claude-")) return undefined;
  const match = id.match(CLAUDE_MINOR_VERSION_DATE_SUFFIX);
  return match ? normalizeModelName(match[1]) : undefined;
}

// Single source of truth for display-id derivation. /api/models, the
// /api/token-usage and /api/performance aggregations, and the pricing lookup
// in control-plane token-usage pricing all consume display ids from here so dashboards
// and external clients see one stable id per Claude family. Storage, export,
// and import remain raw-model contracts; this helper only governs query and
// display output.
export function displayModelName(id: string): string {
  if (!id.startsWith("claude-")) return id;
  return normalizeModelName(id)
    .replace(CLAUDE_DATE_SUFFIX, "")
    .replace(CLAUDE_VARIANT_SUFFIX, "")
    .replace(/(\d)\.(\d)/g, "$1-$2");
}
