[← API Reference](api.md) · [Back to README](../README.md)

# Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Node packages (`@aif/api`, `@aif/agent`, `@aif/data`, `@aif/shared`) auto-load env from monorepo root at startup:

- `.env`
- `.env.local` (loaded after `.env`, overrides duplicate keys)

## Environment Variables

| Variable                           | Type    | Default                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                | string  | _(optional)_                   | Anthropic API key (x-api-key style auth). The Agent SDK uses `~/.claude/` credentials by default, so this is only needed if you want to use a separate key                                                                                                                                                                                                                                                                                                                                                      |
| `ANTHROPIC_AUTH_TOKEN`             | string  | _(optional)_                   | Alternative Anthropic-compatible bearer token (`Authorization: Bearer ...`) for proxy/custom backends                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ANTHROPIC_BASE_URL`               | string  | _(optional)_                   | Optional Anthropic-compatible proxy endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ANTHROPIC_MODEL`                  | string  | _(optional)_                   | Default Claude model alias/id used when runtime profile does not set `defaultModel` (for example `claude-sonnet-4-5`, `glm-4.5`)                                                                                                                                                                                                                                                                                                                                                                                |
| `OPENAI_API_KEY`                   | string  | _(optional)_                   | API key used by OpenAI-compatible runtime profiles (for example Codex/OpenAI adapters)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OPENAI_BASE_URL`                  | string  | _(optional)_                   | Default base URL for OpenAI-compatible runtime profiles                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `OPENAI_MODEL`                     | string  | _(optional)_                   | Default OpenAI/Codex model alias/id used when runtime profile does not set `defaultModel`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CODEX_CLI_PATH`                   | string  | _(optional)_                   | Absolute path to the Codex CLI binary used by CLI-based runtime adapters                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OPENROUTER_API_KEY`               | string  | _(optional)_                   | OpenRouter API key for the built-in OpenRouter adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `OPENROUTER_BASE_URL`              | string  | `https://openrouter.ai/api/v1` | Custom OpenRouter-compatible endpoint (for self-hosted proxies)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `OPENROUTER_MODEL`                 | string  | _(optional)_                   | Default OpenRouter model (e.g. `anthropic/claude-sonnet-4`) when profile does not set `defaultModel`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AIF_RUNTIME_MODULES`              | string  | _(optional)_                   | Comma-separated runtime module specifiers loaded at startup via `registerRuntimeModule(registry)`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PORT`                             | number  | `3009`                         | API server port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WEB_PORT`                         | number  | `5180`                         | Web UI dev server port (Vite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WEB_HOST`                         | string  | `localhost`                    | Web UI dev server host (Vite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POLL_INTERVAL_MS`                 | number  | `30000`                        | How often the agent coordinator polls for tasks (milliseconds)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AGENT_STAGE_STALE_TIMEOUT_MS`     | number  | `5400000`                      | Watchdog timeout for stale agent stages (planning/implementing/review) before auto-recovery is triggered                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AGENT_STAGE_STALE_MAX_RETRY`      | number  | `3`                            | Maximum automatic stale recoveries before task is quarantined in `blocked_external`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AGENT_STAGE_RUN_TIMEOUT_MS`       | number  | `3600000`                      | Per-stage hard timeout (planner/plan-checker/implementer/reviewer) before the coordinator treats it as failed                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AGENT_QUERY_START_TIMEOUT_MS`     | number  | `60000`                        | Timeout waiting for the first message from Claude query stream before treating startup as hung                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AGENT_QUERY_START_RETRY_DELAY_MS` | number  | `1000`                         | Delay before one automatic retry after `query_start_timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS`  | number  | `60000`                        | First-activity watchdog: if no tool call or subagent spawn arrives within this window after agent start, the agent is killed and restarted (up to 2 retries). Detects hung agents early instead of waiting for the 90-min stale timeout. Set to `0` to disable                                                                                                                                                                                                                                                  |
| `API_RUNTIME_START_TIMEOUT_MS`     | number  | `60000`                        | Timeout waiting for first output from API-triggered one-shot runtime calls (`0` disables)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `API_RUNTIME_RUN_TIMEOUT_MS`       | number  | `120000`                       | Hard timeout for API-triggered one-shot runtime calls such as roadmap/fast-fix/commit generation (`0` disables)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_URL`                     | string  | `./data/aif.sqlite`            | Path to the SQLite database file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AGENT_QUERY_AUDIT_ENABLED`        | boolean | `true`                         | Enable/disable writing agent query audit logs to `logs/*.log`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LOG_LEVEL`                        | string  | `debug`                        | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ACTIVITY_LOG_MODE`                | string  | `sync`                         | Activity logging strategy: `sync` (per-event DB write) or `batch` (buffered flush)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ACTIVITY_LOG_BATCH_SIZE`          | number  | `20`                           | Maximum entries per flush when in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ACTIVITY_LOG_BATCH_MAX_AGE_MS`    | number  | `5000`                         | Maximum age (ms) of buffered entries before auto-flush in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ACTIVITY_LOG_QUEUE_LIMIT`         | number  | `500`                          | Hard queue limit to prevent unbounded memory growth in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_WAKE_ENABLED`               | boolean | `true`                         | Enable event-driven coordinator wake via API WebSocket; set to `false` for polling-only mode                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `COORDINATOR_MAX_CONCURRENT_TASKS` | number  | `3`                            | Max concurrent tasks per stage for parallel-enabled projects. Non-parallel projects always process 1 task at a time regardless of this value. Range 1–10                                                                                                                                                                                                                                                                                                                                                        |
| `AGENT_BYPASS_PERMISSIONS`         | boolean | `true`                         | Provider-neutral bypass flag. When `true`, subagents run without approval prompts and without any OS-level sandbox. Each adapter translates per its native mechanism — Claude: `--dangerously-skip-permissions`; Codex: `approval_policy=never` + `sandbox_mode=danger-full-access`. When `false`, each adapter falls back to its safer default (Claude: `.claude/settings.json` allow rules; Codex: `approval_policy=on-request` + `sandbox_mode=workspace-write`). See `docs/providers.md` § Bypass semantics |
| `AGENT_USE_SUBAGENTS`              | boolean | `true`                         | Default for the per-task "Use subagents" setting. Each task can override this in Planner settings. `true`: custom agents (`plan-coordinator`, `implement-coordinator`, sidecars). `false`: `aif-plan`, `aif-implement`, `aif-review`, `aif-security-checklist` directly                                                                                                                                                                                                                                         |
| `AGENT_CHAT_MAX_TURNS`             | number  | `50`                           | Maximum turns (tool calls) per chat session before the runtime terminates. Increase for complex multi-file tasks                                                                                                                                                                                                                                                                                                                                                                                                |
| `TELEGRAM_BOT_API_URL`             | string  | `https://api.telegram.org`     | Optional Telegram Bot API base URL or proxy endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TELEGRAM_BOT_TOKEN`               | string  | _(optional)_                   | Telegram bot token for task status notifications (see [Telegram Notifications](#telegram-notifications))                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TELEGRAM_USER_ID`                 | string  | _(optional)_                   | Telegram user ID to receive notifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Environment validation is handled by Zod in `packages/shared/src/env.ts`. The application will fail to start with a descriptive error if required variables are invalid.

