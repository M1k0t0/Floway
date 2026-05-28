import { test } from 'vitest';

import { resolveServerToolName } from '../server-tool-shim.ts';
import {
  findInPageIr,
  findMatches,
  findNoMatchesText,
  formatMatches,
  inputItemToIr,
  irToOutputText,
  irToUpstreamPair,
  isHostedWebSearchTool,
  isUrlAllowed,
  iterationCapText,
  openFailedText,
  openPageIr,
  parseUmbrellaOperations,
  prepareToolsForShim,
  schemaErrorIr,
  searchFailedText,
  searchIr,
  SHIM_TOOL_NAME,
  synthesizeWebSearchCallId,
  truncationSentinel,
  WEB_SEARCH_HOSTED_TYPES,
  type ShimLogicalOperation,
  type WebSearchCallIR,
} from './web-search.ts';
import { assert, assertEquals, assertFalse } from '../../../../../../test-assert.ts';
import { truncatePreservingCodePoints } from '../../../../shared/text.ts';
import type { ResponseTool } from '@floway-dev/protocols/responses';

// ── Umbrella argument parsing (parseUmbrellaOperations) ──

const opsOf = (args: Record<string, unknown> | null): ShimLogicalOperation[] => {
  const parsed = parseUmbrellaOperations(args);
  assert(parsed.kind === 'ops');
  return parsed.ops;
};

test('parseUmbrellaOperations returns ops:[] for empty object', () => {
  assertEquals(parseUmbrellaOperations({}), { kind: 'ops', ops: [] });
});

test('parseUmbrellaOperations parses one search_query entry', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'hello' }] }),
    [{ kind: 'search', arrayIndex: 0, query: 'hello' }],
  );
});

test('parseUmbrellaOperations parses multiple search_query entries with stable arrayIndex', () => {
  assertEquals(
    opsOf({ search_query: [{ q: 'a' }, { q: 'b' }, { q: 'c' }] }),
    [
      { kind: 'search', arrayIndex: 0, query: 'a' },
      { kind: 'search', arrayIndex: 1, query: 'b' },
      { kind: 'search', arrayIndex: 2, query: 'c' },
    ],
  );
});

test('parseUmbrellaOperations parses open entry with URL ref_id', () => {
  assertEquals(
    opsOf({ open: [{ ref_id: 'https://example.com' }] }),
    [{ kind: 'open', arrayIndex: 0, url: 'https://example.com' }],
  );
});

test('parseUmbrellaOperations parses find entry with URL ref_id and pattern', () => {
  assertEquals(
    opsOf({ find: [{ ref_id: 'https://example.com', pattern: 'needle' }] }),
    [{ kind: 'find', arrayIndex: 0, url: 'https://example.com', pattern: 'needle' }],
  );
});

test('parseUmbrellaOperations: non-URL open ref_id produces an error sentinel', () => {
  const ops = opsOf({ open: [{ ref_id: 'opaque-prior-id' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, 'opaque-prior-id');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.startsWith('Error: ref_id must be a fully-qualified URL'), true);
  assertEquals(err!.includes('opaque-prior-id'), true);
});

test('parseUmbrellaOperations: non-URL find ref_id produces an error sentinel', () => {
  const ops = opsOf({ find: [{ ref_id: 'cursor-123', pattern: 'p' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { url: string }).url, 'cursor-123');
  assertEquals((op as { pattern: string }).pattern, 'p');
  const err = (op as { error?: string }).error;
  assertEquals(typeof err, 'string');
  assertEquals(err!.includes('cursor-123'), true);
});

test('parseUmbrellaOperations: multi-action batched call returns all ops in order search→open→find', () => {
  const ops = opsOf({
    search_query: [{ q: 'a' }],
    open: [{ ref_id: 'https://x' }],
    find: [{ ref_id: 'https://y', pattern: 'p' }],
  });
  assertEquals(ops.map(o => o.kind), ['search', 'open', 'find']);
});

test('parseUmbrellaOperations: unsupported sub-properties surface one unsupported op per entry', () => {
  const ops = opsOf({
    click: [{ ref_id: 'https://x', id: 1 }],
    screenshot: [{ ref_id: 'https://x', pageno: 1 }, { ref_id: 'https://y', pageno: 2 }],
    weather: [{ location: 'NYC' }],
    response_length: 'short',
    search_query: [{ q: 'real' }],
  });
  assertEquals(ops.length, 6);
  assertEquals(ops[0], { kind: 'search', arrayIndex: 0, query: 'real' });
  assertEquals(ops[1], { kind: 'unsupported', subProperty: 'click', arrayIndex: 0 });
  assertEquals(ops[2], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 0 });
  assertEquals(ops[3], { kind: 'unsupported', subProperty: 'screenshot', arrayIndex: 1 });
  assertEquals(ops[4], { kind: 'unsupported', subProperty: 'weather', arrayIndex: 0 });
  assertEquals(ops[5], { kind: 'unsupported', subProperty: 'response_length', arrayIndex: 0 });
});

test('parseUmbrellaOperations: missing q on search_query entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ search_query: [{}] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'search');
  assertEquals((op as { query: string }).query, '');
  assertEquals(typeof (op as { error?: string }).error, 'string');
  assert((op as { error: string }).error.includes('"q"'));
});

test('parseUmbrellaOperations: missing ref_id on open entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ open: [{}] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'open');
  assertEquals((op as { url: string }).url, '');
  assert((op as { error: string }).error.includes('"ref_id"'));
});

test('parseUmbrellaOperations: missing pattern on find entry surfaces a missing-argument error sentinel', () => {
  const ops = opsOf({ find: [{ ref_id: 'https://x' }] });
  assertEquals(ops.length, 1);
  const op = ops[0];
  assertEquals(op.kind, 'find');
  assertEquals((op as { pattern: string }).pattern, '');
  assert((op as { error: string }).error.includes('"pattern"'));
});

test('parseUmbrellaOperations: array values for non-array shape are skipped', () => {
  assertEquals(opsOf({ search_query: 'oops' }), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'string' },
  ]);
});

