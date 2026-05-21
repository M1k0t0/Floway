# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
- Do not create commits unless the human explicitly asks for a commit.
- Before claiming work is complete, run the relevant verification command and
  read the result.
- Keep this file aligned with real architecture. Rewrite it when needed; do not
  accrete contradictory notes.

## Project

`copilot-gateway` is a Cloudflare Workers API proxy. It exposes Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, and Google
Gemini-compatible APIs over GitHub Copilot accounts and optional custom
OpenAI-compatible upstreams.

Stack: Hono + Web APIs, repository-backed persistence (D1 on Cloudflare Workers,
Deno KV on Deno runtime, in-memory for tests), TypeScript, and `deno test`.

## Boundaries

- `entry-cloudflare.ts`: Workers entrypoint and environment wiring.
- `src/app.ts`: Hono app wiring, middleware, and plane mounting.
- `src/control-plane/`: dashboard, auth, admin APIs, import/export, usage and
  performance views.
- `src/data-plane/`: client-facing compatibility APIs, model/provider routing,
  protocol translation, embeddings, and data-plane tools.
- `src/data-plane/providers/`: provider interface, provider registry, model
  merge, upstream model discovery/cache, model capabilities, provider fix
  catalog, and concrete provider implementations.
- `src/data-plane/shared/protocol/`: protocol DTOs shared by providers, sources,
  targets, translators, model listing, and embeddings.
- `src/data-plane/shared/telemetry/`: data-plane telemetry primitives shared by
  LLM and embeddings. `usage.ts` owns token usage recording; `performance.ts`
  owns request/upstream latency and error recording.
- `src/repo/`: persistence interfaces and implementations.
- `src/runtime/`: runtime integration helpers.
- `src/shared/`: project-wide helpers that are not owned by one plane.
- `src/shared/upstream/`: low-level HTTP adapters. These know how to call an
  upstream, but they do not own LLM planning or provider selection.

Keep behavior in the subtree that owns the boundary where it is true. Avoid flat
shared utility modules unless the rule is genuinely cross-boundary.

## Providers

The data plane treats every Copilot account and every custom upstream config as
a `ModelProvider`. The LLM pipeline must not branch on provider kind. Provider
methods receive the exact `UpstreamModel` object previously returned by that
provider.

Provider API shape:

```text
getProvidedModels() -> UpstreamModel[]
callChatCompletions(upstreamModel, bodyWithoutModel, signal?)
callResponses(upstreamModel, bodyWithoutModel, signal?)
callMessages(upstreamModel, bodyWithoutModel, signal?, anthropicBeta?)
callMessagesCountTokens(upstreamModel, bodyWithoutModel, signal?, anthropicBeta?)
callEmbeddings(upstreamModel, bodyWithoutModel, signal?)
```

`UpstreamModel.supportedEndpoints` is the source of truth for routing. The
global `Model` returned by the registry merges public model metadata and keeps a
list of provider bindings. Request execution tries provider bindings in order
only until the first binding that can serve the requested source shape; that
provider's result is final for the request.

Copilot-specific behavior belongs in `src/data-plane/providers/copilot/`,
including provider-owned source and target interceptor implementations. This
includes Copilot raw model variant selection, Claude public-name normalization,
Copilot request-alias resolution, Copilot endpoint projection, `anthropic-beta`
filtering, and Copilot upstream request fixes. Custom OpenAI-compatible provider
behavior belongs in `src/data-plane/providers/openai/`.

Messages web-search behavior is decided by the post-plan Messages protocol
interceptor. Messages via Responses or Chat Completions always uses the gateway
shim when native web-search tools are present, because those targets cannot run
Anthropic server tools. Native Messages targets receive native web-search tools
directly by default; Copilot enables `messages-web-search-shim` by default, and
custom OpenAI-compatible providers can opt native Messages into the shim with
that upstream fix flag.

Backoff is intentionally disabled for now. Control-plane status returns empty
temporary-unavailability data until a provider-level backoff design lands.

## Data Plane

`src/data-plane/llm/` owns LLM source routing for Messages, Responses, Chat
Completions, Gemini generation, and source-owned token counting endpoints.
Models, embeddings, and data-plane tools live outside that LLM routing graph in
their capability directories.

Model listing belongs in `src/data-plane/models/`: `/v1/models` is
OpenAI-shaped, `/models` is Anthropic-shaped, and `/v1beta/models` is
Gemini-shaped. Public data-plane model APIs must not expose provider bindings,
raw upstream variants, or UI-only provider metadata; `/api/models` may add
dashboard-owned compatibility fields. Upstream model discovery/cache belongs to
`src/data-plane/providers/`, not `src/data-plane/models/`.

Gemini generation handling belongs under `src/data-plane/llm/` because Gemini is
a source API, not a separate data-plane brand boundary. Protocol DTOs that are
needed outside the LLM routing graph live in `src/data-plane/shared/protocol/`.
Usage and performance are telemetry, not LLM concepts: shared recording lives in
`src/data-plane/shared/telemetry/`, while source-specific usage mappers stay in
the owning source directory such as `src/data-plane/llm/sources/messages/`.