## Frontend Request Timeouts

The web UI (`@aif/web`) uses named timeout constants for HTTP requests to the API server. All constants are defined in `packages/web/src/lib/api.ts`:

| Constant                    | Value | Used By                 | Description                                           |
| --------------------------- | ----- | ----------------------- | ----------------------------------------------------- |
| `REQUEST_TIMEOUT_MS`        | 15s   | All CRUD endpoints      | Short timeout for standard read/write API calls       |
| `PLAN_FAST_FIX_TIMEOUT_MS`  | 200s  | `taskEvent("fast_fix")` | AI-driven plan fast fix (runtime resolves model/plan) |
| `CHAT_TIMEOUT_MS`           | 300s  | `sendChatMessage()`     | Chat with AI (long-running, multi-turn)               |
| `IMPORT_ROADMAP_TIMEOUT_MS` | 300s  | `importRoadmap()`       | Roadmap import (parses and creates tasks)             |

`COMMENT_TIMEOUT_MS` (30s) is defined locally in `useTaskDetailActions.ts` for comment creation and non-AI task events.

If a request exceeds its timeout, the browser aborts the fetch and the user sees a "Request timed out" error. The backend process may continue running independently.

## Authentication

Runtime profiles support provider-specific auth setup. Each adapter resolves credentials from its corresponding env vars:

