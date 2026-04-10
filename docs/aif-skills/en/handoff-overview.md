# AIF Handoff — Overview

> Autonomous Kanban board where AI agents plan, implement, and review your tasks — fully hands-off.

> This project was built using [AI Factory](https://github.com/lee-to/ai-factory) — an open-source framework for AI-driven development.

Tasks flow through stages automatically: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — each stage orchestrated by specialized AI subagents. In auto mode, review feedback can also trigger an automatic rework loop: **Review → request_changes → Implementing**.

## Runtime Providers Out of the Box

| Provider                      | Transports    |
| ----------------------------- | ------------- |
| **Claude** (`anthropic`)      | SDK, CLI, API |
| **Codex** (`openai`)          | SDK, CLI, API |
| **OpenRouter** (`openrouter`) | API           |
| **OpenCode** (`opencode`)     | API           |

> **⚠️ Warning:** Anthropic prohibits using Claude Max / Pro subscriptions outside of the official Claude Code CLI. The SDK transport for Claude calls the Agent SDK directly, which may violate these terms. Use API transport with `ANTHROPIC_API_KEY` for production.

Need something custom? Add your own runtime adapter module and load it via `AIF_RUNTIME_MODULES`. No fork required.

## Key Features

- **Fully autonomous pipeline** — create a task, AI plans, implements, and reviews it
- **Kanban UI** — drag-and-drop board with real-time WebSocket updates
- **AI Factory core** — built on [ai-factory](https://github.com/lee-to/ai-factory) agent definitions and skill system
- **Subagent orchestration** — plan-coordinator, implement-coordinator, review + security sidecars
- **Runtime/provider modularity** — runtime registry, project/task runtime profile selection
- **Self-healing pipeline** — heartbeat + stale-stage watchdog auto-recovers stuck agent stages
- **Human-in-the-loop** — approve plans, request changes, or let auto-mode handle everything
- **MCP sync** — bidirectional task sync between Handoff and AIF tools via Model Context Protocol

## Agent Pipeline

| Stage                | Agent                                 | What it does                                  |
| -------------------- | ------------------------------------- | --------------------------------------------- |
| Backlog → Plan Ready | `plan-coordinator`                    | Iterative plan refinement via `plan-polisher` |
| Plan Ready → Review  | `implement-coordinator`               | Parallel execution with quality sidecars      |
| Review → Done        | `review-sidecar` + `security-sidecar` | Code review and security audit in parallel    |

## Execution Modes

| Mode          | `AGENT_USE_SUBAGENTS` | Description                                                                                        |
| ------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| **Subagents** | `true` (default)      | Each stage through specialized coordinators with iterative refinement. Higher quality, more tokens |
| **Skills**    | `false`               | Single-pass via aif-\* skills. Faster and cheaper, no iteration                                    |

## Quick Start

```bash
# Without Docker
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install && npm run init && npm run dev

# With Docker
docker compose up --build
```

| Service | URL                     | Description           |
| ------- | ----------------------- | --------------------- |
| API     | `http://localhost:3009` | Hono REST + WebSocket |
| Web UI  | `http://localhost:5180` | React Kanban board    |
| Agent   | _(background)_          | Polls tasks every 30s |

See also: [Getting Started](./handoff-getting-started.md)
