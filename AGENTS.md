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

`copilot-gateway` is a Cloudflare Workers GitHub Copilot API proxy. It exposes
Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, and
Google Gemini-compatible APIs on top of Copilot upstream APIs.

Stack: Hono + Web APIs, repository-backed persistence (D1 on Cloudflare Workers,
Deno KV on Deno runtime, in-memory for tests), TypeScript, and `deno test`.

## Boundaries

- `entry-cloudflare.ts`: Workers entrypoint and environment wiring.
- `src/app.ts`: Hono app wiring, middleware, and plane mounting.
- `src/control-plane/`: dashboard, auth, admin APIs, import/export, usage and
  performance views.
- `src/data-plane/`: client-facing compatibility APIs and Copilot protocol
  translation.
- `src/repo/`: persistence interfaces and implementations.
- `src/runtime/`: runtime integration helpers.
- `src/shared/`: project-wide helpers that are not owned by one plane.

Keep behavior in the subtree that owns the boundary where it is true. Avoid flat
shared utility modules unless the rule is genuinely cross-boundary.

## Data Plane

`src/data-plane/llm/` owns LLM source routing for Messages, Responses, Chat
Completions, Gemini generation, and source-owned token counting endpoints.
Models, embeddings, and data-plane tools live outside that LLM routing graph in
their capability directories.

Model listing belongs in `src/data-plane/models/`, including Gemini-shaped model
listing. Gemini generation request/response protocol types and handling belong
under `src/data-plane/llm/` because Gemini is a source API, not a separate
data-plane brand boundary.

The LLM pipeline is:

```text
serve -> source interceptors -> resolve model -> account fallback -> plan
  -> build target request -> emit to target -> translate events -> respond
```

Use those terms. Planning is the only layer that chooses a target. Successful
execution after `emit` is event-first and should flow through source-shaped
events whenever practical.

Request translation is direct and pairwise. Do not introduce a canonical
internal request IR. Pair translators belong under
`src/data-plane/llm/translate/<source>-via-<target>/`.

Workarounds belong at the owning boundary:

- source request cleanup, whole-pipeline retry, and final response shaping stay
  under `src/data-plane/llm/sources/<source>/`.
- target upstream request fixes, upstream retries, and target event fixes stay
  under `src/data-plane/llm/targets/<target>/`.
- shared translation primitives belong in `src/data-plane/llm/translate/shared/`
  only when multiple pair directions need the same protocol rule.

## Routing

Target preferences:

- Messages: native Messages, then Responses, then Chat Completions.
- Responses: native Responses, then Messages, then Chat Completions.
- Chat Completions: Messages, then native Chat Completions, then Responses.
- Gemini generation uses the same preference as Chat Completions.

If no capability-backed target is available, Chat Completions and Gemini keep
the legacy model-name fallback: `claude*` goes through Messages, everything else
goes through native Chat Completions.

Model resolution happens before account fallback and returns one final upstream
model ID. Account fallback must not re-resolve the model per account. Claude
compatibility aliases and variants live in
`src/data-plane/llm/shared/models/resolve-model.ts`.

Until there is a general model-alias feature, Responses rewrites
`codex-auto-review` to `gpt-5.4` with reasoning effort `low` at the Responses
source entry, before model resolution and usage/performance metadata.

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
