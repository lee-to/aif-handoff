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

| Field          | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `projectId`    | Scope profile to one project, or `null` for global profile |
| `name`         | Display name shown in UI                                   |
| `runtimeId`    | Adapter id (for example `claude`, `codex`)                 |
| `providerId`   | Provider namespace (for example `anthropic`, `openai`)     |
| `transport`    | Adapter transport (`sdk`, `cli`, `api`)                    |
| `baseUrl`      | Optional custom endpoint                                   |
| `apiKeyEnvVar` | Env var name containing API key                            |
| `defaultModel` | Optional default model alias/id                            |
| `headers`      | Optional non-secret header map                             |
| `options`      | Adapter-specific options object                            |
| `enabled`      | Toggle profile availability without deleting it            |

Secrets are never written to SQLite. Use environment variables or temporary validation payloads.

## Effective Profile Resolution

Task mode fallback order:

1. `tasks.runtime_profile_id`
2. `projects.default_task_runtime_profile_id`
3. optional system default

Chat mode uses `default_chat_runtime_profile_id` for step 2.

The API exposes effective selection endpoints:

- `GET /runtime-profiles/effective/task/:taskId`
- `GET /runtime-profiles/effective/chat/:projectId`

## Supported Runtimes

| Runtime      | Provider     | Transports    | Resume         | Sessions       | Agent Defs    | Native Subagents | Isolated Fallback | Light Model         | Status                    |
| ------------ | ------------ | ------------- | -------------- | -------------- | ------------- | ---------------- | ----------------- | ------------------- | ------------------------- |
| `claude`     | `anthropic`  | SDK, CLI, API | Yes (SDK/CLI)  | Yes (SDK/CLI)  | Yes (SDK/CLI) | No               | No                | `claude-haiku-3-5`  | Built-in                  |
| `codex`      | `openai`     | SDK, CLI, API | Yes (SDK only) | Yes (SDK only) | No            | SDK only         | SDK only          | default             | Built-in                  |
| `opencode`   | `opencode`   | API           | Yes            | Yes            | No            | No               | No                | null (configurable) | Built-in                  |
| `openrouter` | `openrouter` | API           | No             | No             | No            | No               | No                | null (configurable) | Built-in                  |
| Custom       | Any          | Any           | Configurable   | Configurable   | Configurable  | Configurable     | Configurable      | Configurable        | Via `AIF_RUNTIME_MODULES` |

Capabilities are **transport-aware**: the same adapter may expose different capabilities depending on the selected transport. For example, the Codex adapter supports resume/sessions via SDK transport but not via CLI. Use `resolveAdapterCapabilities(adapter, transport)` to get the effective set.

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
- `codexSubagentStrategy` — `native` (default) or `isolated`; use `isolated` as an escape hatch when you need the legacy fresh-session skill workflow instead of native Codex agents
- `skipGitRepoCheck` — bypass the Codex guard that refuses to run outside a git repo (both SDK and CLI)

> Migration note: older releases defaulted `codexSubagentStrategy` to `isolated`.
> If you relied on the isolated skill-session path, set `codexSubagentStrategy: "isolated"` explicitly after upgrading.

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