test('parseUmbrellaOperations: supported key with non-array value surfaces a wrong-type op (search_query)', () => {
  // A model that populates `search_query: {"q":"x"}` (or any
  // non-array) used to be silently dropped because the array guard
  // skipped it. Surface as a model-visible `wrong-type` op so the
  // model learns the call was malformed instead of seeing a phantom
  // success.
  assertEquals(opsOf({ search_query: { q: 'x' } }), [
    { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' },
  ]);
});

test('parseUmbrellaOperations: wrong-typed supported key does not block other supported keys from executing', () => {
  const ops = opsOf({ search_query: { q: 'x' }, open: [{ ref_id: 'https://y' }] });
  assertEquals(ops.length, 2);
  assertEquals(ops[0], { kind: 'wrong-type', subProperty: 'search_query', actualType: 'object' });
  assertEquals(ops[1], { kind: 'open', arrayIndex: 0, url: 'https://y' });
});

test('parseUmbrellaOperations: wrong-typed open / find surface as wrong-type ops', () => {
  assertEquals(opsOf({ open: 'https://x' }), [
    { kind: 'wrong-type', subProperty: 'open', actualType: 'string' },
  ]);
  assertEquals(opsOf({ find: null }), [
    { kind: 'wrong-type', subProperty: 'find', actualType: 'null' },
  ]);
});

// ── IR builders and replay (searchIr / inputItemToIr / irToUpstreamPair …) ──

const FIXED_ID = 'ws_test_fixed_0123456789abcdef';

const fixedIr = (overrides: Partial<WebSearchCallIR> = {}): WebSearchCallIR => ({
  id: FIXED_ID,
  status: 'completed',
  action: { type: 'search', queries: ['hello'] },
  results: [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'snip' }],
  ...overrides,
});

test('synthesizeWebSearchCallId produces unique ws_gw_ prefixed ids', () => {
  const a = synthesizeWebSearchCallId();
  const b = synthesizeWebSearchCallId();
  assert(a.startsWith('ws_gw_'));
  assert(b.startsWith('ws_gw_'));
  assert(a !== b);
});

test('searchIr places query in action.queries and uses status=completed', () => {
  const ir = searchIr(FIXED_ID, 'hello world', []);
  assertEquals(ir.status, 'completed');
  assertEquals(ir.id, FIXED_ID);
  // Both `query` (singular, required by openai-python ActionSearch)
  // and `queries` (plural, newer codex) are populated so every typed
  // SDK reads the value regardless of which field its model declares.
  assertEquals(ir.action, { type: 'search', query: 'hello world', queries: ['hello world'] });
  assertEquals(ir.results, []);
});

test('openPageIr with url preserves it on the action', () => {
  const ir = openPageIr(FIXED_ID, 'https://example.com', []);
  assertEquals(ir.action, { type: 'open_page', url: 'https://example.com' });
});

