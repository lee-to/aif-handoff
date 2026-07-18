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

| Variable                                               | Type    | Default                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                                    | string  | _(optional)_                   | Anthropic API key (x-api-key style auth). The Agent SDK uses `~/.claude/` credentials by default, so this is only needed if you want to use a separate key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ANTHROPIC_AUTH_TOKEN`                                 | string  | _(optional)_                   | Alternative Anthropic-compatible bearer token (`Authorization: Bearer ...`) for proxy/custom backends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ANTHROPIC_BASE_URL`                                   | string  | _(optional)_                   | Optional Anthropic-compatible proxy endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ANTHROPIC_MODEL`                                      | string  | _(optional)_                   | Default Claude model alias/id used when runtime profile does not set `defaultModel` (for example `claude-sonnet-4-5`, `glm-4.5`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OPENAI_API_KEY`                                       | string  | _(optional)_                   | API key for the Codex **API** transport and OpenAI-compatible profiles. Local Codex transports (SDK/CLI/App Server) do **not** consume it implicitly — they default to `codex login` / OAuth. Opt a local transport into API-key auth via the profile's `apiKeyEnvVar`/`apiKey`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OPENAI_BASE_URL`                                      | string  | _(optional)_                   | Base URL for the Codex **API** transport and OpenAI-compatible profiles. Ignored by local Codex transports — use the profile `baseUrl` or `CODEX_BASE_URL` for a custom local Codex endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `OPENAI_MODEL`                                         | string  | _(optional)_                   | Default OpenAI/Codex model alias/id used when runtime profile does not set `defaultModel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CODEX_BASE_URL`                                       | string  | _(optional)_                   | Custom backend endpoint for local Codex transports (SDK/CLI/App Server). Used only when the profile does not set `baseUrl`; `OPENAI_BASE_URL` is not inferred for local transports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CODEX_CLI_PATH`                                       | string  | _(optional)_                   | Absolute path to the Codex CLI binary, or a safe shim name, used by Codex CLI/App Server runtime adapters. On Windows, App Server rejects values containing shell metacharacters rather than treating them as command snippets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `HTTP_PROXY` / `http_proxy`                            | string  | _(optional)_                   | HTTP proxy for `http://` runtime API requests and child runtime processes. `ALL_PROXY` is used as fallback when protocol-specific proxy variables are unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HTTPS_PROXY` / `https_proxy`                          | string  | _(optional)_                   | HTTP proxy for `https://` runtime API requests and child runtime processes. `ALL_PROXY` is used as fallback when protocol-specific proxy variables are unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ALL_PROXY` / `all_proxy`                              | string  | _(optional)_                   | Fallback proxy for runtime API requests and child runtime processes. API transports support `http://`, `https://`, and `socks5://` proxy URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `NO_PROXY` / `no_proxy`                                | string  | _(optional)_                   | Comma-separated proxy bypass list. Include local endpoints such as `localhost,127.0.0.1,::1`; Docker deployments should also include service names such as `api,agent,web,mcp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OPENROUTER_API_KEY`                                   | string  | _(optional)_                   | OpenRouter API key for the built-in OpenRouter adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OPENROUTER_BASE_URL`                                  | string  | `https://openrouter.ai/api/v1` | Custom OpenRouter-compatible endpoint (for self-hosted proxies)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OPENROUTER_MODEL`                                     | string  | _(optional)_                   | Default OpenRouter model (e.g. `anthropic/claude-sonnet-4`) when profile does not set `defaultModel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AIF_RUNTIME_MODULES`                                  | string  | _(optional)_                   | Comma-separated runtime module specifiers loaded at startup via `registerRuntimeModule(registry)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PORT`                                                 | number  | `3009`                         | API server port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WEB_PORT`                                             | number  | `5180`                         | Web UI dev server port (Vite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WEB_HOST`                                             | string  | `localhost`                    | Web UI dev server host (Vite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POLL_INTERVAL_MS`                                     | number  | `30000`                        | How often the agent coordinator polls for tasks (milliseconds)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_STAGE_STALE_TIMEOUT_MS`                         | number  | `5400000`                      | Watchdog timeout for stale agent stages (planning/implementing/review) before auto-recovery is triggered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AGENT_STAGE_STALE_MAX_RETRY`                          | number  | `3`                            | Maximum automatic stale recoveries before task is quarantined in `blocked_external`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_STAGE_RUN_TIMEOUT_MS`                           | number  | `3600000`                      | Per-stage hard timeout (planner/plan-checker/implementer/reviewer) before the coordinator treats it as failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AGENT_QUERY_START_TIMEOUT_MS`                         | number  | `60000`                        | Timeout waiting for the first message from Claude query stream before treating startup as hung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_QUERY_START_RETRY_DELAY_MS`                     | number  | `1000`                         | Delay before one automatic retry after `query_start_timeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS`                      | number  | `60000`                        | First-activity watchdog: if no tool call or subagent spawn arrives within this window after agent start, the agent is killed and restarted (up to 2 retries). Detects hung agents early instead of waiting for the 90-min stale timeout. Set to `0` to disable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `API_RUNTIME_START_TIMEOUT_MS`                         | number  | `60000`                        | Timeout waiting for first output from API-triggered one-shot runtime calls (`0` disables)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `API_RUNTIME_RUN_TIMEOUT_MS`                           | number  | `120000`                       | Hard timeout for API-triggered one-shot runtime calls such as roadmap/fast-fix/commit generation (`0` disables)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DATABASE_URL`                                         | string  | `./data/aif.sqlite`            | Path to the SQLite database file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AGENT_QUERY_AUDIT_ENABLED`                            | boolean | `true`                         | Enable/disable writing agent query audit logs to `logs/*.log`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOG_LEVEL`                                            | string  | `debug`                        | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ACTIVITY_LOG_MODE`                                    | string  | `sync`                         | Activity logging strategy: `sync` (per-event DB write) or `batch` (buffered flush)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ACTIVITY_LOG_BATCH_SIZE`                              | number  | `20`                           | Maximum entries per flush when in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ACTIVITY_LOG_BATCH_MAX_AGE_MS`                        | number  | `5000`                         | Maximum age (ms) of buffered entries before auto-flush in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ACTIVITY_LOG_QUEUE_LIMIT`                             | number  | `500`                          | Hard queue limit to prevent unbounded memory growth in batch mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AGENT_WAKE_ENABLED`                                   | boolean | `true`                         | Enable event-driven coordinator wake via API WebSocket; set to `false` for polling-only mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `COORDINATOR_MAX_CONCURRENT_TASKS`                     | number  | `12`                           | Global safety ceiling for concurrent coordinator tasks across all project lanes and stages. Range 1–100                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT`         | number  | `3`                            | Max concurrent tasks per stage within one parallel-enabled project. Non-parallel projects always process 1 task at a time regardless of this value. Range 1–10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `COORDINATOR_MAX_CONCURRENT_PROJECTS`                  | number  | `4`                            | Max independent project lanes the coordinator processes in one poll cycle. Different project lanes run concurrently; stage ordering remains sequential inside each lane. Range 1–10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AIF_TASK_WORKTREES_ENABLED`                           | boolean | `false`                        | Off-by-default rollout flag for per-task git worktrees. When `false`, branch-isolated projects (`git.create_branches=true`) stay serial and the API rejects parallel auto-queue for those projects. When `true`, full-mode planning for parallel branch-isolated projects provisions an isolated sibling git worktree and stores it on `tasks.worktree_path`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AIF_RUNTIME_SESSION_FORK_ENABLED`                     | boolean | `false`                        | Off-by-default rollout flag for runtime session forks. When `false`, adapters keep `supportsSessionFork=false` in descriptor/effective capabilities even if the transport implementation exists. When `true`, fork-capable transports expose `supportsSessionFork=true` so warmup callers can opt into `forkSession()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AIF_STAGE_RUNTIME_PIN_ENABLED`                        | boolean | `false`                        | Off-by-default rollout flag for stage-scoped task runtime-selection pins. When `false`, every subagent execution resolves the effective runtime profile normally and skips task pin lookup/persistence. When `true`, the agent stores the runtime/profile/model/options chosen at the start of a task status and reuses them for same-status retries until the task advances or a human transition clears the pin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED`           | boolean | `false`                        | Off-by-default rollout flag for Codex SDK native subagents. When `false`, Codex `native_subagents` workflows fall back to isolated `$aif-*` skill-session execution even if the profile requests `codexSubagentStrategy: "native"`. When `true`, Codex may use native subagents only for SDK profiles with required `.codex/agents/*.toml` and `.codex/config.toml` assets present; missing assets still fall back to isolated mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED` | boolean | `false`                        | Off-by-default rollout flag for long-running OpenCode API session messages. When `false`, OpenCode `/session/:id/message` uses the default fetch behavior. When `true`, that message POST uses an undici dispatcher with disabled header/body idle timeouts while the adapter AbortController timeout remains authoritative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AGENT_BYPASS_PERMISSIONS`                             | boolean | `true`                         | Provider-neutral bypass flag. When `true`, subagents run without approval prompts and without any OS-level sandbox. Each adapter translates per its native mechanism — Claude: `--dangerously-skip-permissions`; Codex: `approval_policy=never` + `sandbox_mode=danger-full-access`. When `false`, each adapter falls back to its safer default (Claude: `.claude/settings.json` allow rules; Codex: `approval_policy=on-request` + `sandbox_mode=workspace-write`). See `docs/providers.md` § Bypass semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AGENT_USE_SUBAGENTS`                                  | boolean | `false`                        | Default for the per-task "Use subagents" setting. Each task can override this in Planner settings. `true`: custom agents (`plan-coordinator`, `implement-coordinator`, sidecars). `false`: `aif-plan`, `aif-implement`, `aif-review`, `aif-security-checklist` directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AGENT_AUTO_REVIEW_STRATEGY`                           | string  | `full_re_review`               | Global auto-review convergence strategy. `full_re_review`: every review cycle may trigger another automatic rework when blockers remain. `closure_first`: automatic rework is limited to unresolved previous blockers; newly discovered blockers after closure force explicit manual review handoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_CHAT_MAX_TURNS`                                 | number  | `50`                           | Maximum turns (tool calls) per chat session before the runtime terminates. Increase for complex multi-file tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AIF_USAGE_LIMITS_ENABLED`                             | boolean | `false`                        | Master switch for the usage-limits feature. When `false` (default): `/runtime-profiles` skips Codex indexed-head overlay refresh and the Claude provider-identity lookup; the runtime service skips `observeRuntimeLimitEvent` / `extractLatestRuntimeLimitSnapshot` / `extractRuntimeLimitSnapshotFromError` during every runtime run; the WebSocket `project:runtime_limit_updated` broadcast is suppressed; the agent's stage error handler does not persist `limitSnapshot` onto tasks; the chat API omits `runtimeLimitSnapshot` from responses; and the web UI hides all 5 usage-limit surfaces (USAGE button in Header, TaskCard badge, TaskDetailHeader badge, ProjectRuntimeSettings "Recent Limit Signals", Chat active-limit banner + `CHAT_USAGE_LIMIT` fallback). Persisted snapshots already in the DB are still returned on read but never updated. When `true`, Codex overlays and broadcasts are fed from the background SQLite index (`codex_limit_heads`/`codex_limit_history`) instead of request-path filesystem scans. Set to `true` only when you actively monitor rate-limit windows |
| `AIF_WARMUP_ENABLED`                                   | boolean | `false`                        | Master switch for project runtime warmup. When `false`, `/projects/:id/warmup` reports `enabled=false`, create requests return `403`, and the web UI hides Warmup entry points. When `true`, supported planner, implementer, and review runtimes can create time-limited seed sessions that later matching stage runs may fork. Warmup lifecycle logs use the `projects-route`, `api-runtime`, and runtime adapter log components and include project/runtime ids, TTL, expiry, and status without prompt text or secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AIF_QA_PIPELINE_ENABLED`                              | boolean | `false`                        | Master switch for the task QA pipeline. When `false` (default): the manual `POST /tasks/:id/run-qa` endpoint returns `403` with `code: "feature_disabled"`, and the `autoQa` auto-trigger on `approve_done` is skipped. When `true`, manual runs and `autoQa` tasks execute the `/aif-qa --all` pipeline (change-summary → test-plan → test-cases) via `runApiRuntimeOneShot` and persist the three artifacts on the task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AIF_ENABLE_CODEX_LOGIN_PROXY`                         | boolean | `false`                        | Enable the in-container Codex OAuth login broker and the api-side `/auth/codex/*` proxy. Dev-only. In production prefer `OPENAI_API_KEY`. See [Providers](providers.md#codex-oauth-login-in-docker-broker)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AIF_CODEX_LOGIN_BROKER_PORT`                          | number  | `3010`                         | Port the Codex login broker binds inside the agent container (not mapped to the host by the dev compose)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AGENT_INTERNAL_URL`                                   | string  | `http://agent:3010`            | Base URL the api uses to reach the agent-side Codex login broker over the docker network                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TELEGRAM_BOT_API_URL`                                 | string  | `https://api.telegram.org`     | Optional Telegram Bot API base URL or proxy endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TELEGRAM_BOT_TOKEN`                                   | string  | _(optional)_                   | Telegram bot token for task status notifications (see [Telegram Notifications](#telegram-notifications))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TELEGRAM_USER_ID`                                     | string  | _(optional)_                   | Telegram user ID to receive notifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
2. **Codex adapter (local transports — SDK / CLI / App Server):** default to local `codex login` / ChatGPT OAuth and the installed Codex CLI (`CODEX_CLI_PATH` or `codex` from `PATH`). These transports do **not** implicitly consume an ambient `OPENAI_API_KEY` or `OPENAI_BASE_URL` — so a placeholder/unrelated key in `.env` (e.g. `OPENAI_API_KEY=sk-000`) cannot hijack an OAuth-backed session. To run a local Codex transport with API-key auth instead, opt in explicitly by setting the profile's `apiKeyEnvVar` (e.g. `OPENAI_API_KEY`) or `apiKey`. For a custom local endpoint, set the profile's `baseUrl` or `CODEX_BASE_URL` (`OPENAI_BASE_URL` is intentionally ignored for local transports).
3. **Codex adapter (API transport):** uses `OPENAI_API_KEY` + `OPENAI_BASE_URL` for remote OpenAI-compatible execution (unchanged).
4. **OpenRouter adapter (API transport):** uses `OPENROUTER_API_KEY` + `OPENROUTER_BASE_URL` (defaults to `https://openrouter.ai/api/v1`). Models use `provider/model` format.
5. **Custom adapters:** loaded via `AIF_RUNTIME_MODULES`, each adapter resolves its own env vars.

The default runtime can be changed via `AIF_DEFAULT_RUNTIME_ID` and `AIF_DEFAULT_PROVIDER_ID` (defaults: `claude` / `anthropic`).

Optional runtime defaults:

- `CODEX_CLI_PATH` for Codex CLI/SDK/App Server transport adapters. `options.codexCliPath` has priority, then `CODEX_CLI_PATH`, then `codex` from `PATH`. For App Server on Windows, use a real executable path or safe shim name only; shell metacharacters are rejected before spawn.
- `AIF_RUNTIME_MODULES` for loading additional runtime modules at startup (`registerRuntimeModule(registry)`)
- `API_RUNTIME_START_TIMEOUT_MS` / `API_RUNTIME_RUN_TIMEOUT_MS` for API one-shot runtime calls
- `MCP_PORT` must be a valid integer port (`1-65535`) anywhere HTTP MCP mode is enabled. `npm run dev` and `POST /settings/mcp/install` ignore invalid values and fall back to non-HTTP behavior; the standalone MCP HTTP server fails fast on invalid configuration.

### Proxy Support

Runtime adapters support the standard proxy environment variables:

- `HTTP_PROXY` / `http_proxy` for `http://` requests
- `HTTPS_PROXY` / `https_proxy` for `https://` requests
- `ALL_PROXY` / `all_proxy` as a fallback; `socks5://...` is supported by API transports
- `NO_PROXY` / `no_proxy` to bypass proxying by host, suffix, optional port, or `*`

For local development, `.env` is loaded into the API/agent processes and then forwarded through each runtime adapter's curated environment allowlist. For Docker, compose passes the same proxy variables as build args and injects `.env` into runtime containers.

Always include local service names in `NO_PROXY`. A safe Docker default is:

```env
NO_PROXY=localhost,127.0.0.1,::1,api,agent,web,mcp
```

Transport behavior:

| Runtime / transport          | Proxy handling                                                               |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Claude SDK / CLI             | Proxy env vars are forwarded to the SDK/CLI child execution environment      |
| Codex SDK / CLI / App Server | Proxy env vars are forwarded to the SDK/CLI/App Server execution environment |
| Codex API / OpenRouter API   | API fetch calls attach an undici dispatcher from proxy env vars              |
| OpenCode API                 | API fetch calls attach an undici dispatcher from proxy env vars              |

Example SOCKS5 fallback:

```env
ALL_PROXY=socks5://proxy.example.com:1080
NO_PROXY=localhost,127.0.0.1,::1,api,agent,web,mcp
```

### Runtime Readiness Check

API exposes `GET /agent/readiness` to verify auth state at runtime:

- `ready=true`: runtime registry is available and at least one execution path is configured (enabled profile, usable auth, or Codex CLI path).
- `ready=false`: no usable runtime execution path detected.
- Response includes runtime descriptor list, enabled profile count, and auth source diagnostics.

## Runtime Profile Defaults

Runtime profiles are persisted in SQLite (`runtime_profiles`) and can be selected at four levels:

1. task override (`tasks.runtime_profile_id`)
2. project default (`projects.default_task_runtime_profile_id` / `default_chat_runtime_profile_id`)
3. app default (`app_settings.default_*_runtime_profile_id`)
4. environment fallback (`AIF_DEFAULT_RUNTIME_ID`, adapter env vars, and model env defaults)

The Global Settings dialog manages reusable global profiles plus the app defaults for task, plan, review, and chat. Project settings can still override those defaults per project.

Planning and review have dedicated defaults at both project and app scope. When those are unset, they inherit from the task default at the same scope before falling back again.

Scope rules are enforced by the API:

- app defaults may reference only enabled global profiles
- project defaults and task/chat overrides may reference either a same-project profile or a global profile
- references to profiles owned by another project are rejected with a 4xx validation error

Only non-secret fields are persisted (`baseUrl`, `apiKeyEnvVar`, headers/options metadata, default model). Secret values remain in environment variables or temporary validation payloads.

The app-default API surface lives under `GET /settings/runtime-defaults` and `PUT /settings/runtime-defaults`.

For concrete profile payloads and adapter capability differences, see [Providers](providers.md).

### Runtime Warmup

Runtime warmup is opt-in through `AIF_WARMUP_ENABLED=true`. Warmup creates
time-limited seed sessions for a project's effective planner, implementer, and
review runtimes and stores them in `runtime_warmup_sessions`; later stage runs
can fork a seed only when their effective runtime/profile/model still match the
warmup row.

The create API accepts `ttlSeconds` from 60 to 86400 and defaults to 3600.
Expired or cleared rows are retained for diagnostics but are not considered
active. Warmup is available only when the effective stage runtime advertises
session fork support and implements the fork method: Claude SDK/CLI and Codex
App Server are the initial supported transports.

Inspect warmup lifecycle logs in the API under `projects-route` and
`api-runtime`, and in adapter logs for runtime-specific fork or seed creation
details. These logs include project/runtime ids, support skip reasons, TTL, and
expiry timestamps; they must not include prompt text, seed session contents, or
secrets.

### Runtime-Limit Auto-Pause

Runtime-limit auto-pause does not currently have its own environment toggle. The behavior is driven by provider/runtime signals persisted on runtime profiles:

- exact quota sources (for example provider/API headers) can proactively block new work when the configured safety threshold has already been crossed;
- heuristic sources (for example provider SDK status events) only block when the provider explicitly reports the runtime as unavailable;
- reset/resume timing comes from persisted `resetAt` / `retryAfterSeconds` metadata when available, falling back to legacy backoff only when no structured hint exists.

SQLite is the source of truth for this state:

- `runtime_profiles.runtime_limit_snapshot_json` stores the latest authoritative profile-level snapshot;
- `tasks.runtime_limit_snapshot_json` stores the task-level copy used by blocked-task UI and audit trails.

Short-lived in-memory caches only dedupe repeated writes and provider refresh attempts; they do not replace persisted state.

## Project Language

`.ai-factory/config.yaml` carries a `language` block that controls the language AI produces for
generated artifacts (task descriptions, plans, review notes, commit messages, roadmap items,
chat replies). The setting is wired through a single injection point in the runtime registry
(`packages/runtime/src/registry.ts` — `wrapAdapter`), so every call path — subagents, roadmap
generation, fast-fix, commit generation, reviewGate, chat — picks it up automatically across
all transports (SDK/CLI/API).

```yaml
# .ai-factory/config.yaml
language:
  ui: en # reserved for future UI localisation (currently informational)
  artifacts: ru # language for AI-produced artifacts; "en" (default) disables injection
  technical_terms: keep # "keep" or "translate"
```

Keys:

- `artifacts` — BCP-47-ish language code. Values are validated against a conservative
  `^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$` pattern after trim+lowercase (both `-` and `_` are
  accepted as subtag separators, so `en-US` and `en_US` parse identically); tags that fail the
  pattern (typos, non-ASCII strings) silently fall back to the default `en` rather than being
  embedded raw in the system directive. Any regional tag whose primary subtag is `en` (`en-US`,
  `en_GB`, …) is also treated as a no-op. Any other valid tag appends a short system directive
  asking the model to write artifacts in that language.
- `technical_terms` — `keep` (default) instructs the model to leave identifiers, API/function
  names, file paths, CLI flags, environment variables, code snippets, and log/error strings in
  English even when the rest of the text is translated. `translate` allows natural translation
  of those tokens where a good equivalent exists.
- `ui` — reserved for future UI-side localisation; currently informational only.

Injection is uniform at the registry layer: the directive is written to
`execution.systemPromptAppend` (never to `input.prompt`), so resume sessions, slash commands,
and agent definitions continue to work unchanged. Existing appends (project-scope,
review-diff-scope) are preserved verbatim and placed BEFORE the language directive so scope
rules keep their emphasis.

How each adapter then delivers that append block to the model depends on the transport:

| Adapter    | SDK                          | CLI                      | API            |
| ---------- | ---------------------------- | ------------------------ | -------------- |
| Claude     | `options.systemPromptAppend` | `--append-system-prompt` | n/a            |
| Codex      | prepended to user prompt     | prepended to CLI stdin   | system message |
| OpenRouter | n/a                          | n/a                      | system message |
| OpenCode   | n/a                          | n/a                      | system message |

The Codex SDK/CLI paths do not expose a dedicated system-prompt slot, so the adapter prepends
the append block to the user prompt separated by a blank line. That happens inside the
adapter, after the registry has set `systemPromptAppend` — the caller and the registry never
mutate `input.prompt` themselves. This keeps the registry-level injection guaranteed to reach
the model on every Codex transport, matching the API path.

To disable: leave `artifacts: en` (the default).

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

## Auto-Review Convergence

Auto-review persists its latest blocking snapshot on the task (`autoReviewState`) and exposes the resolved global strategy via `GET /settings` as `autoReviewStrategy`.

- `full_re_review` keeps the legacy broad loop and remains the default.
- `closure_first` verifies prior blockers before allowing another autonomous loop.
- When convergence fails, the task stays in `done` but is marked `manualReviewRequired=true`. Humans then resolve it with the existing `approve_done` or `request_changes` actions.

## Agent Permissions

Subagents (planner, implementer, reviewer) run shell commands during task execution. Permission behaviour is driven by the provider-neutral `AGENT_BYPASS_PERMISSIONS` env flag, which each runtime adapter translates into its native mechanism.

### Option 1: Bypass all permissions (simple)

`AGENT_BYPASS_PERMISSIONS=true` is the default. All tool calls are auto-approved without prompting and the OS sandbox is removed. Convenient for trusted environments and local development.

```
AGENT_BYPASS_PERMISSIONS=true
```

Per-adapter translation:

- **Claude (SDK/CLI):** `--dangerously-skip-permissions` — Claude has one safety axis (prompts); disabling it gives the agent full access.
- **Codex (SDK/CLI/App Server):** `approval_policy=never` + `sandbox_mode=danger-full-access` — Codex has two orthogonal axes (prompts + OS sandbox); both must be cleared to match Claude's "agent can do anything" behaviour. Leaving the sandbox at the default `workspace-write` would block network access (`npm install`, `curl`, `git push`).

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

- **Codex:** `approval_policy=on-request` + `sandbox_mode=workspace-write` — the agent runs inside the workspace with network access disabled. SDK/CLI transports use Codex's native approval behavior; App Server approval requests are currently denied by design because AIF has no human approval bridge for its server-initiated RPCs. Per-profile overrides (`options.approvalPolicy`, `options.sandboxMode`) always take precedence.

### Chat mode specifics (issue #74)

The chat route honours the same `AGENT_BYPASS_PERMISSIONS` flag. When it is off, Claude may request permission on sensitive files (e.g. creating `mcp.json` during `/aif` bootstrap). The permission prompt is issued inside the Claude process and cannot be rendered in the chat UI — the conversation appears to pause. Set `AGENT_BYPASS_PERMISSIONS=true` if you run `/aif`-style bootstrap flows from chat.

Slash commands invoked from chat (e.g. `/aif`, `/aif-improve`) may call Claude's `AskUserQuestion` tool. The chat route renders the question and its options as a markdown message; the user's next chat message is treated as the answer and the session resumes with that answer in history. No interactive buttons yet — this is a follow-up (see phase 2 in the related plan).

## Parallel Execution (Experimental)

By default, the coordinator processes one task at a time per project. Parallel execution allows multiple tasks to run concurrently for projects that opt in.

### Setup

1. Set the global task ceiling, per-project task concurrency, and project-lane concurrency in `.env`:

```
COORDINATOR_MAX_CONCURRENT_TASKS=12
COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT=3
COORDINATOR_MAX_CONCURRENT_PROJECTS=4
```

> **Upgrading from the previous coordinator limit:** `COORDINATOR_MAX_CONCURRENT_TASKS`
> used to control per-project/stage concurrency. It is now the global ceiling across all
> projects. Existing deployments should set all three values above explicitly; leaving an old
> value such as `COORDINATOR_MAX_CONCURRENT_TASKS=3` limits total coordinator concurrency to 3.

2. Enable per-project in the web UI: open project settings and toggle **Parallel Execution**.

3. For projects that also use `git.create_branches=true`, opt into task worktrees:

```
AIF_TASK_WORKTREES_ENABLED=true
```

### How It Works

- The coordinator reads each task's project `parallelEnabled` flag to determine concurrency:
  - **Parallel off** (default): 1 task per project at a time — identical to serial behavior
  - **Parallel on**: up to `COORDINATOR_MAX_CONCURRENT_TASKS_PER_PROJECT` tasks per project per stage
- The coordinator processes up to `COORDINATOR_MAX_CONCURRENT_PROJECTS` independent project lanes concurrently in a poll cycle. Stage ordering is preserved inside a project lane, so a project's planner still drains before that same project's reviewer, but a slow planner in project A no longer blocks a reviewer in project B.
- Across all lanes, `COORDINATOR_MAX_CONCURRENT_TASKS` remains the global safety ceiling for active coordinator tasks. Runnable lanes receive slots through a fair FIFO governor, so an older busy project cannot consume the whole first wave when other selected lanes are ready.
- Cron ticks and WebSocket wakes share one single-flight poll loop. A wake received during an active cycle is coalesced into one follow-up cycle, preserving project-local stage order across trigger sources.
- With `AIF_TASK_WORKTREES_ENABLED=false` (default), any branch-isolated project (`git.create_branches=true`) remains serial. The API also rejects parallel auto-queue for that combination.
- With `AIF_TASK_WORKTREES_ENABLED=true`, full-mode planning for parallel branch-isolated projects creates a sibling git worktree for each task, persists its absolute path in `tasks.worktree_path`, and runs all downstream stages from that path. Legacy branch-bound tasks that have `branchName` but no `worktreePath` still force serial execution until they drain.
- Tasks within a stage run concurrently via `Promise.allSettled` — a failure in one task does not block others
- Tasks are atomically claimed via `lockedBy` / `lockedUntil` columns to prevent duplicate picks
- Lock duration is tied to the stage timeout (`AGENT_STAGE_RUN_TIMEOUT_MS` + 5 min buffer). Heartbeats renew the lock periodically, so long-running stages keep their claim alive
- Stale claims are auto-released at the start of each poll cycle: expired TTL, or dead heartbeat (> 5 min with no update) on in-progress tasks
- On graceful shutdown (SIGINT/SIGTERM), all active task locks are released immediately

### Constraints

When parallel mode is enabled for a project, tasks are forced to `mode = full` (creates git branch/worktree per task) to ensure code isolation between concurrent agents. The UI disables mode selection and auto-generates unique plan file paths. The API enforces these constraints: creating a task in a parallel project auto-sets `plannerMode=full`, and updating to `fast` mode returns a 400 error.

Task worktrees are retained after terminal statuses (`done` / `verified`) for operator inspection and follow-up commits. Handoff does not remove them automatically; cleanup is an operator action. Long-running auto-queue projects should monitor sibling worktree disk usage.

## Backlog Position Normalization

Ordinary task creation now appends backlog rows to the tail of each project's
backlog, and auto-queue consumes the smallest backlog `position`. Existing
legacy rows are not rewritten automatically because operators can manually
reorder backlog tasks via the API/UI.

Use the normalization utility only when you intentionally want to overwrite the
current backlog order and regenerate positions by `createdAt ASC, id ASC`.

Preview all backlog changes (dry-run, no writes):

```bash
node --import tsx packages/data/src/normalizeBacklogPositions.ts
```

Preview a single project:

```bash
node --import tsx packages/data/src/normalizeBacklogPositions.ts --project PROJECT_ID
```

Apply the rewrite for one project:

```bash
node --import tsx packages/data/src/normalizeBacklogPositions.ts --project PROJECT_ID --apply
```

Behavior:

- Default mode is dry-run. The utility only logs what would change.
- `--apply` rewrites backlog positions to `100, 200, 300, ...` within the
  selected scope.
- The rewrite only touches `status = backlog` rows. Non-backlog tasks keep
  their existing positions.
- Applying the rewrite overwrites any manual backlog order in the selected
  scope. Review the dry-run output first.

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

**`language`** — controls AI-generated content language. See [Project Language](#project-language) for the full directive contract, validation rules, and per-transport delivery matrix:

| Key               | Default | Options                                                                                                                                                                                                                       |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui`              | `en`    | Reserved for future UI localisation (currently informational).                                                                                                                                                                |
| `artifacts`       | `en`    | BCP-47-ish tag, validated against `^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$` after trim+lowercase. `-` and `_` are interchangeable separators (`en-US` == `en_US`). Any `en*` primary subtag and invalid tags are treated as no-op. |
| `technical_terms` | `keep`  | `keep`, `translate`                                                                                                                                                                                                           |

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
| `qa`           | `.ai-factory/qa/`             |

**`workflow`** — controls AI Factory workflow behavior:

| Key                            | Default  | Options                       |
| ------------------------------ | -------- | ----------------------------- |
| `auto_create_dirs`             | `true`   | boolean                       |
| `plan_id_format`               | `slug`   | `slug`, `timestamp`, `uuid`   |
| `analyze_updates_architecture` | `true`   | boolean                       |
| `architecture_updates_roadmap` | `true`   | boolean                       |
| `verify_mode`                  | `normal` | `strict`, `normal`, `lenient` |

**`git`** — git-aware workflow settings:

| Key                      | Default    | Description                                     |
| ------------------------ | ---------- | ----------------------------------------------- |
| `enabled`                | `true`     | Use git-aware workflows                         |
| `base_branch`            | `main`     | Default branch for diff/review                  |
| `create_branches`        | `true`     | Auto-create feature branches                    |
| `branch_prefix`          | `feature/` | Prefix for branch names                         |
| `skip_push_after_commit` | `false`    | Skip push after /aif-commit                     |
| `strict_base_update`     | `false`    | Hard-fail if `git pull --ff-only` of base fails |

When `config.yaml` is absent, Handoff treats the base branch as repository
discovery: it first checks the branch pointed to by `refs/remotes/origin/HEAD`,
creating a same-named local branch from `origin/<branch>` when only the remote
ref exists, with upstream tracking when Git can infer the remote relationship,
then falls back to the legacy `master` branch, and only then to the built-in
`main` default. When `base_branch` is explicitly configured and still points to
the default `main`, but the local repository does not have `main`, Handoff uses
the same `origin/HEAD` then `master` fallback. Explicit non-default base
branches are strict: if you set `base_branch: develop`, that branch must exist.

#### `skip_push_after_commit` semantics

Controls whether the approve-done auto-commit flow (and any other `/aif-commit` run originating from the API) performs `git push` after creating the commit:

- **`false` (default):** the runtime is instructed to stage everything with `git add -A`, create one conventional commit, and then run `git push` on the current branch.
- **`true`:** the runtime creates the commit but MUST NOT push — useful when you want to review the commit locally or rely on an external push step.

The setting is editable from the web UI (`Global Settings → Project config`). Because it's written into `.ai-factory/config.yaml`, it is read on every commit run — no restart required.

#### `strict_base_update` semantics

Before creating a feature branch, Handoff runs `git pull --ff-only origin <base_branch>` so the new branch starts from a fresh base. The `strict_base_update` flag controls how a failed pull is treated:

- **`false` (default):** the failure is logged as a warning and the branch is created from the local base. Pragmatic for offline development and CI clones without push access.
- **`true`:** the failure is converted into a hard `BranchIsolationError("base_update_failed")`. The coordinator parks the task in `blocked_external` (no auto-retry) so an operator can rebase the base branch manually before continuing. Recommended for projects with a strict trunk-based policy where stale local bases cause merge churn.

The setting only affects the upfront pull — once the feature branch exists, a stale local base does not retroactively block subsequent stages.

The commit lifecycle is surfaced over WebSocket as `task:commit_started`, `task:commit_done`, and `task:commit_failed` events. The web UI subscribes to these and:

- shows a toast for each event (`Creating commit…`, `Commit created`, `Commit failed: <error>`);
- keeps the "Approve done" modal open with an inline spinner until the commit is acknowledged, so the user knows whether the commit actually ran.

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