1. **Claude adapter (SDK transport):** uses credentials from `~/.claude/` or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
2. **Codex adapter (CLI transport):** uses `OPENAI_API_KEY` (plus `OPENAI_BASE_URL` for custom endpoint).
3. **Codex adapter (API transport):** uses `OPENAI_API_KEY` + `OPENAI_BASE_URL` for remote execution.
4. **OpenRouter adapter (API transport):** uses `OPENROUTER_API_KEY` + `OPENROUTER_BASE_URL` (defaults to `https://openrouter.ai/api/v1`). Models use `provider/model` format.
5. **Custom adapters:** loaded via `AIF_RUNTIME_MODULES`, each adapter resolves its own env vars.

The default runtime can be changed via `AIF_DEFAULT_RUNTIME_ID` and `AIF_DEFAULT_PROVIDER_ID` (defaults: `claude` / `anthropic`).

Optional runtime defaults:

- `CODEX_CLI_PATH` for CLI transport adapters
- `AIF_RUNTIME_MODULES` for loading additional runtime modules at startup (`registerRuntimeModule(registry)`)
- `API_RUNTIME_START_TIMEOUT_MS` / `API_RUNTIME_RUN_TIMEOUT_MS` for API one-shot runtime calls

### Runtime Readiness Check

API exposes `GET /agent/readiness` to verify auth state at runtime:

- `ready=true`: runtime registry is available and at least one execution path is configured (enabled profile, usable auth, or Codex CLI path).
- `ready=false`: no usable runtime execution path detected.
- Response includes runtime descriptor list, enabled profile count, and auth source diagnostics.

## Runtime Profile Defaults

Runtime profiles are persisted in SQLite (`runtime_profiles`) and can be selected at three levels:

1. task override (`tasks.runtime_profile_id`)
2. project default (`projects.default_task_runtime_profile_id` / `default_chat_runtime_profile_id`)
3. optional system default used by runtime resolution services

Only non-secret fields are persisted (`baseUrl`, `apiKeyEnvVar`, headers/options metadata, default model). Secret values remain in environment variables or temporary validation payloads.

For concrete profile payloads and adapter capability differences, see [Providers](providers.md).

## Database

The database is a single SQLite file. The default path `./data/aif.sqlite` is relative to the project root.

Runtime DB access is centralized in `@aif/data`. `@aif/api` and `@aif/agent` are lint-restricted from importing DB helpers and SQL builders directly.

To use a different location:

```
DATABASE_URL=/absolute/path/to/database.sqlite
```

Initialize the schema with:

```bash
npm run db:setup
```

## Logging

Pino structured JSON logging is used throughout. Set `LOG_LEVEL` to control verbosity:

| Level   | Use Case                                                          |
| ------- | ----------------------------------------------------------------- |
| `trace` | Very verbose, includes all internal details                       |
| `debug` | Development default — shows DB queries, WS events, agent activity |
| `info`  | Production — key events only                                      |
| `warn`  | Warnings and deprecations                                         |
| `error` | Errors only                                                       |
| `fatal` | Application crashes                                               |

Each package creates a named logger:

```typescript
import { logger } from "@aif/shared";
const log = logger("my-module");
log.info({ key: "value" }, "Something happened");
```

Agent query audit logs are controlled by `AGENT_QUERY_AUDIT_ENABLED`. When enabled, query payloads are written to `logs/{agentName}.log` with rotation.