test('openPageIr with undefined url omits the field from the action (matches native soft-failure shape)', () => {
  const ir = openPageIr(FIXED_ID, undefined, [{ type: 'text_result', url: '', title: 'Error', snippet: 'fetch failed' }]);
  assertEquals(ir.action, { type: 'open_page' });
  assertEquals(ir.results.length, 1);
});

test('findInPageIr keeps url and pattern on the action', () => {
  const ir = findInPageIr(FIXED_ID, 'https://x', 'p', []);
  assertEquals(ir.action, { type: 'find_in_page', url: 'https://x', pattern: 'p' });
});

test('schemaErrorIr uses action.type=search with descriptive queries entry', () => {
  const ir = schemaErrorIr(FIXED_ID, 'unsupported action: click[0]', 'Unsupported action', 'Error: this gateway does not support `click`.');
  // Both `query` and `queries` set so openai-python-style SDKs reading
  // the singular `query` field don't see undefined for the diagnostic.
  assertEquals(ir.action, { type: 'search', query: 'unsupported action: click[0]', queries: ['unsupported action: click[0]'] });
  assertEquals(ir.results.length, 1);
  assertEquals(ir.results[0].snippet, 'Error: this gateway does not support `click`.');
  assertEquals(ir.results[0].title, 'Unsupported action');
});

test('schemaErrorIr accepts a custom title (Case 5 malformed args uses "Malformed arguments")', () => {
  const ir = schemaErrorIr(FIXED_ID, 'malformed umbrella arguments', 'Malformed arguments', 'Error: arguments must be a JSON object.');
  assertEquals(ir.results[0].title, 'Malformed arguments');
  assertEquals(ir.results[0].snippet, 'Error: arguments must be a JSON object.');
});

test('inputItemToIr passes through a well-formed input item verbatim', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_input_abc',
    status: 'completed',
    action: { type: 'open_page', url: 'https://y' },
    results: [{ type: 'text_result', url: 'https://y', title: 'Y', snippet: 'body' }],
  });
  assert(ir !== null);
  assertEquals(ir.id, 'ws_input_abc');
  assertEquals(ir.action, { type: 'open_page', url: 'https://y' });
  assertEquals(ir.results.length, 1);
});

test('inputItemToIr returns null for items lacking an action (no neutral fabrication)', () => {
  const ir = inputItemToIr({ type: 'web_search_call' });
  assertEquals(ir, null);
});

test('inputItemToIr synthesizes a fresh id when the echoed item dropped it (clients like codex CLI strip ws_gw_ ids on session persist)', () => {
  const irMissing = inputItemToIr({
    type: 'web_search_call',
    action: { type: 'search', queries: ['q'] },
  });
  assert(irMissing !== null);
  assertEquals(irMissing.id.startsWith('ws_gw_'), true);
  const irEmpty = inputItemToIr({
    type: 'web_search_call',
    id: '',
    action: { type: 'search', queries: ['q'] },
  });
  assert(irEmpty !== null);
  assertEquals(irEmpty.id.startsWith('ws_gw_'), true);
});

test('inputItemToIr marks resultsStripped when the echoed item has no results field', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_kept',
    action: { type: 'search', queries: ['q'] },
  });
  assert(ir !== null);
  assertEquals(ir.resultsStripped, true);
  assertEquals(ir.results, []);
});

test('inputItemToIr leaves resultsStripped unset when results is an empty array (zero-hit search, not stripped)', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_kept',
    action: { type: 'search', queries: ['q'] },
    results: [],
  });
  assert(ir !== null);
  assertEquals(ir.resultsStripped, undefined);
});

test('inputItemToIr clamps status to completed regardless of source value', () => {
  const ir = inputItemToIr({
    type: 'web_search_call',
    id: 'ws_abc',
    status: 'failed',
    action: { type: 'search', queries: ['q'] },
  });
  assert(ir !== null);
  assertEquals(ir.status, 'completed');
});

test('irToUpstreamPair derives a stable call_id from the IR id and shares it on both items', () => {
  const ir = fixedIr({ id: 'ws_x' });
  const pair = irToUpstreamPair(ir, 'web_search');
  assertEquals(pair.functionCall.call_id, pair.functionCallOutput.call_id);
  assertEquals(pair.functionCall.call_id, 'cc_from_ws_x');
  assertEquals(pair.functionCall.name, 'web_search');
  assertEquals(pair.functionCall.arguments, JSON.stringify({ search_query: [{ q: 'hello' }] }));
});

