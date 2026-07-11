// Codex-only Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has Responses interceptors at all.

import { hoistLeadingDeveloperToInstructions } from './hoist-leading-developer-to-instructions.ts';
import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProviderResponsesResult } from '@floway-dev/provider';

// Order rationale:
//   - hoistLeadingDeveloperToInstructions runs after the gateway's required
//     conversion for Codex Responses, which rejects `role: 'system'` in `input`.
//     It merges only a contiguous leading text-representable developer prefix
//     into `instructions`; later developer messages remain inline in order.
//   - injectDefaultInstructions fills the required slot only if neither the
//     caller nor the prefix hoist produced a non-empty value.
//   - stripUnsupportedFields then removes regular Responses fields the
//     ChatGPT-subscription backend rejects.
//
// Codex interceptors are pure payload/header mutators, so the chain's only
// terminal — the streaming `generate` + non-streaming `compact` dispatch —
// returns its `ProviderResponsesResult` directly without any per-frame
// lift/lower step.
export const CODEX_RESPONSES_BOUNDARY: readonly Interceptor<ResponsesBoundaryCtx, object, ProviderResponsesResult>[] = [
  hoistLeadingDeveloperToInstructions,
  injectDefaultInstructions,
  stripUnsupportedFields,
];
