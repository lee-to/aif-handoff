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

| Runtime  | Provider    | Transports    | Resume         | Sessions       | Agent Defs    | Light Model        | Status                    |
| -------- | ----------- | ------------- | -------------- | -------------- | ------------- | ------------------ | ------------------------- |
| `claude` | `anthropic` | SDK, CLI, API | Yes (SDK/CLI)  | Yes (SDK/CLI)  | Yes (SDK/CLI) | `claude-haiku-3-5` | Built-in                  |
| `codex`  | `openai`    | SDK, CLI, API | Yes (SDK only) | Yes (SDK only) | No            | default            | Built-in                  |
| Custom   | Any         | Any           | Configurable   | Configurable   | Configurable  | Configurable       | Via `AIF_RUNTIME_MODULES` |

Capabilities are **transport-aware**: the same adapter may expose different capabilities depending on the selected transport. For example, the Codex adapter supports resume/sessions via SDK transport but not via CLI. Use `resolveAdapterCapabilities(adapter, transport)` to get the effective set.

### Transport Types

| Transport | Description                           | Example                                  |
| --------- | ------------------------------------- | ---------------------------------------- |
| `sdk`     | In-process library call via JS/TS SDK | Claude Agent SDK, Codex SDK              |
| `cli`     | Spawn a subprocess, parse stdout      | `claude --agent ...`, `codex run --json` |
| `api`     | HTTP POST to a remote endpoint        | OpenAI-compatible REST API               |

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
- `modelReasoningEffort` — one of `minimal`, `low`, `medium`, `high`, `xhigh`

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

## Capability Gates

Runtime descriptors declare capability flags:

- `supportsResume`
- `supportsSessionList`
- `supportsAgentDefinitions`
- `supportsStreaming`
- `supportsModelDiscovery`
- `supportsApprovals`
- `supportsCustomEndpoint`

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