test('irToUpstreamPair uses the umbrella tool name passed in (collision-fallback aware)', () => {
  const ir = fixedIr();
  const pair = irToUpstreamPair(ir, 'web_search_2');
  assertEquals(pair.functionCall.name, 'web_search_2');
});

test('irToOutputText for search action uses formatSearchResults shape (Search results for X then numbered hits)', () => {
  const ir = searchIr(FIXED_ID, 'hello', [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'body' }]);
  const text = irToOutputText(ir);
  assert(text.startsWith('Search results for "hello":'));
  assert(text.includes('[1] X'));
  assert(text.includes('https://x'));
  assert(text.includes('body'));
});

test('irToOutputText for open_page action uses the result snippet (page body) as the text', () => {
  const ir = openPageIr(FIXED_ID, 'https://y', [{ type: 'text_result', url: 'https://y', title: 'Y', snippet: 'page body here' }]);
  const text = irToOutputText(ir);
  assertEquals(text, 'page body here');
});

test('irToOutputText for find_in_page action uses the result snippet (formatMatches output) verbatim', () => {
  const ir = findInPageIr(FIXED_ID, 'https://x', 'needle', [{ type: 'text_result', url: '', title: 'No match', snippet: 'No matching `needle` found on https://x.' }]);
  const text = irToOutputText(ir);
  assertEquals(text, 'No matching `needle` found on https://x.');
});

test('irToOutputText for an open_page failure (no results) emits a "(no body returned)" sentinel', () => {
  const ir = openPageIr(FIXED_ID, undefined, []);
  const text = irToOutputText(ir);
  assertEquals(text, 'Open (no url): (no body returned)');
});

test('searchFailedText formats provider message', () => {
  assertEquals(searchFailedText('rate limited'), 'Search failed: rate limited');
});

test('openFailedText formats URL and provider message', () => {
  assertEquals(openFailedText('https://x.com', '404'), 'Error fetching URL `https://x.com`: 404');
});

test('openFailedText handles the blocked-by-filter sentinel uniformly', () => {
  assertEquals(
    openFailedText('https://x.com', 'Blocked by tool filters'),
    'Error fetching URL `https://x.com`: Blocked by tool filters',
  );
});

test('findNoMatchesText includes URL and uses "No matching ..." wording (mirrors native find_in_page no-match snippet)', () => {
  assertEquals(findNoMatchesText('foo bar', 'https://x.com'), 'No matching `foo bar` found on https://x.com.');
});

test('iterationCapText is the exact text fed back to the model on cap-exceeded turns', () => {
  assertEquals(
    iterationCapText,
    'Web search iteration limit (30) reached. Further web_search calls in this response will return this same error. Summarize what you have already learned, and continue the task using other available tools (shell, file inspection, prior knowledge) or directly answer based on what you\'ve gathered.',
  );
});

test('truncationSentinel formats full-page byte count', () => {
  assertEquals(
    truncationSentinel(50_000),
    '[Content truncated; full page is 50000 bytes. Use web_search\'s `find` sub-property with a pattern to locate specific content.]',
  );
});

test('truncationSentinel handles zero bytes', () => {
  assertEquals(
    truncationSentinel(0),
    '[Content truncated; full page is 0 bytes. Use web_search\'s `find` sub-property with a pattern to locate specific content.]',
  );
});

// ── truncatePreservingCodePoints boundary cases ───────────────────────

test('truncatePreservingCodePoints: empty string is a no-op', () => {
  assertEquals(truncatePreservingCodePoints('', 512), '');
});

test('truncatePreservingCodePoints: string of exactly `max` length is unchanged (no ellipsis injected)', () => {
  const s = 'a'.repeat(512);
  assertEquals(truncatePreservingCodePoints(s, 512), s);
});

test('truncatePreservingCodePoints: high surrogate at position max-1 walks back to drop the orphan', () => {
  // U+1F600 (grinning face) is a surrogate pair: high D83D + low DE00.
  // Place the high surrogate at index max-1 (= 9) so a naive
  // slice(0, max) would retain the orphan high surrogate. The helper
  // must walk back one code unit and slice at max-1 (= 9), producing
  // a 9-char string with no orphan.
  const prefix = 'a'.repeat(9); // chars 0..8
  const emoji = '😀'; // chars 9..10 → high at 9, low at 10
  const suffix = 'b';
  const input = prefix + emoji + suffix; // length 12
  const out = truncatePreservingCodePoints(input, 10);
  assertEquals(out.length, 9);
  assertEquals(out, prefix);
  // Sanity: no orphan high surrogate in the output.
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i);
    assertFalse(code >= 0xD800 && code <= 0xDBFF);
  }
});

