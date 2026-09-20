[Back to README](../README.md) · [Architecture →](architecture.md)

# Getting Started

## Prerequisites

- **Docker** — Docker Desktop or compatible runtime
- **Node.js** 20.19+ or 22.12+ and **npm** 10+ — only needed if running without Docker
- **Claude Code CLI** — optional unless using the **CLI transport** without Docker (`npm i -g @anthropic-ai/claude-code`, version `>= 2.1.191`). The default SDK transport uses the Claude Code binary **bundled with `@anthropic-ai/claude-agent-sdk`** (currently `2.1.220`), so no global install is required for it; the runtime enforces `>= 2.1.191` and fails fast with `CLAUDE_VERSION_UNSUPPORTED` against an incompatible binary (older builds reject the empty attribution strings used to suppress Co-Authored-By trailers and crash at startup)
- **Claude subscription** or Anthropic API key (for agent features)

## Quick Start with Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff

# 1. Prepare environment
cp .env.example .env       # required: docker-compose.yml uses `env_file: .env`
mkdir -p projects          # default PROJECTS_DIR - must exist before first
                           # `docker compose up`, otherwise Docker creates it
                           # as root and the container user cannot write to it

# 2. Bring the stack up
docker compose up --build

# 3. Authenticate Claude (one-time, see Docker Authentication below)
docker compose exec agent claude login
docker compose restart agent
```

This builds and starts API (port 3009), Web UI (port 5180), Agent, and MCP (port 3100) in one command. Uses Angie as a reverse proxy — Web UI at `localhost:5180` proxies all API and WebSocket requests automatically.

SQLite database and auth state are persisted in Docker volumes. Project files
live in the host `PROJECTS_DIR` bind mount.

### Docker Project Paths

When you create a project in the UI, the **Root Path** field accepts an absolute
path such as `/Users/me/projects/my-project`. The dev compose mounts the host
directory `PROJECTS_DIR` at `PROJECTS_MOUNT` (default `/home/www`) in every
container. With `PROJECTS_DIR=/Users/me/projects`, the example path is persisted
as `/home/www/my-project`.

Other POSIX absolute paths are resolved below `PROJECTS_MOUNT` instead of the
container filesystem root.

The default `PROJECTS_DIR` is `${PWD}/projects`, relative to the compose file.
To use a different host directory:

```bash
PROJECTS_DIR=/srv/aif-projects docker compose up --build
```

Create the host directory before `docker compose up`. If the bind-mount target
is missing, Docker creates it as root-owned and the container's `node` user
cannot write project files there.

### Resetting Docker State

Containers persist data in named Docker volumes (`db-data`, `claude-auth`,
`codex-auth`):

```bash
docker compose down       # stops containers, keeps database and auth state
docker compose down -v    # also removes named volumes - fresh slate
                          # (you will need to `claude login` again)
```

Project files in `PROJECTS_DIR` live on the host filesystem and are not deleted
by `down -v`. Remove them manually if you need to reset project files too.

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

| Variable             | Default      | Description                                                  |
| -------------------- | ------------ | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | —            | API key (or use `claude login`)                              |
| `DOMAIN`             | `localhost`  | Domain for SSL certificate (ACME)                            |
| `PORT`               | `3009`       | Host port for API                                            |
| `WEB_PORT`           | `5180`       | Host port for Web UI (dev)                                   |
| `WEB_HOST`           | `localhost`  | Web UI dev server host (Vite)                                |
| `HTTP_PORT`          | `80`         | Host port for Web UI (production)                            |
| `HTTPS_PORT`         | `443`        | HTTPS port (production)                                      |
| `PROJECTS_DIR`       | `./projects` | Host directory for project files (dev)                       |
| `PROJECTS_MOUNT`     | `/home/www`  | Project files path inside containers                         |
| `PROJECTS_HOST_ROOT` | `${PWD}`     | Compose-internal repo root for relative `PROJECTS_DIR` (dev) |
| `CODEX_VERSION`      | `0.145.0`    | npm selector used to install Codex SDK and CLI during build  |

When running the dev Docker Compose setup, `PROJECTS_DIR` is the host directory
mounted into the containers at `PROJECTS_MOUNT`. Paths outside that mount are
resolved below it instead of the container filesystem root. Host paths under
`PROJECTS_DIR` are translated to the same container mount, so
`/Users/me/projects/my-project` becomes `/home/www/my-project` when
`PROJECTS_DIR=/Users/me/projects`. Relative `PROJECTS_DIR` values are resolved
from `PROJECTS_HOST_ROOT`, which `docker-compose.yml` sets from the repository
directory; leave it unset unless you are replacing the compose wiring.

Production Compose uses a named Docker volume at `PROJECTS_MOUNT` instead of
the dev bind mount. Portable paths use the same resolution in production.

`CODEX_VERSION` accepts npm dist-tags, exact versions, and semver ranges. The
reviewed `0.145.0` baseline is used by default. The SDK and its matching CLI
dependency are resolved together during the Docker build. Use `docker compose
build --no-cache` when a moving selector such as `latest` must be refreshed
despite the Docker layer cache.

## Installation without Docker

```bash
npm i -g @anthropic-ai/claude-code@latest   # optional — only for the CLI transport (>= 2.1.191); the SDK transport uses the binary bundled with @anthropic-ai/claude-agent-sdk
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