The LLM pipeline is:

```text
serve -> resolve model -> provider binding loop
  -> plan from the provider's UpstreamModel capabilities
  -> source protocol interceptors -> build target request
  -> target protocol interceptors -> emit through provider method
  -> translate target protocol events back to source protocol -> respond
```

Use those terms. Planning is the only layer that chooses a target. Successful
execution after `emit` is event-first and should flow through protocol events
whenever practical.

Interceptors are protocol-exchange scoped, not source/target-contract scoped.
`MessagesInterceptor`, `ResponsesInterceptor`, and `ChatCompletionsInterceptor`
have one concrete context/result contract per protocol whether that protocol
appears on the client/source side or the upstream/target side. Provider source
and target registrations are separate execution slots, but they use the same
protocol aliases for the same protocol. The shared post-plan `LlmExchangeMeta`
contains `sourceApi`, `targetApi`, model/provider metadata, `enabledFixes`,
`apiKeyId`, and the downstream abort signal. Do not put responder or telemetry
details such as `clientStream`, `runtimeLocation`, or `scheduleBackground` in
interceptor context. Raw upstream frames stay inside target emitters and
raw-to-protocol converters; protocol interceptors see protocol request payloads
and protocol result/events.

Request translation is direct and pairwise. Do not introduce a canonical
internal request IR. Pair translators belong under
`src/data-plane/llm/translate/<source>-via-<target>/`.

Workarounds belong at the owning boundary:

- source-owned request cleanup, whole-pipeline retry, and final response shaping
  stay under `src/data-plane/llm/sources/<source>/`; source interceptors still
  run after planning for each attempted provider.
- target upstream request fixes, upstream retries, and target event fixes stay
  under `src/data-plane/llm/targets/<target>/`.
- provider-specific source and target fixes are registered by the provider and
  live under that provider's directory; the generic LLM pipeline only executes
  registered interceptor lists.
- shared translation primitives belong in `src/data-plane/llm/translate/shared/`
  only when multiple pair directions need the same protocol rule.

## Routing

Target preferences:

- Messages: native Messages, then Responses, then Chat Completions.
- Responses: native Responses, then Messages, then Chat Completions.
- Chat Completions: native Chat Completions, then Messages, then Responses.
- Gemini generation has no native upstream target in the provider API; it uses
  Chat Completions, then Messages, then Responses.

If no provider binding can produce a plan for the requested source API, return a
source-shaped unsupported-model error. Do not invent legacy model-name routing
outside provider capability metadata.

Claude compatibility aliases and Copilot raw variant selection live in the
provider layer. Until there is a general model-alias feature, Responses rewrites
`codex-auto-review` to `gpt-5.4` with reasoning effort `low` at the Responses
source entry, before model resolution and usage/performance metadata. Historical
telemetry rows are converted to the public model id only in migrations.

## Contracts

Public data-plane compatibility APIs are stable external contracts.
Control-plane APIs and data-plane tool management APIs are UI-owned and must
stay consistent with frontend code, tests, and auth policy.

Authentication has two roles: `admin` via `ADMIN_KEY`, and API key user via a
stored API key. Mutating key APIs and GitHub account management are admin-only;
`GET /api/token-usage` is intentionally visible to any authenticated user.

## Errors and Style

- Preserve upstream status, headers, and body as directly as possible.
- Internal failures must expose useful debug information, including stack
  traces.
- Use explicit result unions for expected control flow.
- Keep fallback semantics strict; do not add synthetic defaults for convenience.
- Avoid `catch` for normal control flow. Use it at real boundaries: fetch,
  parsing, probing, top-level request guards, and explicit workaround retries.
- Prefer functional TypeScript, arrow functions, double quotes, and semicolons.
- Do not extract tiny one-off helpers unless they encode a real domain rule, are
  reused, materially simplify a flow, or need isolated tests.
- Comment only non-obvious decisions, upstream quirks, protocol mismatches, or
  references. Workaround comments should explain why the behavior exists and why
  it lives at that boundary. Use permalink URLs for external code.

## Verification

Primary commands:

```bash
deno test
npx wrangler dev
npx wrangler deploy
npx wrangler d1 migrations apply copilot-db
```

Run Wrangler through `npx wrangler`. When deploying, use `npx wrangler deploy`
directly; do not pass `--dry-run`.

For manual data-plane validation, prefer `ADMIN_KEY` with the existing
`x-models-playground: 1` header on approved playground routes. Do not reuse or
create normal API keys for manual testing.

For Copilot-specific quirks, compare nearby Copilot gateway implementations
before inventing a new policy. For generic adapter behavior, compare at least
one Copilot gateway and one general LLM gateway. Do not cargo-cult behavior from
a single project.
