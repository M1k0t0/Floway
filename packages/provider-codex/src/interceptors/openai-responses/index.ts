// Codex-only OpenAI Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has OpenAI Responses interceptors at all.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProviderOpenAIResponsesResult } from '@floway-dev/provider';

// Order rationale: default injection inspects the input representation while
// unsupported-field stripping touches only unrelated top-level fields.
//
// Codex interceptors are payload/header mutators. The provider terminal owns
// the selected model's standard/Lite request bridge and the corresponding
// per-frame callable-identity restoration.
export const CODEX_OPENAI_RESPONSES_BOUNDARY: readonly Interceptor<OpenAIResponsesBoundaryCtx, object, ProviderOpenAIResponsesResult>[] = [
  injectDefaultInstructions,
  stripUnsupportedFields,
];