### Activity Logging

Activity logging tracks tool events during agent runs. Two modes are available:

- **`sync`** (default): Each tool event is written to the database immediately via `select+update`. Safe and simple but generates one DB write per event.
- **`batch`**: Tool events are buffered in memory and flushed in batches. Reduces DB write amplification at the cost of slight delay in log visibility. Flush triggers: batch size limit (`ACTIVITY_LOG_BATCH_SIZE`), max age timer (`ACTIVITY_LOG_BATCH_MAX_AGE_MS`), and explicit flush on stage boundaries/shutdown.

The queue is bounded by `ACTIVITY_LOG_QUEUE_LIMIT` to prevent unbounded memory growth — when the limit is reached, the oldest entries are dropped and a warning is logged.

## Agent Polling

The coordinator checks for actionable tasks every `POLL_INTERVAL_MS` milliseconds (default: 30 seconds). Lower values mean faster task processing but more CPU usage.

For development, 30 seconds is a good default. In production, adjust based on your workload.

### Query Startup Timeout

Subagent query startup has a dedicated guard:

- If no first stream message arrives within `AGENT_QUERY_START_TIMEOUT_MS`, the run is marked as `query_start_timeout`.
- The coordinator performs one automatic retry after `AGENT_QUERY_START_RETRY_DELAY_MS`.
- If the second attempt also times out, normal error handling applies (stage failure path).

### First-Activity Watchdog

After an agent starts (e.g. `implement-coordinator started`), the coordinator monitors for the first tool call or subagent spawn:

- If no tool activity arrives within `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` (default 60s), the agent process is killed immediately and restarted.
- Up to 2 automatic retries (3 attempts total). If all attempts stall, the task moves to `blocked_external` with backoff.
- Once the first tool call arrives, the watchdog disarms — subsequent tool gaps are not monitored.
- **SDK transport only.** CLI and API transports are opaque — the entire tool-calling cycle runs inside the subprocess or remote server, so no `onToolUse` callbacks are emitted. The watchdog is automatically disabled for these transports; they rely on `AGENT_STAGE_RUN_TIMEOUT_MS` for timeout protection.

### Stale Task Watchdog

The coordinator includes a stale-stage watchdog:

- Tracks task liveness via `lastHeartbeatAt` (falls back to `updatedAt` for older rows).
- Effective stale baseline uses the freshest of `lastHeartbeatAt` and `updatedAt`.
- If a task is stale in `planning`, `implementing`, or `review` for longer than `AGENT_STAGE_STALE_TIMEOUT_MS`, it is auto-moved to `blocked_external` with backoff.
- If stale recovery count reaches `AGENT_STAGE_STALE_MAX_RETRY`, the task stays in `blocked_external` without `retryAfter` (manual intervention required).
- For stale `implementing` tasks, recovery resumes from `plan_ready` to avoid half-broken implementation continuation.
- Any valid human/stage transition resets stale-retry debt (`retryCount=0`) and refreshes heartbeat baseline.

## Agent Permissions

Subagents (planner, implementer, reviewer) run shell commands during task execution. Permission behaviour is driven by the provider-neutral `AGENT_BYPASS_PERMISSIONS` env flag, which each runtime adapter translates into its native mechanism.

### Option 1: Bypass all permissions (simple)

`AGENT_BYPASS_PERMISSIONS=true` is the default. All tool calls are auto-approved without prompting and the OS sandbox is removed. Convenient for trusted environments and local development.

```
AGENT_BYPASS_PERMISSIONS=true
```

Per-adapter translation:

- **Claude (SDK/CLI):** `--dangerously-skip-permissions` — Claude has one safety axis (prompts); disabling it gives the agent full access.
- **Codex (SDK/CLI):** `approval_policy=never` + `sandbox_mode=danger-full-access` — Codex has two orthogonal axes (prompts + OS sandbox); both must be cleared to match Claude's "agent can do anything" behaviour. Leaving the sandbox at the default `workspace-write` would block network access (`npm install`, `curl`, `git push`).

