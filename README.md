![logo](https://github.com/lee-to/aif-handoff/blob/main/art/promo.jpg)

# AIF Handoff

> Autonomous Kanban board where AI agents plan, implement, and review your tasks — fully hands-off.

> This project was built using [AI Factory](https://github.com/lee-to/ai-factory) — an open-source framework for AI-driven development.

Built on top of [AI Factory](https://github.com/lee-to/ai-factory) workflow and powered by runtime profiles through `@aif/runtime` (Claude and Codex adapters included). Tasks flow through stages automatically: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — each stage orchestrated by specialized AI subagents following the AIF methodology. Skills-mode tasks can optionally add **Improve** after planning and **Verify** before done. In auto mode, review feedback can also trigger an automatic rework loop: **Review → request_changes → Implementing**. When that loop stops converging, the task is handed off explicitly as **Done + manual review required** instead of silently passing.

Auto-review is now convergence-aware. You can keep the default `full_re_review` loop or switch to `closure_first` via `AGENT_AUTO_REVIEW_STRATEGY`. When auto-review no longer converges, the task moves to `done` with `manualReviewRequired=true`, and the UI surfaces that explicit human handoff instead of silently treating the review as passed.

## Runtime Providers Out of the Box

Use the runtime that fits your stack today, then switch per project/task without changing orchestration logic:

- **Claude (`anthropic`)** — SDK, CLI, API transports
- **Codex (`openai`)** — SDK, CLI, App Server, API transports
- **OpenRouter (`openrouter`)** — API transport
- **OpenCode (`opencode`)** — API transport

> **⚠️ Warning:** Anthropic prohibits using Claude Max / Pro subscriptions outside of the official Claude Code CLI. The SDK transport for Claude calls the Agent SDK directly, which may violate these terms. If you're worried about your subscription getting blocked, use the **CLI transport** — it runs through the official Claude Code CLI and is safe to use on a Max / Pro subscription. Use the SDK transport at your own risk, or switch to the API transport with an `ANTHROPIC_API_KEY` for production use.

Need something custom? Add your own runtime adapter module and load it at startup via `AIF_RUNTIME_MODULES` (comma-separated module specifiers). No fork required.

## Key Features

- **Fully autonomous pipeline** — create a task, AI plans, implements, and reviews it
- **Beautiful Kanban UI** — drag-and-drop board with real-time WebSocket updates
- **AI Factory core** — built on [ai-factory](https://github.com/lee-to/ai-factory) agent definitions and skill system
- **Subagent orchestration** — plan-coordinator, implement-coordinator, review + security sidecars
- **Runtime/provider modularity** — runtime registry, global/project/task runtime profile selection, and provider-specific capability gating
- **Layer-aware execution** — implementer computes dependency layers and enforces parallel worker dispatch where possible
- **Self-healing pipeline** — heartbeat + stale-stage watchdog auto-recovers stuck agent stages
- **Human-in-the-loop** — approve plans, request changes, or let auto-mode handle everything
- **Participants Mode** — optional local accounts, role-aware collaboration, and explicit Human/AI task ownership
- **GitHub Issue-to-PR mode** — opt-in issue import, isolated implementation, and one human-merged PR per task
- **MCP sync** — bidirectional task sync between Handoff and AIF tools via Model Context Protocol

## Quick Start

### Without Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
nvm use            # pick Node version from .nvmrc (requires Node 20.19+ or 22.12+)
cp .env.example .env
npm install
npm run init
npm run dev
```

> **If you switch Node between runs** (for example via `nvm use`), run
> `npm rebuild better-sqlite3` after the switch. The native binary is bound
> to `NODE_MODULE_VERSION`, and without a rebuild the API will crash with
> `ERR_DLOPEN_FAILED`, which surfaces as a **502 Bad Gateway** in the Vite
> UI. From this version onward, `npm run dev` detects this case at startup
> and prints the exact rebuild command.

Set `MCP_PORT` in your shell or root `.env` before `npm run dev` if you also want the MCP HTTP server in local development. Use an integer port between `1` and `65535`; invalid values are ignored by the dev launcher and the settings install route falls back to the local `stdio` entry instead of writing an HTTP MCP endpoint.

> **`ai-factory` is a required runtime dependency**, not an optional plugin. The agent uses
> the `ai-factory` CLI to scaffold `.ai-factory/` inside every project you create through the
> UI. It is declared in the root `package.json` and is installed automatically by `npm install`.
> If you install with `npm ci --omit=dev` or `NODE_ENV=production npm install`, make sure
> `ai-factory` ends up in `node_modules/` — otherwise the agent falls back to `npx ai-factory ...`
> at task-run time, which requires network access to the npm registry. The agent logs a clear
> warning at boot when the CLI is not resolvable.

### With Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff

# 1. Prepare environment
cp .env.example .env       # required: docker-compose.yml uses `env_file: .env`
mkdir -p projects          # default PROJECTS_DIR — must exist before first
                           # `docker compose up`, otherwise Docker creates it
                           # as root and the container user cannot write to it

# 2. Bring the stack up
docker compose up --build

# 3. Authenticate Claude (one-time, see Authentication below for details)
docker compose exec agent claude login
docker compose restart agent
```

Docker resolves the Codex SDK and CLI during the image build. `CODEX_VERSION`
defaults to the reviewed `0.145.0` baseline and also accepts an npm dist-tag,
exact version, or semver range as an explicit override. When using a moving
selector, rebuild with `docker compose build --no-cache` to force a fresh
registry lookup. Verify the result with `docker compose exec agent codex
--version`.

Development starts three services by default. If `MCP_PORT` is set to a valid integer port, it starts a fourth service for MCP over HTTP. Docker starts all four services.

#### Project paths (host ↔ container)

When you create a project in the UI, the **Root Path** field accepts an absolute
path such as `/Users/me/projects/my-project`. The dev compose mounts the host
directory `PROJECTS_DIR` at `PROJECTS_MOUNT` (default `/home/www`) in every
container. With `PROJECTS_DIR=/Users/me/projects`, the example path is persisted
as `/home/www/my-project`.

Other POSIX absolute paths are resolved below `PROJECTS_MOUNT` instead of the
container filesystem root.

The default `PROJECTS_DIR` is `${PWD}/projects` (relative to the compose
file). To use a different host directory:

```bash
PROJECTS_DIR=/srv/aif-projects docker compose up --build
```

The directory must exist on the host before `docker compose up` —
Docker creates missing bind-mount targets as root-owned, which makes
them unwritable from the container's `node` user.

#### Resetting state

Containers persist data in named Docker volumes (`db-data`, `claude-auth`,
`codex-auth`):

```bash
docker compose down       # stops containers, keeps the database and auth state
docker compose down -v    # also removes named volumes — fresh slate
                          # (you will need to `claude login` again)
```

Project files in `PROJECTS_DIR` live on the host filesystem and are
never deleted by `down -v` — remove them manually if needed.

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

For Codex/OpenAI-compatible profiles, configure `OPENAI_API_KEY` and optionally `OPENAI_BASE_URL` (or set profile-level `apiKeyEnvVar` / `baseUrl`). For local Codex runs without API keys, prefer `transport: "app-server"` or `transport: "cli"` and authenticate via `codex login`. See [Providers](docs/providers.md).

#### Participants Mode

Local participant authentication is opt-in and disabled by default. To enable it, set
`PARTICIPANTS_MODE_ENABLED=true`, configure the exact browser origin in
`PARTICIPANT_ALLOWED_ORIGINS`, bootstrap the first administrator interactively, and
then start the stack. Existing installations
remain anonymous and AI-owned while the flag is off.

```bash
npm run participants:bootstrap
```

The command prompts for the username, display name, and a hidden password with
confirmation. Protected stdin and mode-`0600` password-file flags remain available for automation.
After sign-in, every participant can change their own password from the identity menu.

Human/AI ownership is independent from `autoMode`: ownership selects who is responsible
for execution, while auto mode controls AI approval gates. See
[Getting Started](docs/getting-started.md#participants-mode) and
[Configuration](docs/configuration.md#participants-mode) for native/Docker bootstrap,
session security, roles, and recovery.

#### Codex OAuth in Docker (without `OPENAI_API_KEY`)

The dev compose wires up a small in-container broker that runs
`codex login --device-auth` and exposes a guided UI in
**Settings → Runtime profile → Codex**:

1. Click **Start Codex login**. The broker spawns the CLI and reads back a
   verification URL plus a one-time code.
2. Open the verification page in your browser, enter the code, and complete
   ChatGPT sign-in.
3. The CLI exits 0 once ChatGPT confirms and writes `~/.codex/auth.json` to
   the persistent `codex-auth` volume. The wizard flips to success
   automatically (status polled every second).
4. Run `docker compose restart agent` to pick up the credentials.

**Production note:** the broker is **dev-only**. `docker-compose.production.yml`
sets `AIF_ENABLE_CODEX_LOGIN_PROXY=false`. For production, configure
`OPENAI_API_KEY` in `.env` instead.

### Runtime Defaults

Runtime profiles can now be managed at two scopes:

- **Global profiles** live in Global Settings and can be reused across every project
- **Project profiles** stay local to a single project

Effective runtime resolution follows this order:

1. task override
2. project default
3. app default
4. environment fallback

Planning and review keep their own defaults, but when those are unset they inherit from the task default at the same scope. Chat has its own dedicated project/app default chain.

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
| Planning → Improve → Plan Ready                                                                  | `/aif-improve`                                                            | Optional for skills-mode tasks (`useSubagents=false`) when `runPlanImprove=true`                                                             |
| Plan Ready → Implementing → Review                                                               | `implement-coordinator`                                                   | Parallel task execution with worktrees + quality sidecars                                                                                    |
| Implementing → Verify → Review / Done                                                            | `/aif-verify`                                                             | Optional for skills-mode tasks (`useSubagents=false`) when `runPostVerify=true`; moves to Done when `skipReview=true`                        |
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
| **Skills**    | `false` (default)     | Each stage runs as AIF skills (`/aif-plan`, optional `/aif-improve`, `/aif-implement`, `/aif-review`, `/aif-security-checklist`, optional `/aif-verify`)                                                      | Faster execution with lower token usage; optional improve/verify flags add extra plan and implementation checks when needed                                          |

## Tech Stack

| Layer        | Technology                                                               |
| ------------ | ------------------------------------------------------------------------ |
| Runtime      | Node.js + TypeScript                                                     |
| Monorepo     | Turborepo                                                                |
| Database     | SQLite (better-sqlite3 + drizzle-orm)                                    |
| API          | Hono + @hono/node-server + WebSocket                                     |
| Validation   | zod + @hono/zod-validator                                                |
| Frontend     | React + Vite + TailwindCSS                                               |
| Drag & Drop  | @dnd-kit                                                                 |
| Server State | @tanstack/react-query                                                    |
| Runtime SDKs | Pluggable adapters — Claude (Agent SDK) + Codex (CLI/SDK/App Server/API) |
| Scheduler    | node-cron                                                                |

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

| Variable             | Default      | Description                                                  |
| -------------------- | ------------ | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | —            | API key (or use `claude login`)                              |
| `DOMAIN`             | `localhost`  | Domain for SSL certificate (ACME)                            |
| `PORT`               | `3009`       | Host port for API                                            |
| `MCP_PORT`           | `3100`       | Host port for MCP HTTP server (`1-65535`)                    |
| `WEB_PORT`           | `5180`       | Host port for Web UI (dev)                                   |
| `WEB_HOST`           | `localhost`  | Web UI dev server host (Vite)                                |
| `HTTP_PORT`          | `80`         | Host port for Web UI (production)                            |
| `HTTPS_PORT`         | `443`        | HTTPS port (production)                                      |
| `PROJECTS_DIR`       | `./projects` | Host directory for project files (dev)                       |
| `PROJECTS_MOUNT`     | `/home/www`  | Project files path inside containers                         |
| `PROJECTS_HOST_ROOT` | `${PWD}`     | Compose-internal repo root for relative `PROJECTS_DIR` (dev) |

In Docker, paths outside `PROJECTS_MOUNT` are resolved below that mount instead
of the container filesystem root. In the dev Compose setup, host paths under
`PROJECTS_DIR` are automatically saved as the matching `PROJECTS_MOUNT` path,
so `/Users/me/projects/my-project` becomes `/home/www/my-project` when
`PROJECTS_DIR=/Users/me/projects`. If `PROJECTS_DIR` is relative, Compose
resolves it from `PROJECTS_HOST_ROOT`; leave `PROJECTS_HOST_ROOT` unset unless
you are replacing the compose wiring.

Production Compose uses a named Docker volume at `PROJECTS_MOUNT` instead of
the dev bind mount. Portable paths use the same resolution in production.

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
| [MCP Sync](docs/mcp-sync.md)               | MCP tools, transports, and authentication     |

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
