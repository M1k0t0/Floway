import { normalizeDomainEntry, normalizeDomainList } from '../../../../../tools/web-search/domain-normalize.ts';
import { fetchPageAndRecordUsage, fetchPageWithoutRecordingUsage } from '../../../../../tools/web-search/fetch-page.ts';
import { resolveConfiguredWebSearchProvider } from '../../../../../tools/web-search/provider.ts';
import { loadSearchConfig } from '../../../../../tools/web-search/search-config.ts';
import { searchWebAndRecordUsage, searchWebWithoutRecordingUsage } from '../../../../../tools/web-search/search.ts';
import type { ConfiguredWebSearchProvider, WebSearchProvider, WebSearchProviderName } from '../../../../../tools/web-search/types.ts';
import { truncatePreservingCodePoints } from '../../../../shared/text.ts';
import { serverToolResultSlot } from '../server-tool-shim.ts';
import type { ServerToolLoopState, ServerToolOutputItem, ServerToolRegistration } from '../server-tool-shim.ts';
import type { ResponseFunctionCallOutputItem, ResponseFunctionTool, ResponseFunctionToolCallItem, ResponseHostedTool, ResponseInputItem, ResponseInputWebSearchCall, ResponseOutputWebSearchCall, ResponseTool, ResponseWebSearchAction, ResponseWebSearchResult } from '@floway-dev/protocols/responses';
import { WEB_SEARCH_HOSTED_TYPE_NAMES } from '@floway-dev/protocols/responses';

// Runtime set derived from the canonical tuple declared next to
// `ResponseHostedToolType` so the type union and runtime check can't drift.
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_tool.py
//   https://github.com/openai/openai-python/blob/e75766769547601a25ed83b666c4d0fd046881f0/src/openai/types/responses/web_search_preview_tool.py
export const WEB_SEARCH_HOSTED_TYPES: ReadonlySet<string> = new Set<string>(WEB_SEARCH_HOSTED_TYPE_NAMES);

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the umbrella
// uses the underscored form of the model's training-time `web.run`.
export const SHIM_TOOL_NAME = 'web_search';

export interface ShimToolFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: { city?: string; region?: string; country?: string; timezone?: string };
  maxResults?: number;
}

// Approximates the ~40 results native hosted web_search returns
// regardless of search_context_size; backends bill per call, so larger
// result sets only multiply upstream context-window cost. `medium` is
// the native default (matches openai-python `WebSearchTool.search_context_size`
// docstring: "Defaults to 'medium'") — when the client omits the field
// or sends an explicit `'medium'`, we still pass the corresponding
// maxResults so providers don't fall back to their own (smaller)
// default count.
export const CONTEXT_SIZE_TO_MAX_RESULTS: Record<'low' | 'medium' | 'high', number> = {
  low: 10,
  medium: 20,
  high: 40,
};

const DEFAULT_SEARCH_CONTEXT_SIZE: keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS = 'medium';

export const isValidSearchContextSize = (v: unknown): v is keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS =>
  typeof v === 'string' && v in CONTEXT_SIZE_TO_MAX_RESULTS;

// Both `function` and `custom` client tools share the upstream callable
// namespace (responses-via-* translators wrap `custom` as `function`
// for non-Responses upstreams), so a client tool of either kind named
// `web_search` collides with the umbrella. Returning a resolved name
// (rather than throwing) lets such a client coexist.
// The hosted tool's `user_location` must surface to the model, not just
// to the backend provider — without this hint the model asks "Which
// city should I check?" even when the client supplied one.
const formatUserLocation = (loc: NonNullable<ShimToolFilters['userLocation']>): string => {
  const parts: string[] = [];
  if (loc.city) parts.push(loc.city);
  if (loc.region && loc.region !== loc.city) parts.push(loc.region);
  if (loc.country) parts.push(loc.country);
  const joined = parts.join(', ');
  if (!loc.timezone) return joined;
  return joined.length === 0 ? `(timezone: ${loc.timezone})` : `${joined} (timezone: ${loc.timezone})`;
};

