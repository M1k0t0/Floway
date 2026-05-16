# AGENTS.md

## Prime Directive

If you are an AI agent asked to open a Pull Request for this repository, you
must get explicit approval from a real human first. The human must confirm that
they:

1. Understand the goal and risks of the change.
2. Have read every line of AI-generated code, plus the PR title and description.
3. Believe the code, docs, and tests are internally consistent and meet the
   project bar.

AI-generated contributions are welcome. Unreviewed AI-generated Pull Requests
are not.

## Project Snapshot

`copilot-gateway` is a GitHub Copilot API proxy. It exposes standard Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, and Google Gemini
interfaces on top of Copilot upstream APIs so tools like Claude Code, Codex CLI,
and Gemini-compatible clients can use a Copilot subscription.

Runtime stack:

- Cloudflare Workers
- Hono + Web APIs
- D1 for persistence
- `deno test` for tests

## Architecture

High-level layering:

```text
HTTP routes
  -> app/service logic
  -> repo interfaces
  -> D1 implementation
```

Important files:

- `entry-cloudflare.ts`: Workers entrypoint, env + repo initialization.
- `src/app.ts`: Hono app wiring, middleware, route registration.
- `src/lib/env.ts`: pluggable env access.
- `src/repo/types.ts`: repo interfaces.
- `src/repo/d1.ts`: D1-backed repo.
- `src/repo/memory.ts`: in-memory repo for tests.

Global caches:

- `src/lib/copilot.ts`: Copilot token cache, L1 in-process + L2 repo-backed.
- `src/lib/models-cache.ts`: model capability cache, L1 in-process + L2
  repo-backed.

### Control Plane vs Data Plane

Control plane:

- `/auth/*`
- `/api/*`
- `/dashboard`

Data plane:

- `/v1/messages`
- `/v1/responses`
- `/v1/chat/completions`
- `/v1/embeddings`
- `/v1/models`
- `/v1/messages/count_tokens`
- `/v1beta/models`
- `/v1beta/models/*`

Translation, stream handling, and Copilot workarounds belong to the data plane
only.

### Data Plane Shape

The data plane is organized under `src/data-plane/` by endpoint and tool
capability first:

- `src/data-plane/llm/`: Messages, Responses, Chat Completions, and Gemini LLM
  routing
- `src/data-plane/gemini/`: Gemini model-listing and token-count endpoint
  capabilities
- `src/data-plane/models/`: models endpoint capability
- `src/data-plane/embeddings/`: embeddings endpoint capability
- `src/data-plane/tools/`: data-plane tool capabilities such as web search
- `src/data-plane/shared/`: shared data-plane infrastructure outside the LLM
  routing graph

The LLM subtree is role-organized:

- `src/data-plane/llm/sources/`
- `src/data-plane/llm/targets/`
- `src/data-plane/llm/translate/`
- `src/data-plane/llm/shared/`

`sources`, `targets`, and `translate` under `src/data-plane/llm/` are only for
Messages, Responses, Chat Completions, and Gemini LLM generation routing. Do not
place `models`, `embeddings`, data-plane tools, Gemini model listing, or Gemini
count-tokens endpoint code inside that LLM routing graph.

`src/app.ts` mounts `mountControlPlane` and `mountDataPlane`. The data-plane
route inventory is owned by `src/data-plane/routes.ts`, and the four LLM source
entries are mounted by `src/data-plane/llm/routes.ts`:

- `serveMessages`
- `serveResponses`
- `serveChatCompletions`
- `serveGeminiPost`

Each source API has one unique entry:

- `serveMessages`
- `serveResponses`
- `serveChatCompletions`
- `serveGemini`

Each source entry follows the same pipeline:

```text
serve
  -> source interceptors wrap:
       resolve model
         -> account fallback (per attempt:
              plan
                -> build target request
                -> emit (target interceptors wrap upstream attempt)
                -> translate events to source shape)
  -> respond
```

