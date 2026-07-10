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
//   - hoistLeadingDeveloperToInstructions adapts standard Responses' leading
//     instruction-prefix items to Codex's top-level `instructions` slot.
//   - injectDefaultInstructions fills the required slot only if the caller and
//     hoist stage left it empty.
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
