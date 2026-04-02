![logo](https://github.com/lee-to/aif-handoff/blob/main/art/promo.jpg)

# AIF Handoff

> Autonomous Kanban board where AI agents plan, implement, and review your tasks — fully hands-off.

> This project was built using [AI Factory](https://github.com/lee-to/ai-factory) — an open-source framework for AI-driven development.

Built on top of [AI Factory](https://github.com/lee-to/ai-factory) workflow and powered by [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk) subagents. Tasks flow through stages automatically: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — each stage orchestrated by specialized AI subagents following the AIF methodology. In auto mode, review feedback can also trigger an automatic rework loop: **Review → request_changes → Implementing**.

## Key Features

- **Fully autonomous pipeline** — create a task, AI plans, implements, and reviews it
- **Beautiful Kanban UI** — drag-and-drop board with real-time WebSocket updates
- **AI Factory core** — built on [ai-factory](https://github.com/lee-to/ai-factory) agent definitions and skill system
- **Subagent orchestration** — plan-coordinator, implement-coordinator, review + security sidecars
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

### With Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
docker compose up --build
```

Both options start three services:

| Service   | URL                     | Description                                  |
| --------- | ----------------------- | -------------------------------------------- |
| **API**   | `http://localhost:3009` | Hono REST + WebSocket server                 |
| **Web**   | `http://localhost:5180` | React Kanban UI                              |
| **Agent** | _(background)_          | Event-driven + polling, dispatches subagents |

The agent coordinator reacts to task events via WebSocket in near real-time and falls back to 30-second polling. Activity logging can be switched to batch mode (`ACTIVITY_LOG_MODE=batch`) to reduce DB write amplification. See [Configuration](docs/configuration.md) for all tuning options.

### Authentication

- **Without Docker:** Agent SDK uses `~/.claude/` credentials by default (your active Claude subscription). No API key needed.
- **With Docker:** Either set `ANTHROPIC_API_KEY` in `.env`, or log in inside the container:
  ```bash
  docker compose exec agent claude login
  docker compose restart
  ```
  Copy the URL and open it in your browser. **Important:** the terminal wraps long URLs across lines — remove any line breaks and spaces before pasting, otherwise OAuth will fail with `invalid code_challenge`. Then restart to apply. Credentials are stored in a persistent `claude-auth` Docker volume.

## Architecture

```
packages/
├── shared/    # Types, schema, state machine, env, constants, logger
├── data/      # Centralized DB access layer (@aif/data)
├── api/       # Hono REST + WebSocket server (port 3009)
├── web/       # React + Vite + TailwindCSS — Kanban UI (port 5180)
└── agent/     # Coordinator (node-cron) + Claude Agent SDK subagents
```

Database access is centralized in `packages/data`. `api` and `agent` must use `@aif/data`; direct DB imports in those packages are blocked by ESLint guards.

### Agent Pipeline

The coordinator polls every 30 seconds and delegates to `.claude/agents/` definitions:

| Stage                                                   | Agent                                                                     | What it does                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Backlog → Planning → Plan Ready                         | `plan-coordinator`                                                        | Iterative plan refinement via `plan-polisher`                                                                     |
| Plan Ready → Implementing → Review                      | `implement-coordinator`                                                   | Parallel task execution with worktrees + quality sidecars                                                         |
| Review → Done / Review → request_changes → Implementing | `review-sidecar` + `security-sidecar` (+ auto review gate in coordinator) | Code review and security audit in parallel; in auto mode, detected fix items automatically restart implementation |

### Fault Tolerance

- Task liveness is tracked with `lastHeartbeatAt`.
- If a stage (`planning`, `implementing`, `review`) stops heartbeating longer than timeout, coordinator moves task to `blocked_external` with retry backoff.
- After max stale retries, task is quarantined for manual intervention.

All agents are loaded via `settingSources: ["project"]` from `.claude/agents/*.md` — the same agent definitions used by [AI Factory](https://github.com/lee-to/ai-factory).

### Execution Modes

AIF Handoff supports two execution modes, configurable globally via `AGENT_USE_SUBAGENTS` or per-task in the UI:

| Mode          | `AGENT_USE_SUBAGENTS` | How it works                                                                                                                                                                                                  | Trade-off                                                                                                                                                            |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subagents** | `true` (default)      | Each stage runs through specialized coordinator agents (`plan-coordinator`, `implement-coordinator`, `review-sidecar` + `security-sidecar`) that iteratively refine the result until quality criteria are met | Higher quality — plans are polished in multiple rounds, implementation gets parallel workers with quality sidecars, reviews are thorough. Takes more time and tokens |
| **Skills**    | `false`               | Each stage runs as a single-pass AIF skill (`/aif-plan`, `/aif-implement`, `/aif-review`, `/aif-security-checklist`)                                                                                          | Faster execution with lower token usage, but no iterative refinement — good enough for simpler tasks or quick prototyping                                            |

## Tech Stack

| Layer        | Technology                            |
| ------------ | ------------------------------------- |
| Runtime      | Node.js + TypeScript                  |
| Monorepo     | Turborepo                             |
| Database     | SQLite (better-sqlite3 + drizzle-orm) |
| API          | Hono + @hono/node-server + WebSocket  |
| Validation   | zod + @hono/zod-validator             |
| Frontend     | React + Vite + TailwindCSS            |
| Drag & Drop  | @dnd-kit                              |
| Server State | @tanstack/react-query                 |
| Agent SDK    | @anthropic-ai/claude-agent-sdk        |
| Scheduler    | node-cron                             |

## Docker

The project includes full Docker support (Angie reverse proxy + Node services).

### Development

```bash
docker compose up --build
```

Web UI at `localhost:5180`, API at `localhost:3009`.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Authentication: set `ANTHROPIC_API_KEY` in `.env`, or log in via `docker compose exec agent claude login` and then `docker compose restart` (see [Authentication](#authentication) above).

Only ports 80/443 are exposed. API is bound to localhost only. Includes security hardening (no-new-privileges, resource limits), healthchecks, log rotation, and automatic SSL via Let's Encrypt (ACME).

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

A `.devcontainer/` config is also included for JetBrains / VS Code.

## Scripts

| Command            | Description                                   |
| ------------------ | --------------------------------------------- |
| `npm run dev`      | Start all services with hot reload            |
| `npm run build`    | Build all packages                            |
| `npm test`         | Run all tests (Vitest)                        |
| `npm run init`     | Run AI Factory init and database setup        |
| `npm run aif:init` | Initialize AI Factory context in this project |
| `npm run db:setup` | Build shared package and initialize SQLite DB |
| `npm run db:push`  | Push schema changes via drizzle-kit           |

## Troubleshooting

If your workflow runs for too long and frequently times out, try disabling subagents in your environment:

```env
AGENT_USE_SUBAGENTS=false
```

If an LLM report says it lacks permissions for specific actions during workflow execution, either grant the required permissions in `.claude/settings.local.json` or bypass permission checks via environment variable:

```env
AGENT_BYPASS_PERMISSIONS=true
```

---

## Documentation

| Guide                                      | Description                              |
| ------------------------------------------ | ---------------------------------------- |
| [Getting Started](docs/getting-started.md) | Installation, setup, first steps         |
| [Architecture](docs/architecture.md)       | Agent pipeline, state machine, data flow |
| [API Reference](docs/api.md)               | REST endpoints, WebSocket events         |
| [Configuration](docs/configuration.md)     | Environment variables, logging, auth     |

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