Use these terms. Do not invent a second vocabulary for the same pipeline.

The successful response path is unified as source-shaped event streams after
`emit`. That internal contract is event-first, not raw SSE-text-only.

Each upstream target endpoint also has one unique emitter:

- `emitToMessages`
- `emitToResponses`
- `emitToChatCompletions`

All target-specific request fixes, response fixes, and retry/workaround logic
for the same upstream endpoint should be centralized in that target subtree.

Boundary-owned workarounds are interceptor-driven:

- target emit interceptors live under
  `src/data-plane/llm/targets/<target>/interceptors/`
- source pipeline interceptors live under
  `src/data-plane/llm/sources/<source>/interceptors/`
- each such directory owns one `index.ts` registration array; change that array
  when adding, removing, or reordering interceptors

Keep the main `emit.ts` and `respond.ts` flows stable. Workaround churn should
mostly stay inside interceptor files and their registration arrays.

Source and target interceptors share the same `(ctx, run) => result` shape but
wrap different scopes:

- source interceptors wrap the entire source pipeline (model resolution +
  account fallback + emit + translate). They may mutate `ctx.payload` before
  `run()`, inspect or transform the awaited source-shaped result, carry state
  across both halves, or retry the whole pipeline. They run once per request,
  not per fallback attempt — so a source interceptor cannot see per-account
  state.
- target interceptors wrap a single upstream attempt inside `emit`. They may
  patch the per-attempt request, inspect upstream errors, retry that attempt,
  and patch event results. Per-account state belongs here.

### Pairwise Translation Rule

Do not introduce a canonical internal IR for requests.

- Request translation stays direct and pairwise.
- Response handling is event-first.
- Non-stream client responses should be assembled from source-shaped event
  streams whenever practical.
- See `TRANSLATION.md` for per-path field mapping, known losses, and boundary
  rules.

### Contract Stability

Public data-plane compatibility APIs are stable external contracts.

Control-plane API endpoints and schemas are dashboard-owned. They need to stay
consistent with the frontend, tests, and auth policy, but they are not external
compatibility APIs unless explicitly documented as such.

Data-plane tool management endpoints and schemas are UI-owned. They need to stay
consistent with the frontend or management code that uses them.

## Authentication and Authorization

There are two roles:

- `admin`: authenticated by `ADMIN_KEY`
- API key user: authenticated by an API key created by admin

Rules that matter most:

- `GET /api/keys`: admin sees all keys; API key user sees only their own key.
- Mutating key APIs are admin-only.
- `GET /api/token-usage` is intentionally visible to any authenticated user.
- GitHub account management, Copilot quota, export, and import are admin-only.

## Route Inventory

All OpenAI-compatible routes are exposed at both `/v1/...` and `/...`.

Primary proxy routes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /v1/embeddings`

Gemini-compatible routes:

- `GET /v1beta/models`
- `GET /v1beta/models/:model`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`
- `POST /v1beta/models/:model:countTokens`

## Data Plane Routing Rules

`/v1/messages` chooses among:

1. Native `/v1/messages`
2. Translated `/responses`
3. Translated `/chat/completions`

If native `/v1/messages` is unavailable, `/responses` is preferred whenever the
model supports it.

`/v1/responses` chooses among:

1. Native `/responses`
2. Translated `/v1/messages`
3. Translated `/chat/completions`

`/v1/chat/completions` chooses among:

1. Translated `/v1/messages`
2. Native `/chat/completions`
3. Translated `/responses`

If no capability-backed target is available, `/v1/chat/completions` keeps its
legacy model-name fallback: `claude*` models route through `/v1/messages`, and
other models route through native `/chat/completions`.

`/v1beta/models/:model:generateContent` and
`/v1beta/models/:model:streamGenerateContent` use the same target preference as
the Chat Completions source:

1. Translated `/v1/messages`
2. Translated `/chat/completions`
3. Translated `/responses`

