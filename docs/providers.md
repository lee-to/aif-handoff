[← Configuration](configuration.md) · [Back to README](../README.md)

# Providers

This guide describes the runtime/provider model introduced by `@aif/runtime`.

## Runtime Architecture

`@aif/runtime` is the shared execution layer for both API and agent packages:

- runtime registry (`RuntimeRegistry`) for built-in and module-loaded adapters
- workflow-spec abstraction (`RuntimeWorkflowSpec`) so orchestrators stay provider-neutral
- runtime-profile resolution (`resolveRuntimeProfile`) with capability checks and redaction helpers
- adapter surfaces for run/resume/session/model-discovery operations

## Runtime Profile Model

Runtime profiles are persisted in `runtime_profiles` and reference only non-secret configuration.

| Field                   | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `projectId`             | Scope profile to one project, or `null` for global profile |
| `name`                  | Display name shown in UI                                   |
| `runtimeId`             | Adapter id (for example `claude`, `codex`)                 |
| `providerId`            | Provider namespace (for example `anthropic`, `openai`)     |
| `transport`             | Adapter transport (`sdk`, `cli`, `api`)                    |
| `baseUrl`               | Optional custom endpoint                                   |
| `apiKeyEnvVar`          | Env var name containing API key                            |
| `defaultModel`          | Optional default model alias/id                            |
| `headers`               | Optional non-secret header map                             |
| `options`               | Adapter-specific options object                            |
| `enabled`               | Toggle profile availability without deleting it            |
| `runtimeLimitSnapshot`  | Latest persisted normalized limit state for this profile   |
| `runtimeLimitUpdatedAt` | ISO timestamp of the last persisted limit-state write      |

Secrets are never written to SQLite. Use environment variables or temporary validation payloads.

## Effective Profile Resolution

Task mode fallback order:

1. `tasks.runtime_profile_id`
2. `projects.default_task_runtime_profile_id`
3. `app_settings.default_task_runtime_profile_id`
4. environment fallback

Planning and review use the same chain, but `default_plan_runtime_profile_id` / `default_review_runtime_profile_id` fall back to the task default at the same scope when unset. Chat uses `default_chat_runtime_profile_id` for the project/app steps.

Scope rules:

- app defaults may point only to enabled global profiles (`runtime_profiles.project_id = null`)
- project defaults and task/chat overrides may point to either a same-project profile or a global profile
- project-owned profiles from another project are rejected at the API layer

The API exposes effective selection endpoints:

- `GET /runtime-profiles/effective/task/:taskId`
- `GET /runtime-profiles/effective/chat/:projectId`

## Supported Runtimes

| Runtime      | Provider     | Transports    | Resume         | Sessions       | Agent Defs    | Native Subagents | Isolated Fallback | Usage Reporting               | Light Model         | Status                    |
| ------------ | ------------ | ------------- | -------------- | -------------- | ------------- | ---------------- | ----------------- | ----------------------------- | ------------------- | ------------------------- |
| `claude`     | `anthropic`  | SDK, CLI, API | Yes (SDK/CLI)  | Yes (SDK/CLI)  | Yes (SDK/CLI) | No               | No                | `FULL` (all transports)       | `claude-haiku-3-5`  | Built-in                  |
| `codex`      | `openai`     | SDK, CLI, API | Yes (SDK only) | Yes (SDK only) | No            | SDK only         | SDK only          | `FULL` SDK/API, `PARTIAL` CLI | default             | Built-in                  |
| `opencode`   | `opencode`   | API           | Yes            | Yes            | No            | No               | No                | `NONE`                        | null (configurable) | Built-in                  |
| `openrouter` | `openrouter` | API           | No             | No             | No            | No               | No                | `FULL`                        | null (configurable) | Built-in                  |
| Custom       | Any          | Any           | Configurable   | Configurable   | Configurable  | Configurable     | Configurable      | Must declare                  | Configurable        | Via `AIF_RUNTIME_MODULES` |