// `web.run` umbrella shape: 13 sub-properties on a single tool. The
// shim implements 3 (`search_query`, `open`, `find`); the other 10
// surface as per-entry error IRs at dispatch time. The description
// deliberately omits the unsupported ones.
//   https://github.com/openai/harmony/blob/abd677f7ac962629c808197caa1feb9e3e95d2b0/src/chat.rs#L259-L313
const buildUmbrellaTool = (
  name: string,
  userLocation?: ShimToolFilters['userLocation'],
): ResponseFunctionTool => {
  const baseDescription
    = 'Accesses the web through three actions: searching, opening a page, and finding text inside a page. '
    + 'Multiple sub-property arrays may be populated in one call to dispatch several operations in parallel.';
  const hasUserLocation = userLocation !== undefined && (
    (userLocation.city !== undefined && userLocation.city.length > 0)
    || (userLocation.region !== undefined && userLocation.region.length > 0)
    || (userLocation.country !== undefined && userLocation.country.length > 0)
    || (userLocation.timezone !== undefined && userLocation.timezone.length > 0)
  );
  const description = hasUserLocation
    ? `${baseDescription} Default user location: ${formatUserLocation(userLocation)}. Use this as the default when the user asks about local information without specifying a location.`
    : baseDescription;

  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'array',
          description: 'Run one or more web searches. Each entry produces an independent search-results list.',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'The search query.' },
            },
            required: ['q'],
            additionalProperties: false,
          },
        },
        open: {
          type: 'array',
          description: 'Fetch the readable text content of fully qualified URLs.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL.' },
            },
            required: ['ref_id'],
            additionalProperties: false,
          },
        },
        find: {
          type: 'array',
          description: 'Find exact case-insensitive matches of `pattern` inside the page at `ref_id`. Returns up to 10 matches with ~200 characters of surrounding context.',
          items: {
            type: 'object',
            properties: {
              ref_id: { type: 'string', description: 'An HTTP or HTTPS URL of the page to search inside.' },
              pattern: { type: 'string', description: 'Case-insensitive substring to find.' },
            },
            required: ['ref_id', 'pattern'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    // Strict mode requires `required` to list every property, but every
    // sub-property here is optional (one call may set only
    // `search_query`, another only `open`).
    strict: false,
  };
};

export const isHostedWebSearchTool = (tool: ResponseTool): tool is ResponseHostedTool =>
  typeof tool.type === 'string' && WEB_SEARCH_HOSTED_TYPES.has(tool.type);

const extractFilters = (tool: ResponseHostedTool): ShimToolFilters => {
  const out: ShimToolFilters = {};
  if (tool.filters?.allowed_domains) out.allowedDomains = tool.filters.allowed_domains;
  if (tool.filters?.blocked_domains) out.blockedDomains = tool.filters.blocked_domains;
  if (tool.user_location) out.userLocation = tool.user_location;
  // Default to native's documented default (`medium`) when omitted.
  // Without this, a provider-side default (e.g. Tavily's smaller
  // baseline count) would silently shrink the result set on requests
  // that didn't think about search_context_size at all.
  const size = tool.search_context_size ?? DEFAULT_SEARCH_CONTEXT_SIZE;
  out.maxResults = CONTEXT_SIZE_TO_MAX_RESULTS[size as keyof typeof CONTEXT_SIZE_TO_MAX_RESULTS];
  return out;
};

export interface PreparedTools {
  filters: ShimToolFilters;
}

export interface PrepareToolsError {
  /** Human-readable error message; goes into the 400 envelope's `error.message`. */
  message: string;
  /** JSON-Pointer-style location inside `tools[]`; goes into `error.param`. */
  param: string;
}

export type PrepareToolsResult =
  | { ok: true; prepared: PreparedTools }
  | { ok: false; error: PrepareToolsError };

// Per-list cap matches the OpenAI documented "up to 100 allowed_domains
// or up to 100 blocked_domains" limit.
//   https://developers.openai.com/api/docs/guides/tools-web-search.md
const MAX_DOMAIN_LIST_ENTRIES = 100;

// Domain-list entry validator. First-failure-wins: returns at the
// first malformed entry so the 400 envelope names ONE offending
// value. We reject non-string entries with their type description
// (matches native's `invalid_type`-shaped rejection for non-string
// list entries); valid-string-but-bad-host entries reject with a
// simple message naming the value.
const validateDomainListEntry = (
  raw: unknown,
): { ok: true } | { ok: false; message: string } => {
  if (typeof raw !== 'string') {
    return { ok: false, message: `Expected string, got ${raw === null ? 'null' : typeof raw}.` };
  }
  if (raw.trim() === '' || /^https?:\/\//i.test(raw) || /[\s/?#@:]/.test(raw) || normalizeDomainEntry(raw) === null) {
    return { ok: false, message: `Invalid domain '${raw}'` };
  }
  return { ok: true };
};

// Validate the parts of a hosted-web-search entry the shim acts on.
// Anything else (`external_web_access`, `return_token_budget`, etc.)
// is silently dropped along with the hosted tool itself — the shim
// replaces the hosted entry with its umbrella function tool, so any
// hosted-only field the shim doesn't process never reaches upstream
// regardless.
const validateHostedEntry = (tool: ResponseHostedTool): PrepareToolsError | null => {
  const sizeField = (tool as { search_context_size?: unknown }).search_context_size;
  if (sizeField !== undefined && sizeField !== null && !isValidSearchContextSize(sizeField)) {
    return {
      message: `web_search tool search_context_size must be one of ${Object.keys(CONTEXT_SIZE_TO_MAX_RESULTS).map(k => `'${k}'`).join(' | ')}; got ${JSON.stringify(sizeField)}.`,
      param: 'tools[].search_context_size',
    };
  }
  const filtersField = (tool as { filters?: unknown }).filters;
  if (filtersField === undefined || filtersField === null) return null;
  if (typeof filtersField !== 'object' || Array.isArray(filtersField)) {
    return {
      message: `web_search tool filters must be an object; got ${Array.isArray(filtersField) ? 'array' : typeof filtersField}.`,
      param: 'tools',
    };
  }
  for (const field of ['allowed_domains', 'blocked_domains'] as const) {
    const value = (filtersField as Record<string, unknown>)[field];
    // `undefined` and `null` both read as "omit" — same no-op
    // semantics as an empty list.
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      return {
        message: `web_search tool filters.${field} must be an array of strings; got ${typeof value}.`,
        param: 'tools',
      };
    }
    if (value.length > MAX_DOMAIN_LIST_ENTRIES) {
      return {
        message: `web_search tool filters.${field} accepts at most ${MAX_DOMAIN_LIST_ENTRIES} entries; got ${value.length}.`,
        param: 'tools',
      };
    }
    for (const entry of value) {
      const verdict = validateDomainListEntry(entry);
      if (!verdict.ok) {
        return { message: verdict.message, param: 'tools' };
      }
    }
  }
  return null;
};

// Validate every hosted web_search entry and return the filters the
// shim will act on. When a request carries multiple hosted blocks the
// LAST one's filters win (most-recent declaration), so callers don't
// have to define a tie-break. Name-collision resolution and the
// hosted-tool → umbrella-function replacement are the shim's
// responsibility (`resolveServerToolName` /
// `replaceHostedToolsWithFunctionTool`); this function only reads the
// hosted entries.
export const prepareToolsForShim = (
  tools: ResponseTool[],
): PrepareToolsResult => {
  let hostedSeen = false;
  let lastHostedFilters: ShimToolFilters = {};
  for (const tool of tools) {
    if (isHostedWebSearchTool(tool)) {
      const reject = validateHostedEntry(tool);
      if (reject !== null) return { ok: false, error: reject };
      hostedSeen = true;
      lastHostedFilters = extractFilters(tool);
      continue;
    }
  }

  if (!hostedSeen) {
    return { ok: true, prepared: { filters: {} } };
  }

  return { ok: true, prepared: { filters: lastHostedFilters } };
};

// Parses one umbrella function_call's arguments into a flat list of
// logical operations. 13 documented sub-properties total; shim
// implements 3 (search/open/find), the other 10 surface as
// `unsupported` ops.

