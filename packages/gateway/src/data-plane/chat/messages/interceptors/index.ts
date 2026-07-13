import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor } from './types.ts';
import { withMessagesWebSearchShim } from './web-search-shim.ts';

// Unified Messages interceptor list. All entries are attached to every
// candidate; each interceptor's body decides whether to act (flag-gated entries
// early-return on `providerModelOf(ctx.candidate).enabledFlags.has(flagId)`).
//
// Translated requests re-enter the selected target protocol's chain. The role
// compatibility entry therefore acts only when Messages is the final target.
//
//   - withMessagesWebSearchShim: registered first so its replay rewrite and
//     intercept loop wrap the rest of the chain. Unconditional for translated
//     targets (Responses / Chat Completions cannot carry Anthropic server
//     tools); gated by `messages-web-search-shim` for native Messages targets.
//   - stripBillingAttribution: gated by `strip-billing-attribution` (default
//     on for copilot/azure/custom, off for claude-code). On candidates
//     where it runs, it scrubs Claude Code's `x-anthropic-billing-header` /
//     `cch=` markers out of the source-shape system prompt so prompt-cache
//     hits survive across requests; on claude-code, the block is left intact
//     because Anthropic uses it for plan-tier billing.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
//   - withRoleCompatibilityApplied: Anthropic's top-level `payload.system` is
//     the only first-position system slot, so the interleaved-system flag
//     rewrites every inline system message to user.
export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withMessagesWebSearchShim,
  stripBillingAttribution,
  withReasoningDisabledOnForcedToolChoice,
  withRoleCompatibilityApplied,
];

export const messagesCountTokensInterceptors = [
  withRoleCompatibilityApplied,
] as const satisfies readonly MessagesCountTokensInterceptor[];