Capabilities are **transport-aware**: the same adapter may expose different capabilities depending on the selected transport. For example, the Codex adapter supports resume/sessions via SDK transport but not via CLI. Use `resolveAdapterCapabilities(adapter, transport)` to get the effective set.

### Runtime-limit observability

Runtime-limit auto-pause depends on what each provider/transport can actually surface. The runtime layer normalizes these inputs into the shared `runtimeLimitSnapshot` contract and marks each snapshot as either `exact` or `heuristic`.

| Runtime / transport | Limit source                            | Precision   | Notes                                                                                                                                          |
| ------------------- | --------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK / CLI    | Claude `rate_limit_event`               | `heuristic` | Structured qualitative status with reset timestamps (`status`, `resetsAt`, `overageStatus`, `isUsingOverage`, ...)                             |
| Claude API          | Anthropic rate-limit headers            | `exact`     | Exact request/token limits and reset times from `anthropic-ratelimit-*` + `retry-after`                                                        |
| Codex API           | OpenAI-compatible rate-limit headers    | `exact`     | Exact request/token limits and reset times from `x-ratelimit-*` + `retry-after`                                                                |
| Codex SDK / CLI     | Codex session `token_count.rate_limits` | `exact`     | Reads the persisted Codex session log (`~/.codex/sessions/...jsonl`) and normalizes the latest `5h` / `7d` percentage windows plus reset times |
| OpenRouter API      | OpenAI-compatible rate-limit headers    | `exact`     | Uses `x-ratelimit-*` / `retry-after` when the upstream provides them                                                                           |
| OpenCode API        | structured error metadata               | `heuristic` | Preserves `resetAt` / retry hints on rate-limit errors, but no proactive normalized snapshot is emitted today                                  |

Auto-pause semantics follow the precision:

- `exact` snapshots can proactively gate new work when the remaining quota has already crossed the configured safety threshold.
- `heuristic` snapshots only proactively gate when the provider reports the runtime as blocked.
- When a provider exposes `resetAt` / `retryAfterSeconds`, the agent uses those values instead of random quota backoff.

### Provider metadata sanitization

Runtime-limit `providerMeta` is sanitized before it is persisted or exposed outside the runtime layer.

- Only provider-specific allow-listed top-level keys survive sanitization.
- String values are redacted before storage.
- Nested structured objects stay typed only when the key is registered in `PROVIDER_META_NESTED_SCHEMAS` (currently `modelUsageSummary` and `toolUsageSummary`).
- Any new allow-listed key that emits a nested object/array must add a schema entry, otherwise that nested container is collapsed to a redacted opaque JSON string.

Redaction helpers have distinct contracts:

- `redactProviderText()` is the strict client-safe helper. Use it for anything returned to clients or persisted in user-visible payloads.
- `redactProviderTextForLogs()` is the server-log helper. It still scrubs secrets, but preserves URLs and emails so diagnostics remain useful.

For Claude-family profiles, the runtime now distinguishes the backend by resolved endpoint identity, not just `runtimeId/providerId/model`:

- Native Anthropic uses SDK `rate_limit_event` (SDK/CLI) or Anthropic headers (API).
- Z.AI / GLM Coding Plan is detected from Anthropic-compatible endpoints such as `https://api.z.ai/api/anthropic` and refreshes quota from the provider monitor endpoints when headers are insufficient:
  - `/api/monitor/usage/quota/limit` for live quota windows
  - `/api/monitor/usage/model-usage` for recent model/token usage summaries
  - `/api/monitor/usage/tool-usage` for recent MCP/tool usage summaries
- Alibaba Coding Plan Anthropic-compatible endpoints are tracked as a separate family, but remain `partial` for quota visibility because no official provider-side polling API is integrated yet.
- Other Anthropic-compatible endpoints fall back to headers for API transport and SDK events for SDK/CLI transport when available.

UI grouping for Claude runtime usage should use the normalized backend family plus the server-side account fingerprint (derived from endpoint origin + resolved auth secret), so native Anthropic, Z.AI GLM, and other compatible backends do not collapse into one card.