export type ShimOperationErrorKind = 'invalid-ref' | 'missing-arg';

export type ShimLogicalOperation =
  | {
    kind: 'search';
    /** Original index inside the umbrella's `search_query` array. */
    arrayIndex: number;
    query: string;
    /** When set, dispatch returns this verbatim instead of hitting the backend. */
    error?: string;
    errorKind?: ShimOperationErrorKind;
  }
  | {
    kind: 'open';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
  }
  | {
    kind: 'find';
    arrayIndex: number;
    error?: string;
    errorKind?: ShimOperationErrorKind;
    url: string;
    pattern: string;
  }
  | {
    kind: 'unsupported';
    /** The umbrella sub-property name the model populated (e.g. `click`). */
    subProperty: string;
    /** Original index inside that sub-property's array. */
    arrayIndex: number;
  }
  | {
    kind: 'wrong-type';
    subProperty: 'search_query' | 'open' | 'find';
    actualType: string;
  };

export type ParsedUmbrella = { kind: 'ops'; ops: ShimLogicalOperation[] } | { kind: 'malformed' };

// Stricter than `/^https?:\/\//i`: that regex accepts `https://` (empty
// host). Reject malformed refs at parse time so dispatch always sees a
// well-formed URL.
const isUrl = (s: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  return true;
};

const refIdError = (refId: string): string =>
  `Error: ref_id must be a fully-qualified URL in the gateway shim (got '${refId}'). The gateway shim does not preserve prior-call ids across turns.`;

const missingArgError = (field: string): string =>
  `Error: missing required argument "${field}".`;

const SUPPORTED_KEYS: ReadonlySet<string> = new Set(['search_query', 'open', 'find']);

export const parseUmbrellaOperations = (args: Record<string, unknown> | null): ParsedUmbrella => {
  if (args === null) return { kind: 'malformed' };
  const ops: ShimLogicalOperation[] = [];

  // Surface wrong-typed keys as visible IRs.
  const describeType = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

  const searchQuery = args.search_query;
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) {
      ops.push({ kind: 'wrong-type', subProperty: 'search_query', actualType: describeType(searchQuery) });
    } else {
      for (let i = 0; i < searchQuery.length; i++) {
        const entry = searchQuery[i];
        const q = entry !== null && typeof entry === 'object' && 'q' in entry && typeof entry.q === 'string'
          ? entry.q
          : '';
        if (q === '') {
          ops.push({ kind: 'search', arrayIndex: i, query: '', error: missingArgError('q'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'search', arrayIndex: i, query: q });
      }
    }
  }

  const open = args.open;
  if (open !== undefined) {
    if (!Array.isArray(open)) {
      ops.push({ kind: 'wrong-type', subProperty: 'open', actualType: describeType(open) });
    } else {
      for (let i = 0; i < open.length; i++) {
        const entry = open[i];
        const refId = entry !== null && typeof entry === 'object' && 'ref_id' in entry && typeof entry.ref_id === 'string'
          ? entry.ref_id
          : '';
        if (refId === '') {
          ops.push({ kind: 'open', arrayIndex: i, url: '', error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'open', arrayIndex: i, url: refId, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        ops.push({ kind: 'open', arrayIndex: i, url: refId });
      }
    }
  }

  const find = args.find;
  if (find !== undefined) {
    if (!Array.isArray(find)) {
      ops.push({ kind: 'wrong-type', subProperty: 'find', actualType: describeType(find) });
    } else {
      for (let i = 0; i < find.length; i++) {
        const entry = find[i];
        const refId = entry !== null && typeof entry === 'object' && 'ref_id' in entry && typeof entry.ref_id === 'string'
          ? entry.ref_id
          : '';
        const pattern = entry !== null && typeof entry === 'object' && 'pattern' in entry && typeof entry.pattern === 'string'
          ? entry.pattern
          : '';
        if (refId === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: '', pattern, error: missingArgError('ref_id'), errorKind: 'missing-arg' });
          continue;
        }
        if (!isUrl(refId)) {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern, error: refIdError(refId), errorKind: 'invalid-ref' });
          continue;
        }
        if (pattern === '') {
          ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern: '', error: missingArgError('pattern'), errorKind: 'missing-arg' });
          continue;
        }
        ops.push({ kind: 'find', arrayIndex: i, url: refId, pattern });
      }
    }
  }

  // Top-level keys outside `search_query` / `open` / `find` surface as
  // one `unsupported` op per array entry (or a single op for a scalar).
  for (const key of Object.keys(args)) {
    if (SUPPORTED_KEYS.has(key)) continue;
    const value = args[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: i });
      }
    } else {
      ops.push({ kind: 'unsupported', subProperty: key, arrayIndex: 0 });
    }
  }

  return {
    kind: 'ops',
    ops,
  };
};

export const unsupportedSubPropertyText = (subProperty: string): string =>
  `Error: the \`${subProperty}\` sub-property is not supported by this gateway. `
  + 'Only `search_query`, `open`, and `find` are available.';

export const wrongTypeSubPropertyText = (subProperty: string, actualType: string): string =>
  `Error: the \`${subProperty}\` sub-property must be an array of objects; got ${actualType}.`;

// Web_search_call IR — canonical representation of one search action,
// the model-visible error strings that feed into IR results, and the
// downstream lifecycle frames the IR materializes into. `id` is both the
// value the client sees on the synthesized `web_search_call` item and
// the seed for the upstream call_id when the reverse path replays the
// item.
//
// Error-text phrasings closely follow OpenAI's gpt-oss reference
// simple_browser tool so gpt-oss-family models (trained on those exact
// phrasings) recognize the structure; non-OpenAI models read them as
// plain natural-language tool output.
//
// References (pinned to commit 285b05d for stable line numbers):
// - gpt-oss simple_browser_tool.py `find` no-match phrase, line 246:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L246
// - gpt-oss simple_browser_tool.py `BackendError` fetching phrase, lines 444-445:
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py#L444-L445
// - litellm `Search failed: <e>` idiom:
//   https://github.com/BerriAI/litellm/blob/main/litellm/integrations/websearch_interception/transformation.py

