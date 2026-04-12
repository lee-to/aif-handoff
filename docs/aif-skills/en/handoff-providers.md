# Handoff — Providers (Runtime)

## Supported Runtimes

| Runtime      | Provider     | Transports    | Resume        | Agent Definitions |
| ------------ | ------------ | ------------- | ------------- | ----------------- |
| `claude`     | `anthropic`  | SDK, CLI, API | Yes (SDK/CLI) | Yes (SDK/CLI)     |
| `codex`      | `openai`     | SDK, CLI, API | Yes (SDK)     | No                |
| `openrouter` | `openrouter` | API           | No            | No                |
| `opencode`   | `opencode`   | API           | Yes           | No                |
| Custom       | Any          | Any           | Configurable  | Configurable      |

## Transport types

| Transport | Description                                                                           |
| --------- | ------------------------------------------------------------------------------------- |
| `sdk`     | In-process JS SDK call. Streams events in real time. Supports first-activity watchdog |
| `cli`     | Subprocess spawn. No intermediate events — only start/finish                          |
| `api`     | HTTP POST to a remote endpoint. Similar to CLI in observability                       |

## Profile setup

Profiles are created via the **RUNTIME** button in the header. Stored in SQLite, secrets only in env variables.

### Claude (SDK) — recommended

```json
{
  "runtimeId": "claude",
  "transport": "sdk",
  "apiKeyEnvVar": "ANTHROPIC_API_KEY",
  "defaultModel": "sonnet"
}
```

### Claude (CLI)

```json
{
  "runtimeId": "claude",
  "transport": "cli",
  "defaultModel": "claude-sonnet-4-5"
}
```

Authorization via `claude login` in CLI.

### OpenRouter

```json
{
  "runtimeId": "openrouter",
  "transport": "api",
  "apiKeyEnvVar": "OPENROUTER_API_KEY",
  "defaultModel": "anthropic/claude-sonnet-4"
}
```

Model format: `provider/model` (e.g. `openai/gpt-4o`, `google/gemini-2.0-flash-001`). Free models with `:free` suffix.

### Codex (SDK)

```json
{
  "runtimeId": "codex",
  "transport": "sdk",
  "defaultModel": "gpt-5.4"
}
```

### OpenCode (API)

```json
{
  "runtimeId": "opencode",
  "transport": "api",
  "baseUrl": "http://127.0.0.1:4096",
  "defaultModel": "anthropic/claude-sonnet-4"
}
```

Start: `opencode serve --hostname 127.0.0.1 --port 4096`

## Profile priority

1. Task-specific profile (`tasks.runtime_profile_id`)
2. Project default profile
3. System default

## Custom adapter

```typescript
export function registerRuntimeModule(registry) {
  registry.registerRuntime({
    descriptor: {
      id: "my-runtime",
      providerId: "my-provider",
      displayName: "My Runtime",
      capabilities: {
        supportsResume: false,
        supportsAgentDefinitions: false,
        supportsStreaming: true,
      },
    },
    async run(input) {
      return { outputText: "ok", sessionId: null, usage: null };
    },
  });
}
```

Load via `AIF_RUNTIME_MODULES=./my-adapter.js`.
