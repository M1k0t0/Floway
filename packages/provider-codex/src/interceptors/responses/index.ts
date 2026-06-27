// Codex-only Responses workarounds. The chain is a boundary the Codex provider
// runs inside its own call methods, so the gateway main flow never knows that
// Codex has Responses interceptors at all.

import { injectDefaultInstructions } from './inject-default-instructions.ts';
import { stripUnsupportedFields } from './strip-unsupported-fields.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';

// Order rationale: neither interceptor below reads or writes a field the
// other touches, so order is positional only.
//
// Each interceptor is generic over the terminal result type: the streaming
// `/responses` chain runs to ProviderStreamResult, the compaction chain runs
// to ProviderCompactionResult, and both feed the same boundary ctx. Codex
// interceptors are pure payload/header mutators, so the streaming variant
// returns ProviderStreamResult directly (no per-frame lift/lower).
export const codexResponsesChain = <TResult>(): readonly Interceptor<ResponsesBoundaryCtx, object, TResult>[] => [
  injectDefaultInstructions,
  stripUnsupportedFields,
];