// Sole safety valve — do not introduce additional safety caps in
// this server tool. Past iteration 30 the dispatcher swaps backend
// dispatch for the cap snippet so the model sees the bypass and
// steers itself toward a terminal message.
export const ITERATION_CAP = 30;

export interface WebSearchCallIR {
  id: string;
  status: 'completed';
  action: ResponseWebSearchAction;
  /** Always populated; see file-header divergence note in server-tools/web-search.ts. */
  results: ResponseWebSearchResult[];
  /**
   * Set when this IR was built from a replayed input item that lacked
   * a `results` field — e.g. codex CLI strips the field before
   * persisting to its session rollout. `irToOutputText` swaps the
   * usual formatted snippet for a one-line notice so the model knows
   * the prior content was not preserved (rather than confusing it
   * with a genuine zero-hit search).
   */
  resultsStripped?: boolean;
}

export const synthesizeWebSearchCallId = (): string =>
  `ws_gw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const searchFailedText = (providerMessage: string): string =>
  `Search failed: ${providerMessage}`;

export const openFailedText = (url: string, providerMessage: string): string =>
  `Error fetching URL \`${url}\`: ${providerMessage}`;

export const findNoMatchesText = (pattern: string, url: string): string =>
  `No matching \`${pattern}\` found on ${url}.`;

export const iterationCapText
  = `Web search iteration limit (${ITERATION_CAP}) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you've gathered.`;

export const truncationSentinel = (fullBytes: number): string =>
  `[Content truncated; full page is ${fullBytes} bytes. Use web_search's \`find\` sub-property with a pattern to locate specific content.]`;

// Returned as the function_call_output when a replayed `web_search_call`
// item arrived without `results` (the client did not preserve them
// across the round trip). The model still sees the action via the
// paired function_call's arguments, so this only has to communicate
// that re-searching is the way to recover the contents.
export const resultsStrippedText
  = 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.';

// Returned as the function_call_output (and as the snippet of the
// synthesized lifecycle item on the malformed-args path) when an umbrella
// call has no logical ops the shim can attribute — empty args object,
// malformed JSON, or a non-object top-level shape. The hint names the
// supported sub-properties so the model knows what shape to retry with.
export const emptyUmbrellaArgsText
  = 'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).';

export const searchIr = (
  id: string,
  query: string,
  results: ResponseWebSearchResult[],
  sources?: { type: 'url'; url: string }[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Emit both `query` and `queries`; see `actionSearchQueries`.
  action: {
    type: 'search',
    query,
    queries: [query],
    // Native gates `sources` on `include:
    // ["web_search_call.action.sources"]`; only include when the
    // client opted in. The producer (dispatch.ts) decides whether to
    // pass the list based on the include token.
    ...(sources !== undefined ? { sources } : {}),
  },
  results,
});

export const openPageIr = (
  id: string,
  url: string | undefined,
  results: ResponseWebSearchResult[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Omit `url` when undefined to match native's soft-failure shape;
  // never emit `url: ''`.
  action: url !== undefined && url.length > 0
    ? { type: 'open_page', url }
    : { type: 'open_page' },
  results,
});

export const findInPageIr = (
  id: string,
  url: string,
  pattern: string,
  results: ResponseWebSearchResult[],
): WebSearchCallIR => ({
  id,
  status: 'completed',
  action: { type: 'find_in_page', url, pattern },
  results,
});

// No native action.type fits shim-only error classes (unknown
// sub-property, malformed args); encode them via action.type:'search'
// with the diagnostic in queries[0] so wire-typed SDKs still parse the
// item.
export const schemaErrorIr = (
  id: string,
  queryLabel: string,
  title: string,
  snippet: string,
): WebSearchCallIR => ({
  id,
  status: 'completed',
  // Emit both `query` and `queries`; see `actionSearchQueries`.
  action: { type: 'search', query: queryLabel, queries: [queryLabel] },
  results: [{
    type: 'text_result',
    url: '',
    title,
    snippet,
  }],
});

// openai-python `ActionSearch.query` is a single string; some clients
// send only `queries[]`. Accept both: the shim emits both fields on
// every search action so typed SDKs reading either one keep working.
const actionSearchQueries = (action: Extract<ResponseWebSearchAction, { type: 'search' }>): string[] => {
  if (action.queries !== undefined) return action.queries;
  if (action.query !== undefined) return [action.query];
  return [];
};

/**
 * Wire input item → IR. Returns null only when `action` is missing —
 * without it we can't even tell upstream what was previously searched.
 * `id` is synthesized when missing (it's an internal ref the model
 * never sees); `results` missing toggles `resultsStripped` so the
 * function_call_output reads as "not preserved" instead of "no hits".
 *
 * Replay today is reconstructed solely from the public wire item, so a
 * client that drops `results` from the echoed `web_search_call` (e.g.
 * codex CLI strips it before persisting to its rollout) forces the
 * `resultsStripped` degradation. A separate effort persists synthetic
 * Responses items server-side together with a private payload (the
 * `responses_items` store; `StoredResponsesItemPayload.private`,
 * reached via `getRepo().responsesItems`). Once the shim populates that
 * private payload at synthesis time and the replay seam
 * (`transformInputItemsForWebSearch`) gains access to a lookup, this
 * function should first restore the real results from the persisted
 * private payload keyed by the item's `id`, and fall back to the public
 * item (and `resultsStripped`) only when no persisted payload exists.
 */
export const inputItemToIr = (item: ResponseInputWebSearchCall): WebSearchCallIR | null => {
  if (item.action === undefined) return null;
  let action: ResponseWebSearchAction;
  if (item.action.type === 'search') {
    const queries = actionSearchQueries(item.action);
    // Emit both `query` and `queries`; see `actionSearchQueries`.
    action = {
      type: 'search',
      ...(queries.length > 0 ? { query: queries[0] } : {}),
      queries,
    };
  } else {
    action = item.action;
  }
  const id = item.id !== undefined && item.id.length > 0
    ? item.id
    : synthesizeWebSearchCallId();
  const hasResults = Array.isArray(item.results);
  return {
    id,
    status: 'completed',
    action,
    results: hasResults ? item.results! : [],
    ...(hasResults ? {} : { resultsStripped: true }),
  };
};

