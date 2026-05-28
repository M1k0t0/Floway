import { withResponsesServerToolShim } from './server-tool-shim.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Source-side Responses interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`). Provider-specific
// tool-shape stripping runs on the target side; this list carries only
// behaviors that must observe the source-side payload (e.g., the
// `web_search` hosted tool the shim rewrites before upstream sees it).
export const responsesSourceInterceptors: readonly ResponsesInterceptor[] = [
  withResponsesServerToolShim([
    webSearchServerTool,
  ]),
];
