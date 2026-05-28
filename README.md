# Floway

Floway is a Cloudflare Workers API proxy that fronts multiple model upstreams
behind one set of standard APIs. Point a coding agent at Floway and it can use
a GitHub Copilot account, a custom OpenAI- or Anthropic-compatible provider, or
an Azure deployment through whichever API shape the agent already speaks.

## Client APIs

| Source API                              | Path                          |
| --------------------------------------- | ----------------------------- |
| Anthropic Messages                      | `POST /v1/messages`           |
| OpenAI Responses                        | `POST /v1/responses`          |
| OpenAI Chat Completions                 | `POST /v1/chat/completions`   |
| OpenAI Embeddings                       | `POST /v1/embeddings`         |
| OpenAI Images                           | `POST /v1/images/generations` |
| OpenAI Image Edits                      | `POST /v1/images/edits`       |
| OpenAI Models                           | `GET  /v1/models`             |
| Google Gemini (generate / count tokens) | `POST /v1beta/models/...`     |

For each public model, Floway picks the first provider binding that can serve
the request, translating between source and target protocols when the upstream
speaks a different shape.

## Quick Start

Prereqs: a Cloudflare account, Node.js 20.3+, pnpm 10.x, and at least one
upstream credential: Copilot subscription, OpenAI-compatible bearer token, or
Azure endpoint plus API key.

```bash
pnpm install

# Local Worker config (gitignored). Fill in account_id, database_id, name.
cp wrangler.example.jsonc wrangler.jsonc
pnpm wrangler login
pnpm wrangler d1 create <DB_NAME>

# Apply schema and set the admin secret.
pnpm run db:migrate
pnpm wrangler secret put ADMIN_KEY

# Run locally or deploy. In dev, open the Vite SPA at http://localhost:5174.
pnpm run dev
pnpm run deploy
```

Open the deployed URL, log in with `ADMIN_KEY`, and:

1. **Settings -> Upstreams -> Add Upstream**. Upstreams are *Custom*
   (OpenAI/Anthropic-shaped, static credential), *Azure* (one endpoint, API key,
   deployment list), or *Copilot* (GitHub device OAuth). List order is routing
   order; earlier providers win for a shared public model id.
2. **API Keys -> New Key**. Give the generated key to your client.
3. Copy the Claude Code or Codex CLI snippet from the API Keys panel into the
   agent config.

Import/export of upstreams, keys, and search config is in Settings; it uses the
latest `version: 2` payload shape.

## Server Tools

`/v1/messages` accepts Anthropic-style web search. When the resolved upstream
can run the native server tool, Floway passes it through; otherwise it shims the
search via **Settings -> Web Search** (`tavily` or `microsoft-grounding`,
default `disabled`).

`/v1/responses` has a shared server-tool shim layer for hosted Responses
tools. `web_search` is rewritten into a model-visible function call,
executed through the same web-search provider (**Settings -> Web
Search**), and emitted back as Responses `web_search_call` items, with
the shim driving the internal multi-turn loop and replaying prior
`web_search_call` items across turns.

## Development

```bash
pnpm run lint          # eslint --cache across the workspace
pnpm run test          # vitest run over the root test.projects
pnpm run typecheck     # pnpm -r run typecheck
pnpm run dev           # parallel wrangler dev (8788) + Vite SPA dev server (5174)
```

The repo is a pnpm workspace. `packages/protocols` and `packages/translate` are
pure libraries; `apps/api` is the Worker; `apps/web` is a Vue/Vite SPA served by
Vite in dev and by Workers Static Assets from `apps/web/dist` after build.
`wrangler.example.jsonc` keeps API/data-plane routes Worker-first and lets other
direct browser routes fall through to the SPA's `index.html`. Cross-package
imports go through each package's `exports` map; deep imports are blocked by
ESLint.

See [AGENTS.md](./AGENTS.md) for architecture, provider routing, deployment,
and development conventions.

## License

MIT