/**
 * IR → umbrella function_call + function_call_output pair sharing a
 * synthetic call_id derived from the IR id. Every replay path goes
 * through this helper so echoed history and internally produced
 * web_search_call items cannot diverge.
 */
export const irToUpstreamPair = (
  ir: WebSearchCallIR,
  umbrellaToolName: string,
): {
  functionCall: ResponseFunctionToolCallItem;
  functionCallOutput: ResponseFunctionCallOutputItem;
} => {
  const callId = `cc_from_${ir.id}`;
  return {
    functionCall: {
      type: 'function_call',
      call_id: callId,
      name: umbrellaToolName,
      arguments: actionToUmbrellaArgsJson(ir.action),
      status: 'completed',
    },
    functionCallOutput: {
      type: 'function_call_output',
      call_id: callId,
      output: irToOutputText(ir),
    },
  };
};

const actionToUmbrellaArgsJson = (action: ResponseWebSearchAction): string => {
  switch (action.type) {
  case 'search':
    return JSON.stringify({
      search_query: actionSearchQueries(action).map(q => ({ q })),
    });
  case 'open_page':
    // Echoed open_page items can arrive without `url` (native drops it
    // on soft failure); fall back to an empty string in the replayed
    // args so the upstream sees a well-formed `ref_id` field rather
    // than a literal `undefined` collapse.
    return JSON.stringify({ open: [{ ref_id: action.url ?? '' }] });
  case 'find_in_page':
    return JSON.stringify({ find: [{ ref_id: action.url, pattern: action.pattern }] });
  }
};

// Numeric `[N]` references in the snippet body let the model cite
// specific search hits in its final answer. Empty results emit
// `(no results)` rather than a bare header so the model recognizes the
// call ran successfully but returned nothing.
const formatSearchResultsText = (query: string, results: readonly ResponseWebSearchResult[]): string => {
  const header = `Search results for "${query}":`;
  if (results.length === 0) return `${header}\n\n(no results)`;
  const sections = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`);
  return `${header}\n\n${sections.join('\n\n')}`;
};

/**
 * IR rendered as a labeled text section the upstream model reads from
 * function_call_output. Format matches what model variants have seen
 * historically so model behaviour doesn't drift on the rewrite.
 */
export const irToOutputText = (ir: WebSearchCallIR): string => {
  if (ir.resultsStripped) return resultsStrippedText;
  switch (ir.action.type) {
  case 'search': {
    const queryLabel = actionSearchQueries(ir.action).join(' | ');
    return formatSearchResultsText(queryLabel, ir.results);
  }
  case 'open_page': {
    if (ir.results.length === 0) {
      const url = ir.action.url ?? '(no url)';
      return `Open ${url}: (no body returned)`;
    }
    return ir.results[0].snippet;
  }
  case 'find_in_page':
    return ir.results.length > 0 ? ir.results[0].snippet : '';
  }
};

// Echoed items without `action` become placeholder function_call /
// function_call_output pairs with the original wire item inlined so the
// model can inspect them; positional indices stay stable.
export const transformInputItemsForWebSearch = (
  input: ResponseInputItem[],
  umbrellaToolName: string,
): ResponseInputItem[] => {
  const out: ResponseInputItem[] = [];
  for (const item of input) {
    if (item.type === 'web_search_call') {
      const ir = inputItemToIr(item);
      if (ir === null) {
        const id = synthesizeWebSearchCallId();
        const callId = `cc_from_${id}_malformed`;
        out.push(
          {
            type: 'function_call',
            call_id: callId,
            name: umbrellaToolName,
            arguments: '{}',
            status: 'completed',
          },
          {
            type: 'function_call_output',
            call_id: callId,
            // Include the original wire item verbatim so the model
            // can see what was there — the placeholder shape stays
            // stable while the malformed payload reaches the LLM
            // for inspection.
            output: `A prior web_search_call item in the conversation history was malformed (no \`action\` field). Original wire item: ${JSON.stringify(item)}`,
          },
        );
        continue;
      }
      const { functionCall, functionCallOutput } = irToUpstreamPair(ir, umbrellaToolName);
      out.push(functionCall, functionCallOutput);
      continue;
    }
    out.push(item);
  }
  return out;
};

interface PageCacheEntry {
  content: string;
  truncated: boolean;
  fullContentBytes: number;
  title?: string;
}

export interface ShimState {
  filters: ShimToolFilters;
  // Per-request cache shared across `open` and `find` so a find op can
  // reuse a body the model already opened without a second fetch.
  pageCache: Map<string, PageCacheEntry>;
  // Memoized lazy resolver. The first backend dispatch pays the
  // load+resolve cost; later dispatches reuse the cached result.
  // Replay-only paths (echoed `web_search_call` input with no hosted
  // tool emission) never call this, so an unconfigured search provider
  // does not 500 the request.
  getProvider: () => Promise<ConfiguredWebSearchProvider>;
  // `undefined` for keyless requests (admin playground); usage
  // recording is skipped in that case.
  apiKeyId: string | undefined;
  // Set when the client passed
  // `include: ["web_search_call.action.sources"]` on the request,
  // mirroring native Responses' opt-in shape for the search-action
  // sources list. Native gates the field on this include token; the
  // shim follows suit so the wire shape matches.
  includeSearchActionSources: boolean;
  // Aborted when the downstream client disconnects. Threaded through
  // every backend provider call so a cancelled request stops
  // generating upstream load instead of running to completion.
  downstreamAbortSignal?: AbortSignal;
}

type FetchAndCacheResult =
  | { ok: true; cached: PageCacheEntry }
  | { ok: false; output: string };

