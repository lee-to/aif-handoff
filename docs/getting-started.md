[Back to README](../README.md) · [Architecture →](architecture.md)

# Getting Started

## Prerequisites

- **Docker** — Docker Desktop or compatible runtime
- **Node.js** 22+ and **npm** 10+ — only needed if running without Docker
- **Claude Code CLI** — only needed if running without Docker (`npm i -g @anthropic-ai/claude-code`). The Agent SDK spawns Claude Code as a subprocess, so the CLI must be installed globally
- **Claude subscription** or Anthropic API key (for agent features)

## Quick Start with Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
docker compose up --build
```

This builds and starts API (port 3009), Web UI (port 5180), and Agent in one command. Uses Angie as a reverse proxy — Web UI at `localhost:5180` proxies all API and WebSocket requests automatically.

Data is persisted in Docker volumes (SQLite database, project files, and Claude auth).

### Docker Authentication

Two options:

**Option A — API key:** Create `.env` with `ANTHROPIC_API_KEY=sk-ant-xxxxx` before running.

**Option B — Claude subscription:** Log in inside the container after first start:

```bash
docker compose exec agent claude login
docker compose restart
```

Copy the URL and open it in your browser. **Important:** the terminal wraps long URLs across lines — remove any line breaks and spaces before pasting, otherwise OAuth will fail with `invalid code_challenge`. Then restart to apply. Credentials are stored in a persistent `claude-auth` Docker volume and survive restarts.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Only ports 80/443 exposed. Security hardening, healthchecks, resource limits, and log rotation included. Authentication works the same as in development — see [Docker Authentication](#docker-authentication) above.

Docker-specific environment variables:

| Variable            | Default      | Description                            |
| ------------------- | ------------ | -------------------------------------- |
| `ANTHROPIC_API_KEY` | —            | API key (or use `claude login`)        |
| `DOMAIN`            | `localhost`  | Domain for SSL certificate (ACME)      |
| `PORT`              | `3009`       | Host port for API                      |
| `WEB_PORT`          | `5180`       | Host port for Web UI (dev)             |
| `HTTP_PORT`         | `80`         | Host port for Web UI (production)      |
| `HTTPS_PORT`        | `443`        | HTTPS port (production)                |
| `PROJECTS_DIR`      | `./projects` | Host directory for project files (dev) |
| `PROJECTS_MOUNT`    | `/home/www`  | Project files path inside containers   |

## Installation without Docker

```bash
npm i -g @anthropic-ai/claude-code   # required — Agent SDK uses Claude Code CLI
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install
```

## Database Setup

The project uses SQLite via `better-sqlite3` + `drizzle-orm`. DB access in runtime services is centralized in `@aif/data` (lint-enforced boundary for `api` and `agent`). Initialize the database:

```bash
npm run db:setup
```

This builds `@aif/shared`, creates `data/aif.sqlite`, and applies runtime migrations/index bootstrap.

To apply schema changes later:

```bash
npm run db:push
```

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

`api` and `agent` automatically read env from root `.env` (`.env.local` overrides when present), so no extra export step is required.

| Variable                       | Default             | Description                                                                                   |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | _(optional)_        | API key. Agent SDK uses `~/.claude/` auth by default                                          |
| `PORT`                         | `3009`              | API server port                                                                               |
| `WEB_PORT`                     | `5180`              | Web UI dev server port                                                                        |
| `POLL_INTERVAL_MS`             | `30000`             | Agent coordinator polling interval (ms)                                                       |
| `AGENT_STAGE_STALE_TIMEOUT_MS` | `5400000`           | Stale-stage watchdog timeout (ms) before auto-recovery                                        |
| `AGENT_STAGE_STALE_MAX_RETRY`  | `3`                 | Max stale auto-recover attempts before quarantine in `blocked_external`                       |
| `AGENT_STAGE_RUN_TIMEOUT_MS`   | `3600000`           | Per-stage timeout (ms) before coordinator marks run as failed                                 |
| `AGENT_USE_SUBAGENTS`          | `true`              | Default for per-task "Use subagents" toggle. `true`: custom subagents, `false`: aif-\* skills |
| `DATABASE_URL`                 | `./data/aif.sqlite` | SQLite database path                                                                          |
| `AGENT_QUERY_AUDIT_ENABLED`    | `true`              | Enable/disable query audit logs in `logs/*.log`                                               |
| `LOG_LEVEL`                    | `debug`             | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`                                 |
| `ACTIVITY_LOG_MODE`            | `sync`              | Activity logging strategy: `sync` or `batch`                                                  |

You can set planner/plan-checker/implementer/review budgets per project in the project edit dialog. Leave any budget field empty for unlimited.

See [Configuration](configuration.md) for details.

## Running

Start all services with hot reload:

```bash
npm run dev
```

This runs three processes in parallel via Turborepo:

| Service   | URL                     | Description                                               |
| --------- | ----------------------- | --------------------------------------------------------- |
| **API**   | `http://localhost:3009` | REST + WebSocket server                                   |
| **Web**   | `http://localhost:5180` | Kanban board UI                                           |
| **Agent** | _(background)_          | Polls every 30s + event-driven wake, dispatches subagents |

## Verify It Works

1. Open `http://localhost:5180` — you should see the Kanban board
2. Create a project (top-left selector)
3. Add a task to the Backlog column
4. If Claude auth is missing, the UI will show a warning banner with setup guidance
5. If agent is running with valid credentials, the task will automatically move through stages

Optional readiness check:

```bash
curl -s http://localhost:3009/agent/readiness
```

## Available Scripts

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `npm run dev`      | Start all services with hot reload |
| `npm run build`    | Build all packages                 |
| `npm test`         | Run all tests (Vitest)             |
| `npm run db:setup` | Build shared and initialize SQLite |
| `npm run db:push`  | Push schema changes                |

## Next Steps

- [Architecture](architecture.md) — understand the agent pipeline and module structure
- [API Reference](api.md) — explore the REST and WebSocket API

## Dev Container

The project includes a `.devcontainer/devcontainer.json` for JetBrains and VS Code. Open the project in your IDE — it will offer to reopen in a Dev Container with Node 22, ports forwarded, and dependencies pre-installed.

## See Also

- [Architecture](architecture.md) — project structure and agent pipeline
- [API Reference](api.md) — endpoints and WebSocket events
- [Configuration](configuration.md) — environment variables in detail