If no capability-backed target is available, Gemini keeps the same legacy
model-name fallback as Chat Completions: `claude*` models route through
`/v1/messages`, and other models route through native `/chat/completions`.

Planning is the only layer allowed to make this routing decision.

Claude compatibility model-name routing happens before account fallback in
`src/data-plane/llm/shared/models/resolve-model.ts`. The resolver strips Claude
date aliases, normalizes dashed version aliases to Copilot's dotted upstream
IDs, and may choose a real upstream variant such as `-1m` or `-xhigh` from
`/models` and request intent. It returns one final upstream model ID; account
fallback then uses that ID for eligibility, backoff, and attempts without
re-resolving it. The gateway treats a model ID as a global upstream contract: if
multiple accounts expose the same ID, their capability metadata is expected to
describe the same model. Account differences are visibility/backoff concerns,
not per-account capability variants for the same ID.

## Data Plane Workarounds

Keep workarounds in the layer that owns the boundary where they apply.

Current placement:

- `src/data-plane/llm/shared/models/resolve-model.ts`
  - resolve Claude compatibility aliases and variants before account fallback
  - keep account fallback model-fixed after one final upstream ID is selected
- `src/data-plane/llm/sources/messages/interceptors/`
  - rewrite native Anthropic `web_search_*` server tools into a
    gateway-executed shim that runs once at the source layer, so every
    Messages routing path (native messages, via responses, via
    chat-completions) sees the same gateway-executed search behavior
  - replay shim-owned search history back upstream as `search_result` blocks
  - rewrite upstream tool use, tool results, and citations back into native
    `web_search` blocks for downstream Messages clients
  - strip `x-anthropic-billing-header` prompt attribution
  - strip `cache_control.scope`
  - rewrite upstream context-window errors into the Anthropic compact
    `invalid_request_error` envelope expected by Messages clients
- `src/data-plane/llm/sources/responses/interceptors/`
  - rewrite `apply_patch` from `custom` to `function`
  - remove unsupported `image_generation` tools and forced tool choices
- `src/data-plane/llm/sources/gemini/interceptors/`
  - strip unsupported Gemini file/code part fields
  - strip unsupported Gemini tool capabilities, including `googleSearch`, until
    it can be routed through the web-search shim
  - strip `safetySettings`
  - hide `thought: true` summary parts by default; only expose Gemini thought
    summaries when `generationConfig.thinkingConfig.includeThoughts === true`
- `src/data-plane/llm/translate/gemini-via-chat-completions/translate-to-source-events.ts`
  - preserve `thoughtSignature` on the next visible text or function-call action
    part so clients can echo it next turn
- `src/data-plane/llm/sources/gemini/respond.ts`
  - translate source errors into Google RPC Status envelopes
- `src/data-plane/llm/targets/messages/interceptors/filter-invalid-thinking-blocks.ts`
  - filter invalid thinking blocks
- `src/data-plane/llm/targets/messages/interceptors/fix-beta-header.ts`
  - whitelist `anthropic-beta`
  - auto-add `interleaved-thinking-2025-05-14` when required
- `src/data-plane/llm/targets/messages/interceptors/strip-service-tier.ts`
  - strip unsupported `service_tier`
- `src/data-plane/llm/targets/messages/interceptors/strip-done-sentinel.ts`
  - strip stray `[DONE]` sentinels
- `src/data-plane/llm/targets/responses/interceptors/strip-service-tier.ts`
  - strip unsupported `service_tier`
- `src/data-plane/llm/targets/responses/interceptors/retry-connection-mismatch.ts`
  - detect expired connection-bound input IDs
  - deterministically rewrite IDs
  - retry once
- `src/data-plane/llm/targets/responses/interceptors/synchronize-output-item-ids.ts`
  - synchronize mismatched stream item IDs
- `src/data-plane/llm/targets/chat-completions/interceptors/strip-service-tier.ts`
  - strip unsupported `service_tier`