// Suffix-match per Tavily and Microsoft Grounding search-side filter
// semantics: `example.com` matches `example.com`, `www.example.com`,
// and `sub.example.com`, but NOT `evil-example.com`.
const matchesAnyDomain = (hostname: string, domains: readonly string[]): boolean => {
  for (const d of domains) {
    if (hostname === d) return true;
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
};

export const isUrlAllowed = (url: string, filter: ShimToolFilters): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const blocked = normalizeDomainList(filter.blockedDomains);
  if (blocked.length > 0 && matchesAnyDomain(hostname, blocked)) {
    return false;
  }
  const allowed = normalizeDomainList(filter.allowedDomains);
  if (allowed.length > 0 && !matchesAnyDomain(hostname, allowed)) {
    return false;
  }
  return true;
};

// Literal case-insensitive substring matcher with context windows;
// mirrors gpt-oss `find` rendering minus the cursor-numbered output.
//   https://github.com/openai/gpt-oss/blob/285b05d96dea9ce7da52ecbbe86791f18239c510/gpt_oss/tools/simple_browser/simple_browser_tool.py

interface FindMatch {
  before: string;
  matched: string;
  after: string;
}

export const findMatches = (
  text: string,
  pattern: string,
  opts: { maxMatches: number; contextChars: number },
): FindMatch[] => {
  if (pattern.length === 0) return [];
  const lowerText = text.toLowerCase();
  const lowerPat = pattern.toLowerCase();
  const matches: FindMatch[] = [];
  let from = 0;
  while (matches.length < opts.maxMatches) {
    const idx = lowerText.indexOf(lowerPat, from);
    if (idx < 0) break;
    const beforeStart = Math.max(0, idx - opts.contextChars);
    const afterEnd = Math.min(text.length, idx + lowerPat.length + opts.contextChars);
    matches.push({
      before: text.slice(beforeStart, idx),
      matched: text.slice(idx, idx + lowerPat.length),
      after: text.slice(idx + lowerPat.length, afterEnd),
    });
    from = idx + lowerPat.length;
  }
  return matches;
};

export const formatMatches = (pattern: string, url: string, matches: readonly FindMatch[]): string => {
  if (matches.length === 0) return findNoMatchesText(pattern, url);
  const noun = matches.length === 1 ? 'match' : 'matches';
  const lines: string[] = [`${matches.length} ${noun} for pattern: \`${pattern}\``, ''];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    lines.push(`Match ${i + 1}:`);
    lines.push(`"...${m.before}[${m.matched}]${m.after}..."`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
};

const truncateString = (s: string, maxChars: number): string =>
  s.length <= maxChars ? s : `${truncatePreservingCodePoints(s, maxChars)}…`;

const errorSnippet = (title: string, snippet: string): ResponseWebSearchResult => ({
  type: 'text_result',
  url: '',
  title,
  snippet,
});

// Resolve the configured backend or return an `unavailable` reason.
// Disabled / missing-credential is per-op visible: each backend
// dispatch synthesizes a snippet IR so the model sees the error
// in-band instead of the whole request 5xx'ing.
const resolveActiveProvider = async (
  state: ShimState,
): Promise<{ provider: WebSearchProvider; providerName: WebSearchProviderName } | { unavailable: string }> => {
  const configured = await state.getProvider();
  if (configured.type === 'enabled') {
    return { provider: configured.impl, providerName: configured.provider };
  }
  if (configured.type === 'disabled') {
    return { unavailable: 'Web search provider is not configured on this gateway.' };
  }
  return { unavailable: `Web search provider ${configured.provider} is missing its credential on this gateway.` };
};

const runBackendSearch = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'search' }>,
  state: ShimState,
): Promise<WebSearchCallIR> => {
  const query = op.query;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(id, query, [errorSnippet(title, op.error)]);
  }

  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    return searchIr(id, query, [errorSnippet('Search error', searchFailedText(active.unavailable))]);
  }

  try {
    const searchRequest = {
      query,
      maxResults: state.filters.maxResults,
      allowedDomains: state.filters.allowedDomains,
      blockedDomains: state.filters.blockedDomains,
      userLocation: state.filters.userLocation,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = state.apiKeyId !== undefined
      ? await searchWebAndRecordUsage({
          provider: active.provider,
          providerName: active.providerName,
          keyId: state.apiKeyId,
          request: searchRequest,
        })
      : await searchWebWithoutRecordingUsage({
          provider: active.provider,
          request: searchRequest,
        });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      return searchIr(id, query, [errorSnippet('Search error', searchFailedText(msg))]);
    }

    // Per-snippet char cap on web_search_call.results[].snippet. Providers
    // like Tavily can return multi-KB snippets per hit; without this cap a
    // single noisy query can blow the upstream context window. Independent
    // of the provider-enforced 10 KiB cap on open_page bodies.
    const results: ResponseWebSearchResult[] = result.results.map(r => ({
      type: 'text_result' as const,
      url: r.source,
      title: r.title,
      snippet: truncateString(r.content.map(c => c.text).join('\n'), 2_048),
    }));
    // Native gates `action.sources` on `include:
    // ["web_search_call.action.sources"]`; build the list only when
    // the client opted in. The shape mirrors openai-python
    // `ActionSearch.sources[]` (`{type:'url', url}`).
    const sources = state.includeSearchActionSources
      ? result.results.map(r => ({ type: 'url' as const, url: r.source }))
      : undefined;
    return searchIr(id, query, results, sources);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return searchIr(id, query, [errorSnippet('Search error', searchFailedText(msg))]);
  }
};

