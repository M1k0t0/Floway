import { withDemoteDeveloperToSystem } from './demote-developer-to-system.ts';
import { withInterleavedSystemDemotedToUser } from './demote-interleaved-system-to-user.ts';
import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import { withPromoteSystemToDeveloper } from './promote-system-to-developer.ts';
import { withPromptCacheKeyStripped } from './strip-prompt-cache-key.ts';
import type { ChatCompletionsInterceptor } from './types.ts';
import { withVendorDeepseekChatCompletionsNormalize } from './vendor-deepseek-normalize.ts';
import { withVendorKimiChatCompletionsNormalize } from './vendor-kimi-normalize.ts';
import { withVendorQwenChatCompletionsNormalize } from './vendor-qwen-normalize.ts';

// Unified Chat Completions interceptor list. All entries are attached to
// every candidate; each interceptor's body decides whether to act (flag-gated
// entries early-return on `providerModelOf(ctx.candidate).enabledFlags.has(flagId)`).
//
// Translated requests re-enter the selected target protocol's chain. The role
// compatibility entries therefore act only when Chat Completions is the final
// target, after pairwise translation has finished.
//
//   - withUsageStreamOptionsIncluded, withUsageNormalized: unconditional.
//     Both gate the gateway's usage-tracking pipeline. Turning either off
//     would silently break per-key telemetry, so neither is surfaced as a flag.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`. Emits the gateway's canonical
//     "no reasoning" sentinel only; vendor wire form is the vendor's job.
//   - withPromoteSystemToDeveloper: gated by `promote-system-to-developer`.
//     Rewrites system messages to the developer role accepted by the selected
//     upstream when Chat Completions is the target; translated targets own role
//     handling inside their own chain.
//   - withDemoteDeveloperToSystem: gated by `demote-developer-to-system`.
//     Runs after promotion, so enabling both makes demotion authoritative.
//   - withInterleavedSystemDemotedToUser: gated by
//     `demote-interleaved-system-to-user`. Rewrites any `role: 'system'` that
//     appears after the leading contiguous system run to `role: 'user'` so
//     upstreams that reject mid-stream system messages still accept the body.
//     With all three role flags enabled, the ordered chain is
//     `system → developer → system → user` for interleaved messages.
//   - withPromptCacheKeyStripped: gated by `strip-prompt-cache-key`. Drops
//     the top-level `prompt_cache_key` field for upstreams that reject it as
//     an unknown argument (e.g. Azure DeepSeek). Runs before vendor
//     normalizers so vendor-specific translation sees the already-stripped
//     canonical payload.
//   - withVendor*ChatCompletionsNormalize: gated by `vendor-<X>`. Registered
//     LAST so that on the outbound path each gets the final say on the wire
//     body and on the inbound path each gets the first say on the upstream
//     stream — the generic interceptors above only see OpenAI-canonical form.
//     Vendor flags are mutually exclusive in practice, but the interceptors
//     are independent and run in declared order if more than one is somehow
//     enabled.
export const chatCompletionsInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
  withUsageNormalized,
  withReasoningDisabledOnForcedToolChoice,
  withPromoteSystemToDeveloper,
  withDemoteDeveloperToSystem,
  withInterleavedSystemDemotedToUser,
  withPromptCacheKeyStripped,
  withVendorDeepseekChatCompletionsNormalize,
  withVendorQwenChatCompletionsNormalize,
  withVendorKimiChatCompletionsNormalize,
];
