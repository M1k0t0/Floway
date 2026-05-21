# Copilot Gateway

A lightweight and secure API proxy deployed on serverless platforms that exposes
your GitHub Copilot subscription as standard **Anthropic Messages API** and
**OpenAI Responses API**, **OpenAI Chat Completions**, and **Google Gemini API**
endpoints — letting you use
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[Codex CLI](https://github.com/openai/codex), and other coding agents through
Copilot.

## How It Works

Copilot Gateway translates between API formats on the fly:

- **Claude Code** talks Anthropic Messages API → Gateway translates to whatever
  Copilot supports for that model
- **Codex CLI** talks OpenAI Responses API → Gateway translates or passes
  through accordingly
- **Any OpenAI-compatible client** can use the Chat Completions endpoint —
  Gateway translates to Messages or Responses API as needed
- **Gemini-compatible clients** can use `generateContent`,
  `streamGenerateContent`, `countTokens`, and `models` routes under
  `/v1beta/models` — Gateway translates them to Copilot-backed LLM targets

The gateway auto-detects each model's supported endpoints (native Messages,
Responses, or Chat Completions) and picks the best translation path. When
endpoint metadata says a request can use more than one upstream API, planning
chooses among those native endpoints directly. Request-shape validation is left
to the selected upstream endpoint unless a documented protocol interceptor needs
to patch the request or response at that boundary. Interceptors are scoped by
protocol: a Messages interceptor sees Messages request/result data whether that
protocol is the client-facing source or the upstream target.

## Quick Start

> **Tip**: This project ships with a concise `AGENTS.md` that records the main
> architecture and workflow rules for coding agents. Claude Code and Codex CLI
> will read it automatically.

### Prerequisites

- A GitHub account with an active [Copilot](https://github.com/features/copilot)
  subscription
- **Deno** (>= 2.4) or **Node.js** (for Cloudflare Workers via wrangler)

### Deploy to Deno Deploy

```bash
# Clone and enter the project
git clone https://github.com/user/copilot-gateway.git
cd copilot-gateway

# Set the admin key (used to log in to the dashboard)
# On Deno Deploy, set this as an environment variable in the dashboard
export ADMIN_KEY=your-secret-admin-key

# Local development
deno task dev

# Deploy to production (requires Deno >= 2.4)
deno deploy --prod
```

### Deploy to Cloudflare Workers

```bash
# Install dependencies (needed for wrangler and type stubs)
pnpm install

# Create the D1 database
wrangler d1 create copilot-db

# Update wrangler.jsonc with your account_id and database_id, then apply migrations
wrangler d1 migrations apply copilot-db

# Set the admin key as a secret
wrangler secret put ADMIN_KEY

# Local development
wrangler dev

# Deploy to production
wrangler deploy
```

### Initial Setup

1. Open the deployed URL in a browser, log in with your `ADMIN_KEY`
2. Go to the **Upstream** tab and connect your GitHub account (the one with a
   Copilot subscription) via the device OAuth flow
3. Go to the **API Keys** tab and create an API key for your client
4. The **API Keys** tab shows ready-to-copy configuration snippets for both
   Claude Code and Codex CLI

### Optional Native Messages Web Search

Anthropic-native-looking web search is accepted only on `/v1/messages` and
`/messages`. Native Messages upstreams receive native web-search tools directly
unless the selected provider opts into gateway execution. When the selected
target cannot execute Anthropic server tools, the post-plan Messages protocol
interceptor runs the gateway shim, which requires an enabled search provider.

Configure it in the dashboard under **Upstream -> Search**.

Provider choices:

- `disabled`
- `tavily`
- `microsoft-grounding`

The gateway stores this search config in its control-plane data, not env vars,
and includes it in export/import.

## Architecture

```
Claude Code / Codex CLI / any client
        │
        ▼
  Copilot Gateway (Hono)
  ├── POST /v1/messages          ← Anthropic Messages API
  ├── POST /v1/responses         ← OpenAI Responses API
  ├── POST /v1/chat/completions  ← OpenAI Chat Completions
  ├── POST /v1/embeddings        ← Embeddings passthrough
  ├── GET  /v1/models            ← OpenAI model listing
  └── GET/POST /v1beta/models/... ← Gemini models/generate/count tokens
        │
        ▼ (auto-selects translation path per model)
  GitHub Copilot API
```

> 95% of the code is platform-agnostic (Hono + Web APIs). Platform-specific
> storage is abstracted behind a repository layer — `DenoKvRepo` for Deno
> Deploy, `D1Repo` for Cloudflare Workers.

## License

MIT