const runBatchFetch = async (
  needFetch: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const perUrl = new Map<string, FetchAndCacheResult>();
  const active = await resolveActiveProvider(state);
  if ('unavailable' in active) {
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, active.unavailable) });
    }
    return perUrl;
  }
  try {
    const fetchRequest = {
      urls: needFetch,
      ...(state.downstreamAbortSignal !== undefined ? { signal: state.downstreamAbortSignal } : {}),
    };
    const result = state.apiKeyId !== undefined
      ? await fetchPageAndRecordUsage({
          provider: active.provider,
          providerName: active.providerName,
          keyId: state.apiKeyId,
          request: fetchRequest,
        })
      : await fetchPageWithoutRecordingUsage({
          provider: active.provider,
          request: fetchRequest,
        });

    if (result.type === 'error') {
      const msg = result.message ?? result.errorCode;
      for (const url of needFetch) {
        perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
      }
      return perUrl;
    }

    const failureByUrl = new Map(result.failures.map(f => [f.url, f]));
    const pageByUrl = new Map(result.pages.map(p => [p.url, p]));
    for (const url of needFetch) {
      const failure = failureByUrl.get(url);
      if (failure) {
        perUrl.set(url, { ok: false, output: openFailedText(url, failure.message ?? failure.errorCode) });
        continue;
      }
      const page = pageByUrl.get(url);
      if (!page) {
        // URL silently dropped by the provider — surface as explicit
        // error so the model doesn't see a phantom empty page.
        perUrl.set(url, { ok: false, output: openFailedText(url, 'No page returned') });
        continue;
      }
      const entry: PageCacheEntry = {
        content: page.content,
        truncated: page.truncated,
        fullContentBytes: page.fullContentBytes,
        title: page.title,
      };
      state.pageCache.set(url, entry);
      perUrl.set(url, { ok: true, cached: entry });
    }
    return perUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const url of needFetch) {
      perUrl.set(url, { ok: false, output: openFailedText(url, msg) });
    }
    return perUrl;
  }
};

// Intra-umbrella batching: collect every URL the umbrella's
// open[]/find[] sub-arrays reference, dedup, hit cache, and issue
// one batched provider.fetchPage for the remainder. Cross-umbrella
// joining is deliberately NOT done — same-turn serial execution
// means later umbrellas can simply read the populated cache.
const fetchAndCacheManyPages = async (
  urls: string[],
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  const results = new Map<string, FetchAndCacheResult>();
  const needFetch: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const cached = state.pageCache.get(url);
    if (cached) {
      results.set(url, { ok: true, cached });
      continue;
    }
    needFetch.push(url);
  }

  if (needFetch.length > 0) {
    const perUrl = await runBatchFetch(needFetch, state);
    for (const url of needFetch) {
      results.set(url, perUrl.get(url)!);
    }
  }
  return results;
};

const openPageSuccessIr = (id: string, url: string, cached: PageCacheEntry): WebSearchCallIR => {
  // Provider truncates to its 10 KiB per-page cap. Truncated bodies get
  // a sentinel so the model can choose to `find` for specific content.
  const body = cached.content
    + (cached.truncated ? `\n\n${truncationSentinel(cached.fullContentBytes)}` : '');
  return openPageIr(id, url, [{
    type: 'text_result',
    url,
    title: cached.title ?? '',
    snippet: body,
  }]);
};

const runBackendOpenPage = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'open' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;

  // Invalid-ref-id (`op.error !== undefined`) carries a
  // `{type:'search', queries:[ref_id]}` via `searchIr` because a urlless
  // open_page action would be meaningless.
  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return searchIr(id, op.url, [errorSnippet(title, op.error)]);
  }

  // Batch fetch pre-populates entries for every URL the parser produced
  // (blocked URLs get an explicit failure entry), so the lookup is total.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return openPageIr(id, url, [errorSnippet('Open page error', fetched.output)]);
  }
  return openPageSuccessIr(id, url, fetched.cached);
};

const runBackendFind = async (
  id: string,
  op: Extract<ShimLogicalOperation, { kind: 'find' }>,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  const url = op.url;
  const pattern = op.pattern;

  if (op.error !== undefined) {
    const title = op.errorKind === 'missing-arg' ? 'Missing argument' : 'Invalid ref_id';
    return findInPageIr(id, url, pattern, [errorSnippet(title, op.error)]);
  }

  // Pre-fetch failures keep the `find_in_page` action carrying the
  // original url + pattern; switching to `open_page` would silently
  // change `action.type` mid-result.
  const fetched = (await batchPromise).get(url)!;
  if (!fetched.ok) {
    return findInPageIr(id, url, pattern, [errorSnippet('Find error', fetched.output)]);
  }

  // Mirror gpt-oss `find` defaults.
  const matches = findMatches(fetched.cached.content, pattern, {
    maxMatches: 10,
    contextChars: 200,
  });
  // Native find_in_page returns one result whose snippet either lists
  // the matches or says "No matching ...".
  const title = matches.length === 0 ? 'No match' : 'Matches';
  return findInPageIr(id, url, pattern, [{
    type: 'text_result',
    url,
    title,
    snippet: formatMatches(pattern, url, matches),
  }]);
};

const executeOperation = (
  id: string,
  op: ShimLogicalOperation,
  state: ShimState,
  batchPromise: Promise<Map<string, FetchAndCacheResult>>,
): Promise<WebSearchCallIR> => {
  switch (op.kind) {
  case 'search':
    return runBackendSearch(id, op, state);
  case 'open':
    return runBackendOpenPage(id, op, batchPromise);
  case 'find':
    return runBackendFind(id, op, batchPromise);
  case 'unsupported':
    return Promise.resolve(schemaErrorIr(
      id,
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      unsupportedSubPropertyText(op.subProperty),
    ));
  case 'wrong-type':
    return Promise.resolve(schemaErrorIr(
      id,
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      wrongTypeSubPropertyText(op.subProperty, op.actualType),
    ));
  }
};

// Per-umbrella bypass: each parsed op resolves to a snippet IR
// carrying `snippetText` in the action shape closest to what the
// model asked for. Used for both the iteration-cap exhaustion and
// the `max_tool_calls` budget exhaustion.
//   https://github.com/tinfoilsh/confidential-model-router/blob/4ad5a7229fdd37f5d270b56a92dfb23a3fb2b562/toolruntime/chat_stream.go#L1014-L1019
const irForBypassedOp = (id: string, op: ShimLogicalOperation, snippetText: string): WebSearchCallIR => {
  switch (op.kind) {
  case 'search':
    return searchIr(id, op.query, [errorSnippet('Search error', snippetText)]);
  case 'open':
    if (op.error !== undefined) {
      return searchIr(id, op.url, [errorSnippet('Open page error', snippetText)]);
    }
    return openPageIr(id, op.url, [errorSnippet('Open page error', snippetText)]);
  case 'find':
    return findInPageIr(id, op.url, op.pattern, [errorSnippet('Find error', snippetText)]);
  case 'unsupported':
    return schemaErrorIr(
      id,
      `unsupported action: ${op.subProperty}[${op.arrayIndex}]`,
      'Unsupported action',
      snippetText,
    );
  case 'wrong-type':
    return schemaErrorIr(
      id,
      `wrong-type sub-property: ${op.subProperty}`,
      'Malformed sub-property',
      snippetText,
    );
  }
};