`npm run dev`, `api`, and `agent` automatically read env from root `.env` (`.env.local` overrides when present), so no extra export step is required.

| Variable                          | Default             | Description                                                                                              |
| --------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`               | _(optional)_        | API key. Agent SDK uses `~/.claude/` auth by default                                                     |
| `PORT`                            | `3009`              | API server port                                                                                          |
| `MCP_PORT`                        | _(optional)_        | When set to a valid integer port (`1-65535`), `npm run dev` also starts the MCP HTTP server on this port |
| `WEB_PORT`                        | `5180`              | Web UI dev server port                                                                                   |
| `WEB_HOST`                        | `localhost`         | Web UI dev server host                                                                                   |
| `POLL_INTERVAL_MS`                | `30000`             | Agent coordinator polling interval (ms)                                                                  |
| `AGENT_STAGE_STALE_TIMEOUT_MS`    | `5400000`           | Stale-stage watchdog timeout (ms) before auto-recovery                                                   |
| `AGENT_STAGE_STALE_MAX_RETRY`     | `3`                 | Max stale auto-recover attempts before quarantine in `blocked_external`                                  |
| `AGENT_STAGE_RUN_TIMEOUT_MS`      | `3600000`           | Per-stage timeout (ms) before coordinator marks run as failed                                            |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` | `60000`             | First-activity watchdog: kill + restart agent if no tool call within this window after start             |
| `API_RUNTIME_START_TIMEOUT_MS`    | `60000`             | Timeout waiting for first output from API one-shot runtime calls                                         |
| `API_RUNTIME_RUN_TIMEOUT_MS`      | `120000`            | Hard timeout for API one-shot runtime calls                                                              |
| `AGENT_USE_SUBAGENTS`             | `false`             | Default for per-task "Use subagents" toggle. `true`: custom subagents, `false`: aif-\* skills            |
| `DATABASE_URL`                    | `./data/aif.sqlite` | SQLite database path                                                                                     |
| `AGENT_QUERY_AUDIT_ENABLED`       | `true`              | Enable/disable query audit logs in `logs/*.log`                                                          |
| `LOG_LEVEL`                       | `debug`             | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`                                            |
| `ACTIVITY_LOG_MODE`               | `sync`              | Activity logging strategy: `sync` or `batch`                                                             |

You can set planner/plan-checker/implementer/review budgets per project in the project edit dialog. Leave any budget field empty for unlimited.

See [Configuration](configuration.md) for details.

## Participants Mode

Participants Mode is off by default. With the flag unset or `false`, the UI and API keep
the existing anonymous behavior and existing/new tasks default to AI ownership.

1. Add the following to `.env` (the origin must match the browser origin exactly):

   ```dotenv
   PARTICIPANTS_MODE_ENABLED=true
   PARTICIPANT_ALLOWED_ORIGINS=http://localhost:5180
   ```

2. Bootstrap the first administrator interactively before sharing the UI:

   ```bash
   npm run participants:bootstrap
   ```

   The command prompts for identity fields and reads the password plus confirmation without
   echoing them. Passwords must contain at least 12 characters. `--password` and password
   values on the command line are rejected so they cannot leak through shell history or
   process listings. For automation, use protected stdin or a mode-`0600` password file.

   ```bash
   chmod 600 /secure/path/admin-password
   npm run participants:bootstrap -- --username admin --display-name "Workspace Admin" --password-file /secure/path/admin-password
   ```

3. For Docker, feed the protected host file through stdin to the API container:

   ```bash
   docker compose exec -T api npm run participants:bootstrap -- --username admin --display-name "Workspace Admin" --password-stdin < /secure/path/admin-password
   ```

4. Start or restart the stack and sign in at the web URL. Administrators can create,
   deactivate, rename, change roles, and reset passwords from the participant menu.
   Every participant can replace a temporary password through their identity menu's
   **Change password** action; the current password is required and other sessions are signed out.

Flag-based bootstrap is idempotent only when the requested active admin already exists. Once any
participant exists, the command refuses to create another account; use the authenticated
admin UI/API instead. The final active administrator cannot be deactivated or demoted.
If every administrator credential is lost, restore a database backup; bootstrap is not a
break-glass password reset.

Human/AI ownership is separate from `autoMode`. Human-owned tasks never enter coordinator,
scheduler, auto-queue, watchdog, or runtime-budget execution paths. A handoff is rejected
while an AI lease is live, but ownership is not filesystem isolation: wait for in-flight
work to finish and inspect the shared project/worktree before editing it manually.

## Running

Start all services with hot reload:

```bash
npm run dev
```

This runs three processes in parallel via Turborepo by default. If `MCP_PORT` is set to a valid integer port, it starts a fourth process for MCP over HTTP. Invalid values are ignored here and the local MCP install flow falls back to `stdio`.

| Service   | URL                         | Description                                               |
| --------- | --------------------------- | --------------------------------------------------------- |
| **API**   | `http://localhost:3009`     | REST + WebSocket server                                   |
| **Web**   | `http://localhost:5180`     | Kanban board UI                                           |
| **Agent** | _(background)_              | Polls every 30s + event-driven wake, dispatches subagents |
| **MCP**   | `http://localhost:3100/mcp` | Optional MCP HTTP endpoint                                |

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