// Search-result text rendering is exercised through `irToOutputText`
// because the formatter is a private helper inside ir.ts. These tests
// verify the wire shape clients depend on.

test('irToOutputText (search) empty results renders header + (no results)', () => {
  assertEquals(
    irToOutputText(searchIr(FIXED_ID, 'deepseek', [])),
    'Search results for "deepseek":\n\n(no results)',
  );
});

test('irToOutputText (search) single result rendered with index 1', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'deepseek', [
    { type: 'text_result', url: 'https://deepseek.ai', title: 'DeepSeek', snippet: 'AI company.' },
  ]));
  assertEquals(
    out,
    'Search results for "deepseek":\n\n[1] DeepSeek\nhttps://deepseek.ai\nAI company.',
  );
});

test('irToOutputText (search) three results separated by blank lines', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'llms', [
    { type: 'text_result', url: 'https://a.com', title: 'A', snippet: 'sa' },
    { type: 'text_result', url: 'https://b.com', title: 'B', snippet: 'sb' },
    { type: 'text_result', url: 'https://c.com', title: 'C', snippet: 'sc' },
  ]));
  assertEquals(
    out,
    'Search results for "llms":\n\n[1] A\nhttps://a.com\nsa\n\n[2] B\nhttps://b.com\nsb\n\n[3] C\nhttps://c.com\nsc',
  );
});

test('irToOutputText (search) query is interpolated verbatim into the header', () => {
  const out = irToOutputText(searchIr(FIXED_ID, 'quotes "inside" the query', []));
  assertEquals(out.startsWith('Search results for "quotes "inside" the query":'), true);
});

// ── Backend dispatch helpers (isUrlAllowed / findMatches / formatMatches) ──

test('isUrlAllowed returns true when no filters set', () => {
  assertEquals(isUrlAllowed('https://example.com', {}), true);
});