// Collect the open/find URL set for THIS umbrella and kick off one
// provider.fetchPage covering all of them. `fetchAndCacheManyPages`
// installs per-URL inflight slots synchronously so later umbrellas in
// the same turn dedup against this batch.
//
// Blocked URLs (failing `isUrlAllowed`) are filtered OUT of the batch
// fetch but populated into the result map with an explicit
// `{ ok: false, output: 'Error fetching URL <url>: Blocked by tool
// filters' }` entry (the `Blocked by tool filters` string runs
// through `openFailedText` for consistency with real fetch failures).
// That way the per-op handlers (`runBackendOpenPage` /
// `runBackendFind`) can trust the gate's verdict by reading the map
// directly instead of re-running `isUrlAllowed` themselves.
const BLOCKED_BY_FILTER_OUTPUT = 'Blocked by tool filters';

const startBatchFetchForUmbrella = async (
  parsed: ParsedUmbrella,
  state: ShimState,
): Promise<Map<string, FetchAndCacheResult>> => {
  if (parsed.kind !== 'ops') return new Map();
  const batchUrls: string[] = [];
  const blockedUrls: string[] = [];
  const seen = new Set<string>();
  for (const op of parsed.ops) {
    if (op.kind !== 'open' && op.kind !== 'find') continue;
    if (op.error !== undefined) continue;
    const url = op.url;
    if (url === '') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!isUrlAllowed(url, state.filters)) {
      blockedUrls.push(url);
      continue;
    }
    batchUrls.push(url);
  }
  const fetched = await fetchAndCacheManyPages(batchUrls, state);
  for (const url of blockedUrls) {
    fetched.set(url, { ok: false, output: openFailedText(url, BLOCKED_BY_FILTER_OUTPUT) });
  }
  return fetched;
};

const planUmbrellaSlots = (
  parsed: ParsedUmbrella,
  state: ShimState,
  loopState: ServerToolLoopState,
): { id: string; promise: Promise<WebSearchCallIR> }[] => {
  if (loopState.iterationCount > ITERATION_CAP) {
    if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
      const id = synthesizeWebSearchCallId();
      return [{
        id,
        promise: Promise.resolve(schemaErrorIr(id, 'malformed umbrella arguments', 'Tool call budget exhausted', iterationCapText)),
      }];
    }
    return parsed.ops.map(op => {
      const id = synthesizeWebSearchCallId();
      return { id, promise: Promise.resolve(irForBypassedOp(id, op, iterationCapText)) };
    });
  }

  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    const id = synthesizeWebSearchCallId();
    return [{
      id,
      promise: Promise.resolve(schemaErrorIr(id, 'malformed umbrella arguments', 'Malformed arguments', emptyUmbrellaArgsText)),
    }];
  }

  const batchPromise = startBatchFetchForUmbrella(parsed, state);

  return parsed.ops.map(op => {
    const id = synthesizeWebSearchCallId();
    return { id, promise: executeOperation(id, op, state, batchPromise) };
  });
};

export const webSearchServerTool: ServerToolRegistration = (ctx, request) => {
  if (ctx.targetApi === 'responses' && !ctx.enabledFlags.has('responses-web-search-shim')) {
    return { type: 'inactive' };
  }

  const tools = Array.isArray(ctx.payload.tools) ? ctx.payload.tools : [];
  const hasHostedWebSearch = tools.some(isHostedWebSearchTool);
  const hasReplayInput = Array.isArray(ctx.payload.input) && ctx.payload.input.some(i => i.type === 'web_search_call');
  if (!hasHostedWebSearch && !hasReplayInput) return { type: 'inactive' };

  const prepared = prepareToolsForShim(tools);
  if (!prepared.ok) {
    return {
      type: 'invalid-request',
      message: prepared.error.message,
      param: prepared.error.param,
    };
  }

  const rewritten = prepared.prepared;
  const includeArray = Array.isArray(ctx.payload.include) ? ctx.payload.include : [];
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const state: ShimState = {
    filters: rewritten.filters,
    pageCache: new Map(),
    getProvider: () => {
      configuredProvider ??= loadSearchConfig().then(cfg => resolveConfiguredWebSearchProvider(cfg));
      return configuredProvider;
    },
    apiKeyId: request.apiKeyId,
    includeSearchActionSources: includeArray.includes('web_search_call.action.sources'),
    ...(request.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: request.downstreamAbortSignal } : {}),
  };

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    transformItems: (items, toolName) => transformInputItemsForWebSearch(items, toolName),
    ...(hasHostedWebSearch
      ? {
          hosted: {
            isHostedTool: isHostedWebSearchTool,
            buildFunctionTool: toolName => buildUmbrellaTool(toolName, rewritten.filters.userLocation),
            dispatcher: ({ intercepted, loopState }) => {
              const planned = planUmbrellaSlots(parseUmbrellaOperations(intercepted.arguments), state, loopState);
              return planned.map(({ id, promise }) => serverToolResultSlot({
                id,
                startItem: { type: 'web_search_call', status: 'in_progress' },
                startEvents: [
                  { type: 'response.web_search_call.in_progress' },
                  { type: 'response.web_search_call.searching' },
                ],
                result: promise.then(ir => {
                  const item: ServerToolOutputItem & Omit<ResponseOutputWebSearchCall, 'id'> = { type: 'web_search_call', status: 'completed', action: ir.action, results: ir.results };
                  return {
                    item,
                    endEvents: [{ type: 'response.web_search_call.completed' }],
                  };
                }),
              }));
            },
          },
        }
      : {}),
  };
};
