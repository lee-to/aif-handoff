![logo](https://github.com/lee-to/aif-handoff/blob/main/art/promo.jpg)

# AIF Handoff

> Autonomous Kanban board where AI agents plan, implement, and review your tasks — fully hands-off.

> This project was built using [AI Factory](https://github.com/lee-to/ai-factory) — an open-source framework for AI-driven development.

Built on top of [AI Factory](https://github.com/lee-to/ai-factory) workflow and powered by runtime profiles through `@aif/runtime` (Claude and Codex adapters included). Tasks flow through stages automatically: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — each stage orchestrated by specialized AI subagents following the AIF methodology. In auto mode, review feedback can also trigger an automatic rework loop: **Review → request_changes → Implementing**. When that loop stops converging, the task is handed off explicitly as **Done + manual review required** instead of silently passing.

Auto-review is now convergence-aware. You can keep the default `full_re_review` loop or switch to `closure_first` via `AGENT_AUTO_REVIEW_STRATEGY`. When auto-review no longer converges, the task moves to `done` with `manualReviewRequired=true`, and the UI surfaces that explicit human handoff instead of silently treating the review as passed.

## Runtime Providers Out of the Box

Use the runtime that fits your stack today, then switch per project/task without changing orchestration logic:

- **Claude (`anthropic`)** — SDK, CLI, API transports
- **Codex (`openai`)** — SDK, CLI, API transports
- **OpenRouter (`openrouter`)** — API transport
- **OpenCode (`opencode`)** — API transport

> **⚠️ Warning:** Anthropic prohibits using Claude Max / Pro subscriptions outside of the official Claude Code CLI. The SDK transport for Claude calls the Agent SDK directly, which may violate these terms. If you're worried about your subscription getting blocked, use the **CLI transport** — it runs through the official Claude Code CLI and is safe to use on a Max / Pro subscription. Use the SDK transport at your own risk, or switch to the API transport with an `ANTHROPIC_API_KEY` for production use.

Need something custom? Add your own runtime adapter module and load it at startup via `AIF_RUNTIME_MODULES` (comma-separated module specifiers). No fork required.

## Key Features

- **Fully autonomous pipeline** — create a task, AI plans, implements, and reviews it
- **Beautiful Kanban UI** — drag-and-drop board with real-time WebSocket updates
- **AI Factory core** — built on [ai-factory](https://github.com/lee-to/ai-factory) agent definitions and skill system
- **Subagent orchestration** — plan-coordinator, implement-coordinator, review + security sidecars
- **Runtime/provider modularity** — runtime registry, project/task runtime profile selection, and provider-specific capability gating
- **Layer-aware execution** — implementer computes dependency layers and enforces parallel worker dispatch where possible
- **Self-healing pipeline** — heartbeat + stale-stage watchdog auto-recovers stuck agent stages
- **Human-in-the-loop** — approve plans, request changes, or let auto-mode handle everything
- **MCP sync** — bidirectional task sync between Handoff and AIF tools via Model Context Protocol

## Quick Start

### Without Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install
npm run init
npm run dev
```

Set `MCP_PORT` in your shell or root `.env` before `npm run dev` if you also want the MCP HTTP server in local development. Use an integer port between `1` and `65535`; invalid values are ignored by the dev launcher and the settings install route falls back to the local `stdio` entry instead of writing an HTTP MCP endpoint.

### With Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
docker compose up --build
```

Development starts three services by default. If `MCP_PORT` is set to a valid integer port, it starts a fourth service for MCP over HTTP. Docker starts all four services.

| Service   | URL                               | Description                                  |
| --------- | --------------------------------- | -------------------------------------------- |
| **API**   | `http://localhost:3009`           | Hono REST + WebSocket server                 |
| **Web**   | `http://localhost:5180`           | React Kanban UI                              |
| **Agent** | _(background)_                    | Event-driven + polling, dispatches subagents |
| **MCP**   | `http://localhost:<MCP_PORT>/mcp` | Optional local MCP HTTP endpoint             |

The agent coordinator reacts to task events via WebSocket in near real-time and falls back to 30-second polling. Activity logging can be switched to batch mode (`ACTIVITY_LOG_MODE=batch`) to reduce DB write amplification. See [Configuration](docs/configuration.md) for all tuning options.

### Authentication

- **Without Docker:** Claude runtime profiles can use `~/.claude/` credentials by default (your active Claude subscription). No API key needed.
- **With Docker:** Either set `ANTHROPIC_API_KEY` in `.env`, or log in inside the container:
  ```bash
  docker compose exec agent claude login
  docker compose restart
  ```
  Copy the URL and open it in your browser. **Important:** the terminal wraps long URLs across lines — remove any line breaks and spaces before pasting, otherwise OAuth will fail with `invalid code_challenge`. Then restart to apply. Credentials are stored in a persistent `claude-auth` Docker volume.

For Codex/OpenAI-compatible profiles, configure `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL` (or set profile-level `apiKeyEnvVar` / `baseUrl`). See [Providers](docs/providers.md).

#### Codex OAuth in Docker (without `OPENAI_API_KEY`)

The `codex login` CLI binds its OAuth callback to `127.0.0.1:1455` inside the
container, which is unreachable from the host browser. The dev compose wires up
a small in-container broker that bridges this gap and exposes a guided UI in
**Settings → Runtime profile → Codex**:

1. Click **Start Codex login**. The broker spawns `codex login` and returns the
   authorization URL.
2. Open the URL in your browser and authorize the app.
3. The browser redirects to `http://localhost:1455/?code=…&state=…` and shows a
   connection-refused page — this is expected. Copy the entire URL from the
   address bar.
4. Paste it back into the wizard. The broker completes the callback from inside
   the container, and `codex login` writes `~/.codex/auth.json` to the
   persistent `codex-auth` volume.
5. Run `docker compose restart agent` to pick up the credentials.

**Fallback CLI helper** — if the UI is unavailable, run the callback directly:

```bash
docker compose exec agent aif-codex-callback "http://localhost:1455/?code=…&state=…"
```

**Production note:** the broker is **dev-only**. `docker-compose.production.yml`
sets `AIF_ENABLE_CODEX_LOGIN_PROXY=false`. For production, configure
`OPENAI_API_KEY` in `.env` instead.

### OpenCode Quick Setup

1. Start OpenCode server (example with password):

```bash
OPENCODE_SERVER_PASSWORD='your-strong-password' opencode serve --hostname 127.0.0.1 --port 60661
```

2. Create/update runtime profile in AIF Handoff:

- `runtimeId`: `opencode`
- `providerId`: `opencode`
- `baseUrl`: `http://127.0.0.1:60661`
- `options.serverPassword`: same password as above
- `defaultModel`: use exact value from `GET /config/providers`, for example `openrouter/anthropic/claude-sonnet-4.6`

3. Validate profile connection in UI and use it for chat/task stages.

Full OpenCode options and examples: [Providers](docs/providers.md#opencode-api).

## Architecture

```
packages/
├── shared/    # Types, schema, state machine, env, constants, logger
├── runtime/   # Runtime registry, adapters, module loader, workflow specs
├── data/      # Centralized DB access layer (@aif/data)
├── api/       # Hono REST + WebSocket server (port 3009)
├── web/       # React + Vite + TailwindCSS — Kanban UI (port 5180)
└── agent/     # Coordinator (node-cron) + runtime-driven subagent orchestration
```

Database access is centralized in `packages/data`. `api` and `agent` must use `@aif/data`; direct DB imports in those packages are blocked by ESLint guards.

### Agent Pipeline

The coordinator polls every 30 seconds and delegates to `.claude/agents/` definitions:

| Stage                                                                                            | Agent                                                                     | What it does                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog → Planning → Plan Ready                                                                  | `plan-coordinator`                                                        | Iterative plan refinement via `plan-polisher`                                                                                                |
| Plan Ready → Implementing → Review                                                               | `implement-coordinator`                                                   | Parallel task execution with worktrees + quality sidecars                                                                                    |
| Review → Done / Review → request_changes → Implementing / Review → Done + manual review required | `review-sidecar` + `security-sidecar` (+ auto review gate in coordinator) | Code review and security audit in parallel; in auto mode, structured blocking findings drive rework until success or explicit manual handoff |

### Auto-Review Convergence

- `AGENT_AUTO_REVIEW_STRATEGY=full_re_review` keeps the broad re-review loop and is the default.
- `AGENT_AUTO_REVIEW_STRATEGY=closure_first` only auto-reworks unresolved previous blockers; if new blockers appear after previous ones are resolved, the coordinator stops and asks for human review.
- Hitting the review-iteration limit also stops automation at `done` with `manualReviewRequired=true`.

### Fault Tolerance

- Task liveness is tracked with `lastHeartbeatAt`.
- If a stage (`planning`, `implementing`, `review`) stops heartbeating longer than timeout, coordinator moves task to `blocked_external` with retry backoff.
- After max stale retries, task is quarantined for manual intervention.

All agents are loaded via `settingSources: ["project"]` from `.claude/agents/*.md` — the same agent definitions used by [AI Factory](https://github.com/lee-to/ai-factory).

### Execution Modes

AIF Handoff supports two execution modes, configurable globally via `AGENT_USE_SUBAGENTS` or per-task in the UI:

| Mode          | `AGENT_USE_SUBAGENTS` | How it works                                                                                                                                                                                                  | Trade-off                                                                                                                                                            |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subagents** | `true`                | Each stage runs through specialized coordinator agents (`plan-coordinator`, `implement-coordinator`, `review-sidecar` + `security-sidecar`) that iteratively refine the result until quality criteria are met | Higher quality — plans are polished in multiple rounds, implementation gets parallel workers with quality sidecars, reviews are thorough. Takes more time and tokens |
| **Skills**    | `false` (default)     | Each stage runs as a single-pass AIF skill (`/aif-plan`, `/aif-implement`, `/aif-review`, `/aif-security-checklist`)                                                                                          | Faster execution with lower token usage, but no iterative refinement — good enough for simpler tasks or quick prototyping                                            |

## Tech Stack

| Layer        | Technology                                                    |
| ------------ | ------------------------------------------------------------- |
| Runtime      | Node.js + TypeScript                                          |
| Monorepo     | Turborepo                                                     |
| Database     | SQLite (better-sqlite3 + drizzle-orm)                         |
| API          | Hono + @hono/node-server + WebSocket                          |
| Validation   | zod + @hono/zod-validator                                     |
| Frontend     | React + Vite + TailwindCSS                                    |
| Drag & Drop  | @dnd-kit                                                      |
| Server State | @tanstack/react-query                                         |
| Runtime SDKs | Pluggable adapters — Claude (Agent SDK) + Codex (CLI/SDK/API) |
| Scheduler    | node-cron                                                     |

## Docker

The project includes full Docker support (Angie reverse proxy + Node services).

### Development

```bash
docker compose up --build
```

Web UI at `localhost:5180`, API at `localhost:3009`, MCP at `localhost:${MCP_PORT:-3100}`.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Authentication: set `ANTHROPIC_API_KEY` in `.env`, or log in via `docker compose exec agent claude login` and then `docker compose restart` (see [Authentication](#authentication) above).

Only ports 80/443 are exposed. API is bound to localhost only. Includes security hardening (no-new-privileges, resource limits), healthchecks, log rotation, and automatic SSL via Let's Encrypt (ACME).

| Variable            | Default      | Description                               |
| ------------------- | ------------ | ----------------------------------------- |
| `ANTHROPIC_API_KEY` | —            | API key (or use `claude login`)           |
| `DOMAIN`            | `localhost`  | Domain for SSL certificate (ACME)         |
| `PORT`              | `3009`       | Host port for API                         |
| `MCP_PORT`          | `3100`       | Host port for MCP HTTP server (`1-65535`) |
| `WEB_PORT`          | `5180`       | Host port for Web UI (dev)                |
| `WEB_HOST`          | `localhost`  | Web UI dev server host (Vite)             |
| `HTTP_PORT`         | `80`         | Host port for Web UI (production)         |
| `HTTPS_PORT`        | `443`        | HTTPS port (production)                   |
| `PROJECTS_DIR`      | `./projects` | Host directory for project files (dev)    |
| `PROJECTS_MOUNT`    | `/home/www`  | Project files path inside containers      |

A `.devcontainer/` config is also included for JetBrains / VS Code.

## Scripts

| Command            | Description                                   |
| ------------------ | --------------------------------------------- |
| `npm run dev`      | Start all services with hot reload            |
| `npm run build`    | Build all packages                            |
| `npm test`         | Run all tests (Vitest)                        |
| `npm run init`     | Initialize database                           |
| `npm run db:setup` | Build shared package and initialize SQLite DB |
| `npm run db:push`  | Push schema changes via drizzle-kit           |

## Troubleshooting

If you enabled subagents and the workflow runs for too long or frequently times out, disable them in your environment (this is the default):

```env
AGENT_USE_SUBAGENTS=false
```

If an LLM report says it lacks permissions for specific actions during workflow execution, either grant the required permissions in `.claude/settings.local.json` or bypass permission checks via environment variable:

```env
AGENT_BYPASS_PERMISSIONS=true
```

---

## Documentation

| Guide                                      | Description                                   |
| ------------------------------------------ | --------------------------------------------- |
| [Getting Started](docs/getting-started.md) | Installation, setup, first steps              |
| [Architecture](docs/architecture.md)       | Agent pipeline, state machine, data flow      |
| [API Reference](docs/api.md)               | REST endpoints, WebSocket events              |
| [Configuration](docs/configuration.md)     | Environment variables, logging, auth          |
| [Providers](docs/providers.md)             | Runtime profiles, adapters, capability matrix |

![ui-light](https://github.com/lee-to/aif-handoff/blob/main/art/ui-light.png)
![ui-dark](https://github.com/lee-to/aif-handoff/blob/main/art/ui-dark.png)
![ui-light-list](https://github.com/lee-to/aif-handoff/blob/main/art/ui-light-list.png)
![ui-dark-list](https://github.com/lee-to/aif-handoff/blob/main/art/ui-dark-list.png)

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## Security

If you discover a security vulnerability, please see [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

MIT License — see [LICENSE](LICENSE) for details.