- `src/data-plane/llm/targets/chat-completions/interceptors/include-usage-stream-options.ts`
  - ensure streaming usage options needed by native chat handling
- shared translation event helpers
  - guard against infinite whitespace in tool/function arguments

Do not spread the same workaround across route handlers, target emitters, and
translation code at the same time.

## Error Policy

Prefer transparent error propagation.

- Preserve upstream status, headers, and body as directly as possible.
- Do not add explanatory text to upstream errors unless a specific source- or
  target-level workaround requires inspecting and branching on that error.
- Internal failures must expose debug information, including stack traces.
- Use explicit result unions for expected control flow. Do not rely on
  exceptions for ordinary branching.

For source-specific envelopes, keep the source API contract, but still expose
full internal debug fields.

## Testing and Verification

Primary commands:

```bash
deno test
npx wrangler dev
npx wrangler deploy
npx wrangler d1 migrations apply copilot-db
```

Before claiming work is complete, run the relevant verification command and read
the result. Do not claim success from inspection alone.

In this repository, run Wrangler via `npx wrangler` instead of assuming a global
install.

When deploying, use `npx wrangler deploy` directly. Do not pass the `--dry-run`
parameter to `npx wrangler deploy`; Wrangler may open a browser for Cloudflare
login, and the human can complete that login flow when needed.

For manual data-plane validation during development, prefer `ADMIN_KEY` with the
existing `x-models-playground: 1` header on approved playground routes instead
of using any normal API key path. Do not reuse an existing normal API key for
manual testing, and do not create a temporary API key just for manual testing.
Do not broaden admin-key data-plane access beyond that existing testing path.

## Workflow Rules

- Do not create commits unless the human explicitly asks for a commit.
- If the human wants deploy-before-commit validation, deploy first and leave
  changes uncommitted until they approve the commit.
- Follow the repository's existing commit history style. Use Conventional Commit
  subjects in the form `type(scope): subject` when there is a natural scope, or
  `type: subject` when there is not.
- Prefer scopes that match real subsystems already used in history, such as
  `data-plane`, `proxy`, `ui`, or `count-tokens`.
- Keep commit subjects concise and imperative. Do not invent a separate
  project-specific commit style, extra prefixes, or decorative formatting.
- Keep `AGENTS.md` aligned with real architecture and workflow. Rewrite when
  needed; do not accrete contradictory additions.
- When replacing a design, remove dead paths, stale fallbacks, and unused
  compatibility residue unless a real migration reason requires keeping them.
- Any new mutable global state must be treated as edge-distributed state: pair
  in-process caches with a cross-datacenter backing store and document
  invalidation.

## Research Baseline

When investigating gateway behavior, protocol translation choices, fallback
values, or upstream quirks, compare existing implementations before inventing a
new policy.

Start with repositories closest to the boundary you are touching.

Copilot gateway implementations:

- `https://github.com/ericc-ch/copilot-api`
- `https://github.com/caozhiyuan/copilot-api`
- `https://github.com/StarryKira/copilot2api-go`
- `https://github.com/messense/copilot-api-proxy`
- `https://github.com/san-tian/copilot-pool-gateway`
- `https://github.com/xuangong/copilot-api-gateway`

General LLM gateway implementations:

- `https://github.com/BerriAI/litellm`
- `https://github.com/QuantumNous/new-api`
- `https://github.com/songquanpeng/one-api`

Research rules:

- Prefer the project closest to the same upstream and protocol boundary first.
- For Copilot-specific quirks, start with Copilot gateway repos before general
  LLM gateways.
- For generic provider adapter behavior, schema translation, or fallback value
  choices, compare at least one Copilot gateway and one general LLM gateway.
- When citing another project's implementation in code comments, use permalink
  URLs.
- Do not cargo-cult a behavior from one project in isolation; note whether the
  behavior is ecosystem-common, project-specific policy, or a workaround for a
  known upstream bug.

## Code Style