test('isUrlAllowed allowed_domains: exact host match passes', () => {
  assertEquals(isUrlAllowed('https://example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: subdomain suffix-matches', () => {
  assertEquals(isUrlAllowed('https://www.example.com/page', { allowedDomains: ['example.com'] }), true);
  assertEquals(isUrlAllowed('https://sub.example.com/page', { allowedDomains: ['example.com'] }), true);
});

test('isUrlAllowed allowed_domains: unrelated host is blocked', () => {
  assertEquals(isUrlAllowed('https://other.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: exact match is blocked', () => {
  assertEquals(isUrlAllowed('https://example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains: subdomain is blocked', () => {
  assertEquals(isUrlAllowed('https://www.example.com', { blockedDomains: ['example.com'] }), false);
});

test('isUrlAllowed blocked_domains takes precedence over allowed_domains', () => {
  assertEquals(
    isUrlAllowed('https://example.com', { allowedDomains: ['example.com'], blockedDomains: ['example.com'] }),
    false,
  );
});

test('isUrlAllowed invalid URL is blocked defensively', () => {
  assertEquals(isUrlAllowed('not-a-url', { allowedDomains: ['x.com'] }), false);
});

test('isUrlAllowed non-suffix substring match does NOT pass', () => {
  assertEquals(isUrlAllowed('https://evil-example.com', { allowedDomains: ['example.com'] }), false);
});

test('isUrlAllowed empty allowedDomains list behaves like no filter', () => {
  assertEquals(isUrlAllowed('https://example.com', { allowedDomains: [] }), true);
});

test('findMatches: case-insensitive substring matching', () => {
  const m = findMatches('Hello WORLD hello world HELLO', 'hello', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 3);
  assertEquals(m[0].matched, 'Hello');
  assertEquals(m[1].matched, 'hello');
  assertEquals(m[2].matched, 'HELLO');
});

test('findMatches: respects maxMatches cap', () => {
  const text = 'foo '.repeat(20);
  assertEquals(findMatches(text, 'foo', { maxMatches: 5, contextChars: 5 }).length, 5);
});

test('findMatches: empty array on no match', () => {
  assertEquals(findMatches('hello', 'xyz', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: empty pattern returns empty array', () => {
  assertEquals(findMatches('hello', '', { maxMatches: 10, contextChars: 5 }), []);
});

test('findMatches: contextChars trims around the match', () => {
  const m = findMatches('AAAAAAAAAAneedleBBBBBBBBBB', 'needle', { maxMatches: 10, contextChars: 5 });
  assertEquals(m.length, 1);
  assertEquals(m[0].before, 'AAAAA');
  assertEquals(m[0].matched, 'needle');
  assertEquals(m[0].after, 'BBBBB');
});

test('findMatches: pattern at string boundaries', () => {
  const m = findMatches('needleXXXX', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, '');
  assertEquals(m[0].after, 'XXXX');
});

test('findMatches: pattern at end of string', () => {
  const m = findMatches('XXXXneedle', 'needle', { maxMatches: 1, contextChars: 5 });
  assertEquals(m[0].before, 'XXXX');
  assertEquals(m[0].after, '');
});

test('findMatches: overlapping matches not double-counted (search resumes past match)', () => {
  const m = findMatches('aaaa', 'aa', { maxMatches: 10, contextChars: 0 });
  assertEquals(m.length, 2);
});

test('formatMatches: renders header + numbered matches with brackets', () => {
  const out = formatMatches('cat', 'https://x', [{ before: 'a ', matched: 'cat', after: ' on mat' }]);
  assertEquals(out.includes('1 match for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('"...a [cat] on mat..."'), true);
});

test('formatMatches: empty matches returns no-matches phrase including URL', () => {
  assertEquals(formatMatches('cat', 'https://x', []), 'No matching `cat` found on https://x.');
});

test('formatMatches: multi-match output uses Match N: headers', () => {
  const out = formatMatches('cat', 'https://x', [
    { before: 'a ', matched: 'cat', after: ' b' },
    { before: 'c ', matched: 'cat', after: ' d' },
  ]);
  assertEquals(out.includes('2 matches for pattern: `cat`'), true);
  assertEquals(out.includes('Match 1:'), true);
  assertEquals(out.includes('Match 2:'), true);
});

// ── Tool detection, filter prep, and name resolution ──

const UMBRELLA = SHIM_TOOL_NAME;
const hostedVariants = ['web_search', 'web_search_2025_08_26', 'web_search_preview', 'web_search_preview_2025_03_11'] as const;

const prepare = (tools: ResponseTool[]) => {
  const result = prepareToolsForShim(tools);
  assert(result.ok);
  return result.prepared;
};

test('isHostedWebSearchTool recognizes every hosted variant', () => {
  assertEquals([...WEB_SEARCH_HOSTED_TYPES].sort(), [...hostedVariants].sort());
  for (const type of hostedVariants) assertEquals(isHostedWebSearchTool({ type } as ResponseTool), true);
  assertEquals(isHostedWebSearchTool({ type: 'function', name: 'x', parameters: {}, strict: false }), false);
  assertEquals(isHostedWebSearchTool({ type: 'custom', name: 'x' }), false);
});

for (const type of hostedVariants) {
  test(`prepareToolsForShim accepts ${type} and extracts default filters`, () => {
    assertEquals(prepare([{ type } as ResponseTool]).filters, { maxResults: 20 });
  });
}

test('prepareToolsForShim extracts filters, user_location, and context size', () => {
  const { filters } = prepare([{
    type: 'web_search',
    filters: { allowed_domains: ['a.com'], blocked_domains: ['b.com'] },
    user_location: { country: 'JP', city: 'Tokyo' },
    search_context_size: 'high',
  } as ResponseTool]);
  assertEquals(filters.allowedDomains, ['a.com']);
  assertEquals(filters.blockedDomains, ['b.com']);
  assertEquals(filters.userLocation, { country: 'JP', city: 'Tokyo' });
  assertEquals(filters.maxResults, 40);
});

test('prepareToolsForShim passes through with empty filters when no hosted web_search exists', () => {
  const fn: ResponseTool = { type: 'function', name: 'foo', parameters: {}, strict: false };
  assertEquals(prepare([fn]).filters, {});
});

test('resolveServerToolName returns the first free sequential name', () => {
  assertEquals(resolveServerToolName(UMBRELLA, []), UMBRELLA);
  assertEquals(resolveServerToolName(UMBRELLA, [{ type: 'function', name: UMBRELLA, parameters: {}, strict: false }]), `${UMBRELLA}_2`);
  assertEquals(resolveServerToolName(UMBRELLA, [
    { type: 'function', name: UMBRELLA, parameters: {}, strict: false },
    { type: 'custom', name: `${UMBRELLA}_2` },
  ]), `${UMBRELLA}_3`);
});

test('prepareToolsForShim rejects invalid hosted fields', () => {
  const result = prepareToolsForShim([{ type: 'web_search', search_context_size: 'huge' } as unknown as ResponseTool]);
  assertEquals(result.ok, false);
});