See `docs/providers.md` § Bypass semantics for the full translation table and how to opt into narrower policies via profile-level `options.approvalPolicy` / `options.sandboxMode`.

### Option 2: Safer defaults (granular)

Set `AGENT_BYPASS_PERMISSIONS=false`. Each adapter then falls back to its safer default:

- **Claude:** permission mode `acceptEdits` (file edits auto-approved; Bash commands require allow rules). Configure via `.claude/settings.json` or `.claude/settings.local.json`:

  ```json
  {
    "permissions": {
      "allow": [
        "Bash(npm install:*)",
        "Bash(npm run:*)",
        "Bash(npm test:*)",
        "Bash(npx:*)",
        "Bash(git:*)"
      ]
    }
  }
  ```

  Unlisted commands will be denied in headless agent mode. See [Claude Code permissions docs](https://docs.anthropic.com/en/docs/claude-code/permissions) for the full rule syntax.

- **Codex:** `approval_policy=on-request` + `sandbox_mode=workspace-write` — the agent runs inside the workspace with network access disabled and escalates unknown actions for approval. Per-profile overrides (`options.approvalPolicy`, `options.sandboxMode`) always take precedence.

## Parallel Execution (Experimental)

By default, the coordinator processes one task at a time per project. Parallel execution allows multiple tasks to run concurrently for projects that opt in.

### Setup

1. Set the global concurrency cap in `.env`:

```
COORDINATOR_MAX_CONCURRENT_TASKS=3
```

2. Enable per-project in the web UI: open project settings and toggle **Parallel Execution**.

### How It Works

- The coordinator reads each task's project `parallelEnabled` flag to determine concurrency:
  - **Parallel off** (default): 1 task per project at a time — identical to serial behavior
  - **Parallel on**: up to `COORDINATOR_MAX_CONCURRENT_TASKS` tasks per project per stage
- `COORDINATOR_MAX_CONCURRENT_TASKS` is also the **global cap** on total concurrent tasks across all stages and projects. With the default of 3, at most 3 Claude agent processes run simultaneously regardless of how many parallel-enabled projects exist
- Tasks within a stage run concurrently via `Promise.allSettled` — a failure in one task does not block others
- Tasks are atomically claimed via `lockedBy` / `lockedUntil` columns to prevent duplicate picks
- Lock duration is tied to the stage timeout (`AGENT_STAGE_RUN_TIMEOUT_MS` + 5 min buffer). Heartbeats renew the lock periodically, so long-running stages keep their claim alive
- Stale claims are auto-released at the start of each poll cycle: expired TTL, or dead heartbeat (> 5 min with no update) on in-progress tasks
- On graceful shutdown (SIGINT/SIGTERM), all active task locks are released immediately

### Constraints

When parallel mode is enabled for a project, tasks are forced to `mode = full` (creates git branch/worktree per task) to ensure code isolation between concurrent agents. The UI disables mode selection and auto-generates unique plan file paths. The API enforces these constraints: creating a task in a parallel project auto-sets `plannerMode=full`, and updating to `fast` mode returns a 400 error.

### Monitoring

The coordinator logs concurrency state at `debug` level:

- `"Stage at capacity, skipping"` — stage has reached its concurrency limit
- `"Task claim failed (already claimed)"` — another poll cycle is already processing this task
- `"Task candidates selected"` with `candidateCount` — number of tasks picked for parallel processing

## Agent Budgets

Agent budgets are configured per project (API or Project edit dialog):

- `plannerMaxBudgetUsd`
- `planCheckerMaxBudgetUsd`
- `implementerMaxBudgetUsd`
- `reviewSidecarMaxBudgetUsd` (applies to each review/security sidecar)

If any of these values are not set, that agent runs without SDK budget limit.

## Telegram Notifications

Best-effort Telegram messages on task status changes. Add to `.env`:

```
TELEGRAM_BOT_API_URL=https://api.telegram.org
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=987654321
```

| Variable               | Type   | Default                    | Description                                                        |
| ---------------------- | ------ | -------------------------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_API_URL` | string | `https://api.telegram.org` | Telegram Bot API base URL or custom proxy endpoint                 |
| `TELEGRAM_BOT_TOKEN`   | string | _(optional)_               | Bot token from [@BotFather](https://t.me/BotFather)                |
| `TELEGRAM_USER_ID`     | string | _(optional)_               | Your Telegram user ID (the bot sends direct messages to this user) |

When both variables are set, every `task:moved` event sends a short message with the task title and status transition. If delivery fails (network error, invalid token, etc.), nothing breaks — failures are logged at `debug` level and silently ignored.

To get your user ID, message [@userinfobot](https://t.me/userinfobot) or any similar bot on Telegram.

## Project Config (config.yaml)

Per-project configuration is stored in `.ai-factory/config.yaml` at the project root. When present, its values override built-in defaults for artifact paths and workflow settings. When absent, the system uses hardcoded defaults transparently.

The config is editable via the **Global Settings** dialog in the web UI (gear icon in the header).

### Sections

**`language`** — controls AI-generated content language:

| Key               | Default | Options                                                    |
| ----------------- | ------- | ---------------------------------------------------------- |
| `ui`              | `en`    | `en`, `ru`, `de`, `fr`, `es`, `zh`, `ja`, `ko`, `pt`, `it` |
| `artifacts`       | `en`    | Same as `ui`                                               |
| `technical_terms` | `keep`  | `keep`, `translate`                                        |

**`paths`** — custom paths for AI Factory artifacts (relative to project root):

| Key            | Default                       |
| -------------- | ----------------------------- |
| `plan`         | `.ai-factory/PLAN.md`         |
| `plans`        | `.ai-factory/plans/`          |
| `fix_plan`     | `.ai-factory/FIX_PLAN.md`     |
| `roadmap`      | `.ai-factory/ROADMAP.md`      |
| `description`  | `.ai-factory/DESCRIPTION.md`  |
| `architecture` | `.ai-factory/ARCHITECTURE.md` |
| `docs`         | `docs/`                       |
| `rules_file`   | `.ai-factory/RULES.md`        |
| `references`   | `.ai-factory/references/`     |

**`workflow`** — controls AI Factory workflow behavior:

| Key                            | Default  | Options                       |
| ------------------------------ | -------- | ----------------------------- |
| `auto_create_dirs`             | `true`   | boolean                       |
| `plan_id_format`               | `slug`   | `slug`, `timestamp`, `uuid`   |
| `analyze_updates_architecture` | `true`   | boolean                       |
| `architecture_updates_roadmap` | `true`   | boolean                       |
| `verify_mode`                  | `normal` | `strict`, `normal`, `lenient` |

**`git`** — git-aware workflow settings:

| Key                      | Default    | Description                        |
| ------------------------ | ---------- | ---------------------------------- |
| `enabled`                | `true`     | Use git-aware workflows            |
| `base_branch`            | `main`     | Default branch for diff/review     |
| `create_branches`        | `true`     | Auto-create feature branches       |
| `branch_prefix`          | `feature/` | Prefix for branch names            |
| `skip_push_after_commit` | `false`    | Skip push prompt after /aif-commit |

### API Endpoints

| Method | Path                      | Description                                |
| ------ | ------------------------- | ------------------------------------------ |
| GET    | `/settings/config/status` | Check if config.yaml exists                |
| GET    | `/settings/config`        | Read parsed config as JSON                 |
| PUT    | `/settings/config`        | Write config (accepts JSON, saves as YAML) |
| GET    | `/projects/:id/defaults`  | Get resolved paths/workflow for a project  |

### How It Works

The `getProjectConfig(projectRoot)` utility in `@aif/shared` reads and caches config.yaml per project. All consumers (planner, implementer, task events, roadmap generation) call this function instead of using hardcoded paths. The cache is invalidated when the file's mtime changes.

## See Also

- [Getting Started](getting-started.md) — installation and first run
- [Architecture](architecture.md) — how the agent pipeline uses these settings