### Usage reporting contract

Every adapter must declare a `usageReporting` value in its `RuntimeCapabilities`. The registry wrapper reads this field for every run and enforces the contract — a new adapter cannot silently skip token accounting:

- **`FULL`** — adapter always populates `RuntimeRunResult.usage` on a successful run. If the wrapper observes a null `usage` while the capability says `FULL`, it logs an error (dev) or fires a metric (prod). The contract test in `bootstrap.test.ts` also fails the build if the field is missing.
- **`PARTIAL`** — adapter returns usage when the provider gives it, but may return `null` on some transport/streaming paths (e.g. CLI early-termination). The wrapper accepts both and records only the non-null events.
- **`NONE`** — transport fundamentally cannot report token counts (e.g. OpenCode message payload). The wrapper warns if usage unexpectedly appears, but this is an opt-out from the usage pipeline — dashboards will show zero traffic for runtimes in this tier.

All successful runs that produce non-null usage flow through the registry's `usageSink`, which persists them to the `usage_events` table and rolls them up into per-task / per-project / per-chat-session aggregates. Sink wiring lives in `packages/api/src/services/runtime.ts` (API) and `packages/agent/src/index.ts` / `subagentQuery.ts` (agent) — both use `createDbUsageSink()` from `@aif/data`.

### Interactive questions capability