These rules apply project-wide, not only to the data plane.

### General

- Prefer functional style.
- Prefer arrow functions.
- Prefer concise expression-bodied functions when that does not hurt clarity.
- Prefer many focused files over one large file that will accumulate unrelated
  logic.
- Use double quotes and semicolons.

### Abstraction

- Do not extract tiny one-off helpers unless they encode a real domain rule, are
  reused, materially simplify a flow, or need isolated tests.
- Do not introduce framework-like generic layers when a direct explicit flow is
  clearer.
- When the code is already short and readable, keep it inline.

### Fallback Semantics

- Be strict with fallback semantics such as `?? ""`, `?? []`, or synthetic
  default objects.
- Add defaults only when required by a spec, an upstream contract, or an
  explicit behavior decision.
- Do not silently fill values just to make types or branches convenient.

### Exceptions and Branching

- Avoid `catch` for normal control flow.
- Use `catch` only at real boundaries: fetch, parsing, probing, top-level
  request guards, and explicit workaround retry boundaries.
- Avoid defensive checks for cases already excluded by types, normalization, or
  planning.

### Errors

- Preserve upstream errors instead of rewriting them into vague gateway text.
- Internal error responses must include useful debug context, especially stack
  traces.
- Prefer explicit discriminated unions over exception-driven flow for expected
  runtime states.

### Comments

- Do not add comments that merely restate code.
- Do add comments for non-obvious decisions, upstream quirks, protocol
  mismatches, references, or constraints the code alone cannot explain.
- Every explicit workaround, compatibility shim, retry-once branch, or upstream
  quirk fix must carry a nearby comment explaining why it exists, why it lives
  at that boundary, and what it is referencing.
- Local historical commits and issues are good references for those comments.
- Do not cite local markdown docs as workaround references inside code comments.
- When referencing another project's file or commit in a code comment, use a
  permalink URL, not a floating branch path.
- In `References:` lists and similar workaround citations, do not wrap URLs in
  backticks.
- Do not use section-divider comments as a substitute for proper file and
  function structure.

### Type Discipline

- Prefer discriminated unions and narrowing over assertions.
- If an assertion is truly necessary for external payloads or weak runtime
  contracts, keep it narrow and local.
- Keep literal `type` fields literal so narrowing stays useful.

## File Structure Guidance

- New data-plane work belongs in the capability directory under
  `src/data-plane/` where the behavior is true.
- LLM source-specific work belongs in `src/data-plane/llm/sources/<source>/`.
- Source-owned result fixes belong in
  `src/data-plane/llm/sources/<source>/interceptors/` and are registered in that
  directory's `index.ts`.
- Shared target-specific logic belongs in
  `src/data-plane/llm/targets/<target>/`.
- Target-owned request/response/retry fixes belong in
  `src/data-plane/llm/targets/<target>/interceptors/` and are registered in that
  directory's `index.ts`.
- Pairwise translators belong in `src/data-plane/llm/translate/`.
- Models endpoint work belongs in `src/data-plane/models/`.
- Embeddings endpoint work belongs in `src/data-plane/embeddings/`.
- Gemini model listing and count-token endpoints belong in
  `src/data-plane/gemini/`.
- Gemini generation source work belongs in `src/data-plane/llm/sources/gemini/`.
- Data-plane tool capability work belongs in `src/data-plane/tools/<tool>/`,
  such as `src/data-plane/tools/web-search/`.
- Shared data-plane HTTP helpers belong in `src/data-plane/shared/http/`.
- Shared LLM routing helpers belong in `src/data-plane/llm/shared/`.
- Source-specific request cleanup, planning, response assembly, and
  orchestration belong under that source API's subtree.
- Keep final source protocol collection and response shaping source-local.
- If you are reorganizing pair modules, prefer
  `src/data-plane/llm/translate/<source>-via-<target>/` over split request/event
  directories.

When in doubt, prefer the location that matches the boundary where the logic is
true.
