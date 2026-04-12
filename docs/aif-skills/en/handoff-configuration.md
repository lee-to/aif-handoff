# Handoff — Configuration

Everything is configured via environment variables. Copy `.env.example` to `.env`.

## Core variables

| Variable                   | Default             | Description                                     |
| -------------------------- | ------------------- | ----------------------------------------------- |
| `ANTHROPIC_API_KEY`        | —                   | Anthropic API key (or use `claude login`)       |
| `PORT`                     | `3009`              | API server port                                 |
| `WEB_PORT`                 | `5180`              | Web UI port (Vite)                              |
| `DATABASE_URL`             | `./data/aif.sqlite` | SQLite database path                            |
| `AGENT_BYPASS_PERMISSIONS` | `true`              | Auto-approve all agent actions                  |
| `AGENT_USE_SUBAGENTS`      | `true`              | `true` = custom agents, `false` = aif-\* skills |
| `POLL_INTERVAL_MS`         | `30000`             | Coordinator polling interval (ms)               |
| `LOG_LEVEL`                | `debug`             | Logging level                                   |

## Timeouts

| Variable                          | Default   | Description                       |
| --------------------------------- | --------- | --------------------------------- |
| `AGENT_STAGE_STALE_TIMEOUT_MS`    | `5400000` | Stuck task timeout (90 min)       |
| `AGENT_STAGE_RUN_TIMEOUT_MS`      | `3600000` | Max per stage (60 min)            |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` | `60000`   | First-activity watchdog (60 sec)  |
| `API_RUNTIME_RUN_TIMEOUT_MS`      | `120000`  | One-shot API call timeout (2 min) |

## AI Providers

| Variable              | Description                                |
| --------------------- | ------------------------------------------ |
| `OPENAI_API_KEY`      | For Codex/OpenAI adapters                  |
| `OPENROUTER_API_KEY`  | For OpenRouter adapter                     |
| `AIF_RUNTIME_MODULES` | External runtime modules (comma-separated) |

## Agent permissions

**Simple way** — `AGENT_BYPASS_PERMISSIONS=true` (default). All tools are approved automatically.

**Granular** — `AGENT_BYPASS_PERMISSIONS=false` + allow rules in `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm run:*)", "Bash(git:*)"]
  }
}
```

## Telegram notifications

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=987654321
```

Get your `TELEGRAM_USER_ID` from [@userinfobot](https://t.me/userinfobot).

## Project config (config.yaml)

The `.ai-factory/config.yaml` file in the project root overrides paths and behavior for a specific project. Editable via **Global Settings** (gear icon in the header).

### AI artifact language

```yaml
language:
  ui: en # agent interface language
  artifacts: en # language for generated documents
```

### Custom paths

```yaml
paths:
  plan: .ai-factory/PLAN.md
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
```

### Git settings

```yaml
git:
  base_branch: main
  create_branches: true
  branch_prefix: feature/
  skip_push_after_commit: false
```