Optional `supportsInteractiveQuestions` flag in `RuntimeCapabilities` declares that the adapter emits runtime-neutral `tool:question` events (e.g. Claude's `AskUserQuestion`). Consumers — notably the chat route — use this flag to gate provider-specific prompt scaffolding (`CHAT_ASKUSERQUESTION_HINT` is only injected into `systemPromptAppend` when the resolved adapter declares the capability). Claude (SDK + CLI) sets the flag; Claude API, Codex, OpenCode, and OpenRouter leave it unset (defaults to `false`). Adapters that add interactive tool parsing must also call `buildToolUseEvents()` with a `questionPayload` so the rendered shape stays identical across runtimes.

### Transport Types

| Transport | Description                           | Example                                  |
| --------- | ------------------------------------- | ---------------------------------------- |
| `sdk`     | In-process library call via JS/TS SDK | Claude Agent SDK, Codex SDK              |
| `cli`     | Spawn a subprocess, parse stdout      | `claude --agent ...`, `codex run --json` |
| `api`     | HTTP POST to a remote endpoint        | OpenAI-compatible REST API               |

#### Transport Observability Differences

**SDK transport** streams events in real time — tool calls, subagent spawns, and partial messages are visible as they happen. The Agent Activity timeline shows each tool invocation with timestamps. The first-activity watchdog can detect hung agents within 60 seconds.

**CLI and API transports** are opaque — the entire tool-calling cycle runs inside the subprocess or remote server. The coordinator only sees "agent started" and "agent complete/failed" with no intermediate events. Consequently:

- **Agent Activity** shows only start/complete entries, not individual tool calls
- **First-activity watchdog** is disabled (no `onToolUse` callbacks to monitor)
- **Start timeout** (`AGENT_QUERY_START_TIMEOUT_MS`) is disabled — CLI/API produce output only after the full run completes, so the only protection is the run timeout (`AGENT_STAGE_RUN_TIMEOUT_MS`)
- **Token usage** is reported as a single aggregate at the end of the run

## Built-In Adapter Examples

### Claude (SDK)

```json
{
  "projectId": "PROJECT_UUID",
  "name": "Claude Sonnet",
  "runtimeId": "claude",
  "providerId": "anthropic",
  "transport": "sdk",
  "apiKeyEnvVar": "ANTHROPIC_API_KEY",
  "defaultModel": "sonnet",
  "enabled": true
}
```

Optional proxy mode:

- set `ANTHROPIC_BASE_URL`
- set one of `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`
- if proxy requires explicit model, set `ANTHROPIC_MODEL` (or profile `defaultModel`)
- if proxy handles model routing, keep `defaultModel` empty

### Claude (CLI)

Spawns `claude` binary as a subprocess. Supports `--agent` flag for agent definitions and `--resume` for session continuation. Auth is handled by the CLI's own login (`claude /login`).

```json
{
  "projectId": null,
  "name": "Claude CLI",
  "runtimeId": "claude",
  "providerId": "anthropic",
  "transport": "cli",
  "defaultModel": "claude-sonnet-4-5",
  "enabled": true
}
```

CLI-specific options:

- `claudeCliPath` — override for the `claude` binary path (default: auto-discovered)
- `CLAUDE_CLI_PATH` env var — same, via environment

### Codex (SDK transport)

Uses `@openai/codex-sdk` which wraps the Codex CLI with thread-based conversations, streaming events, and resume support. Auth is handled by the CLI's own login (`codex auth login`), same as Claude SDK.

```json
{
  "projectId": null,
  "name": "Codex SDK",
  "runtimeId": "codex",
  "providerId": "openai",
  "transport": "sdk",
  "defaultModel": "gpt-5.4",
  "enabled": true
}
```

SDK-specific options:

- `codexCliPath` — path to the `codex` binary (SDK wraps the CLI)
- `codexConfig` — JSON object of CLI config overrides (flattened to `--config` flags)
- `sandboxMode` — one of `read-only`, `workspace-write`, `danger-full-access`
- `approvalPolicy` — one of `untrusted`, `on-failure`, `on-request`, `never`
- `modelReasoningEffort` — one of `minimal`, `low`, `medium`, `high`, `xhigh`
- `codexSubagentStrategy` — `native` (default when required `.codex` assets are present) or `isolated`; use `isolated` as an escape hatch when you need the legacy fresh-session skill workflow instead of native Codex agents
- `skipGitRepoCheck` — bypass the Codex guard that refuses to run outside a git repo (both SDK and CLI)

> Migration note: older releases defaulted `codexSubagentStrategy` to `isolated`.
> If you relied on the isolated skill-session path, set `codexSubagentStrategy: "isolated"` explicitly after upgrading.
> If the project was bootstrapped before AI Factory `2.9.3`, Handoff now checks for materialized `.codex/agents/*.toml` and `.codex/config.toml` before using the native path and automatically falls back to `isolated` until `ai-factory init --agents claude,codex` is re-run.

Invalid `options.approvalPolicy` / `options.sandboxMode` values are ignored with a runtime warning, and the adapter falls back to the effective default for that execution path.

### Codex (CLI transport)

```json
{
  "projectId": null,
  "name": "Codex CLI",
  "runtimeId": "codex",
  "providerId": "openai",
  "transport": "cli",
  "apiKeyEnvVar": "OPENAI_API_KEY",
  "defaultModel": "gpt-5.4",
  "options": {
    "approvalPolicy": "on-failure"
  },
  "enabled": true
}
```

**`codexCliArgs` is a full escape hatch.** When `options.codexCliArgs` is set, the adapter uses the custom template verbatim (with `{prompt}`, `{model}`, `{session_id}` substitutions) and **skips all adapter-managed flags** — including `--model`, `-c model_reasoning_effort`, `-c approval_policy`, `-c sandbox_mode`, `--skip-git-repo-check`, and the bypass-permission translation. If you use a custom template you are responsible for emitting these flags yourself. Profile-level `options.approvalPolicy`, `options.sandboxMode`, `options.skipGitRepoCheck`, `options.modelReasoningEffort`, and `AGENT_BYPASS_PERMISSIONS` all have **no effect** when a custom template is active. Use this only for integration with non-standard CLI wrappers.

### Codex (API transport)

```json
{
  "projectId": "PROJECT_UUID",
  "name": "Codex API",
  "runtimeId": "codex",
  "providerId": "openai",
  "transport": "api",
  "baseUrl": "http://localhost:8080",
  "apiKeyEnvVar": "OPENAI_API_KEY",
  "enabled": true
}
```

### Codex OAuth login in Docker (broker)

Running `codex login` directly inside the `agent` container starts an HTTP
listener on `127.0.0.1:1455` waiting for the OAuth callback. Because container
loopback is not reachable from the host browser, the flow stalls. As of
codex `0.118`, the CLI does not expose a flag to bind the listener to another
interface (verified against `codex login --help`).

To bridge this, the agent ships a small HTTP broker (`packages/agent/src/codex/loginBroker.ts`)
that runs alongside the coordinator when `AIF_ENABLE_CODEX_LOGIN_PROXY=true`:

```
[Browser]
  ├─ GET auth URL → ChatGPT OAuth
  └─ redirect: http://localhost:1455/?code=…&state=…  (fails on host)
  ▼ user copies URL into the UI
[API /auth/codex/login/*]  (zod + SSRF guard)
  ▼ proxies over docker network
[Agent :3010 broker]
  ├─ start    → spawn `codex login`, parse auth URL
  ├─ callback → fetch 127.0.0.1:1455/?code=…&state=…  (own loopback)
  └─ cancel   → SIGTERM child
```

**Endpoints** (api-side, all behind the feature flag):

| Method | Path                         | Purpose                                             |
| ------ | ---------------------------- | --------------------------------------------------- |
| GET    | `/auth/codex/capabilities`   | Always mounted. Returns `{loginProxyEnabled}`.      |
| POST   | `/auth/codex/login/start`    | Spawn `codex login`, return the auth URL.           |
| POST   | `/auth/codex/login/callback` | Forward the user-pasted redirect URL to the broker. |
| POST   | `/auth/codex/login/cancel`   | SIGTERM the active child process.                   |
| GET    | `/auth/codex/login/status`   | Poll while a session is active.                     |

**Security guards** (defence in depth — enforced in **both** api and broker):

- `scheme = http`, `host ∈ {127.0.0.1, localhost}`, `port = AIF_CODEX_LOGIN_LOOPBACK_PORT` (default `1455`).
- Query must include both `code` and `state`; `state` must match what the broker captured from the spawned CLI.
- One-shot session: repeat `start` without `cancel`/success → `409 session_already_active`.
- Broker binds `0.0.0.0:3010` but is **not** port-mapped to the host in compose; only services on the same docker network can reach it.
- Logs redact `code` / `state` before write (`***redacted***`).

**Environment variables:**

| Variable                        | Default             | Purpose                                          |
| ------------------------------- | ------------------- | ------------------------------------------------ |
| `AIF_ENABLE_CODEX_LOGIN_PROXY`  | `false`             | Enable broker + `/auth/codex/*` routes.          |
| `AIF_CODEX_LOGIN_BROKER_PORT`   | `3010`              | Port the broker listens on inside the container. |
| `AIF_CODEX_LOGIN_LOOPBACK_PORT` | `1455`              | Port the codex CLI binds for its callback.       |
| `AGENT_INTERNAL_URL`            | `http://agent:3010` | Base URL the api uses to reach the broker.       |

**Production guidance:** the broker is a dev-only convenience. In production,
set `AIF_ENABLE_CODEX_LOGIN_PROXY=false` (the default in `docker-compose.production.yml`)
and provision `OPENAI_API_KEY` via `.env` instead.

**Fallback CLI:** the agent image ships a helper at `/usr/local/bin/aif-codex-callback`
that validates the callback URL (same allowlist) and forwards it to the codex
loopback. Use it when the broker or UI is unavailable:

```bash
docker compose exec agent aif-codex-callback "http://localhost:1455/?code=…&state=…"
```

### Bypass semantics (AGENT_BYPASS_PERMISSIONS)

When `AGENT_BYPASS_PERMISSIONS=1` is set in the environment, the runtime layer flips `execution.bypassPermissions=true`. This is intended for trusted, externally sandboxed environments (Docker containers) where the agent should run unattended.

Each adapter translates this to its native "trust me, just run" mechanism:

| Runtime / transport | Bypass translation                                                            |
| ------------------- | ----------------------------------------------------------------------------- |
| Claude SDK          | `permissionMode="bypassPermissions"` + `allowDangerouslySkipPermissions=true` |
| Claude CLI          | `--dangerously-skip-permissions`                                              |
| Codex SDK           | `approvalPolicy="never"` + `sandboxMode="danger-full-access"` (ThreadOptions) |
| Codex CLI           | `-c approval_policy="never" -c sandbox_mode="danger-full-access"`             |

Why Codex disables both approval prompts **and** the sandbox: Codex has two orthogonal safety rails (approval policy + OS-level sandbox), while Claude has only one (permission prompts). To match Claude's effective "agent can do anything" behavior, both rails must be cleared. Leaving the Codex sandbox at its default `workspace-write` blocks network access — so `npm install`, `curl`, `git push`, and WebFetch would silently fail.

The Codex CLI uses `--config` (`-c`) overrides instead of the single `--dangerously-bypass-approvals-and-sandbox` flag because the same code path must work for both `codex exec` and `codex exec resume` — the resume subcommand rejects the standalone `--sandbox` flag, while `--config` overrides are accepted on both. The end-state is identical to the atomic flag.

**Opting out for Codex:** if you want narrower safety even in bypass mode, set `options.sandboxMode` or `options.approvalPolicy` explicitly in your profile — explicit profile values override the bypass defaults on both SDK and CLI transports:

```json
{
  "runtimeId": "codex",
  "transport": "cli",
  "options": {
    "sandboxMode": "workspace-write",
    "approvalPolicy": "never"
  }
}
```

With the example above, even when `AGENT_BYPASS_PERMISSIONS=1` is set, the agent runs with `approval_policy=never` (from the explicit option, which happens to coincide with the bypass default) and `sandbox_mode=workspace-write` (overrides the `danger-full-access` bypass default). You can mix and match — only the axis you set gets overridden.

### OpenRouter (API)

OpenRouter is a unified API proxy providing access to 200+ models from multiple providers (Anthropic, OpenAI, Google, Meta, etc.) through a single OpenAI-compatible endpoint.

```json
{
  "projectId": "PROJECT_UUID",
  "name": "OpenRouter",
  "runtimeId": "openrouter",
  "providerId": "openrouter",
  "transport": "api",
  "apiKeyEnvVar": "OPENROUTER_API_KEY",
  "defaultModel": "anthropic/claude-sonnet-4",
  "enabled": true
}
```

OpenRouter-specific options:

- `httpReferer` — URL of your app, used for OpenRouter rankings and rate limit priority
- `appTitle` — app name shown in OpenRouter dashboard (defaults to `AIF Handoff`)
- `baseUrl` — custom endpoint (defaults to `https://openrouter.ai/api/v1`)

Environment variables:

- `OPENROUTER_API_KEY` — API key from [openrouter.ai/keys](https://openrouter.ai/keys)
- `OPENROUTER_BASE_URL` — custom endpoint (for self-hosted proxies)
- `OPENROUTER_MODEL` — default model when profile `defaultModel` is not set
- `OPENROUTER_HTTP_REFERER` — recommended referer header for rankings
- `OPENROUTER_APP_TITLE` — recommended app title header for rankings

Model IDs use the `provider/model` format (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.0-flash-001`). Some models are available for free (suffixed with `:free`).

### OpenCode (API)

OpenCode integration uses the local or remote `opencode serve` HTTP server. This is the recommended mode for `@aif/runtime` because it provides session APIs and event streams through a stable OpenAPI surface.

```json
{
  "projectId": "PROJECT_UUID",
  "name": "OpenCode API",
  "runtimeId": "opencode",
  "providerId": "opencode",
  "transport": "api",
  "baseUrl": "http://127.0.0.1:4096",
  "defaultModel": "anthropic/claude-sonnet-4",
  "enabled": true
}
```

OpenCode-specific options:

- `baseUrl` — OpenCode server URL (defaults to `OPENCODE_BASE_URL` or `http://127.0.0.1:4096`)
- `serverUsername` — Basic auth username for protected servers (defaults to `opencode`)
- `serverPassword` — Basic auth password for protected servers (or set `OPENCODE_SERVER_PASSWORD`)
- `timeoutMs` — Request timeout override for OpenCode API calls

Environment variables:

- `OPENCODE_BASE_URL` — default OpenCode server URL for API transport
- `OPENCODE_SERVER_USERNAME` — default username for basic auth
- `OPENCODE_SERVER_PASSWORD` — password for basic auth protected servers
- `OPENCODE_PROVIDER_ID` — default provider ID when runtime profile model does not include `provider/model`

Quick start:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

For Dockerized deployments, expose the OpenCode server and set profile `baseUrl` to the container/network address.

Permission handling:

- OpenCode permissions live in the server-side `opencode.json` config (per-agent `permission` map resolving to `"allow"` / `"ask"` / `"deny"`). The default `build` agent is effectively permissive (`"*": "allow"` with a few exceptions).
- When `AGENT_BYPASS_PERMISSIONS=true`, the adapter forces `agent: "build"` in the message body so a user-configured restrictive `default_agent` (e.g. `plan`) cannot block edits.
- Per-tool `"ask"` rules (e.g. reading `.env*`, writing outside the worktree) are still enforced server-side. If a session hits an `"ask"` rule, OpenCode emits a permission event over `/event` SSE that no-one answers, and the `/session/:id/message` POST will hang until `runTimeoutMs`. For full parity with Claude's `--dangerously-skip-permissions`, set `"permission": "allow"` in `opencode.json`.

## Capability Gates

Runtime descriptors declare capability flags:

- `supportsResume`
- `supportsSessionList`
- `supportsAgentDefinitions`
- `supportsStreaming`
- `supportsModelDiscovery`
- `supportsApprovals`
- `supportsCustomEndpoint`
- `supportsNativeSubagentWorkflows`
- `supportsIsolatedSubagentWorkflows`

Additionally, `RuntimeExecutionIntent` supports `outputSchema` for structured JSON output (passed to adapters that support it, e.g. Codex SDK).

Workflows with unsupported requirements are rejected with normalized validation errors instead of raw adapter exceptions.

### Transport-Aware Capabilities

Adapters that support multiple transports may implement `getEffectiveCapabilities(transport)` to declare per-transport capability sets. The system uses `resolveAdapterCapabilities(adapter, transport)` to query the effective capabilities before checking workflow requirements.

## Runtime Profile API

Runtime profile management routes:

- `GET /runtime-profiles/runtimes`
- `GET /runtime-profiles`
- `POST /runtime-profiles`
- `PUT /runtime-profiles/:id`
- `DELETE /runtime-profiles/:id`
- `POST /runtime-profiles/validate`
- `POST /runtime-profiles/models`

Use `validate` before enabling new profiles, especially when using custom endpoints or transport-specific options.

## External Runtime Modules

Set `AIF_RUNTIME_MODULES` to a comma-separated list of module specifiers. Each module must export `registerRuntimeModule(registry)`.

Minimal module shape:

```ts
import type { RuntimeAdapter } from "@aif/runtime";

const adapter: RuntimeAdapter = {
  descriptor: {
    id: "my-runtime",
    providerId: "my-provider",
    displayName: "My Runtime",
    capabilities: {
      supportsResume: false,
      supportsSessionList: false,
      supportsAgentDefinitions: false,
      supportsStreaming: true,
      supportsModelDiscovery: true,
      supportsApprovals: false,
      supportsCustomEndpoint: true,
      supportsIsolatedSubagentWorkflows: false,
    },
  },
  async run(input) {
    return { outputText: "ok", sessionId: null, usage: null };
  },
};

export function registerRuntimeModule(registry: {
  registerRuntime: (adapter: RuntimeAdapter) => void;
}) {
  registry.registerRuntime(adapter, { source: "module" });
}
```

Supported export forms:

- named export `registerRuntimeModule`
- default export function
- default export object containing `registerRuntimeModule`
