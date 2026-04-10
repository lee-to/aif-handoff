# Handoff — Architecture

## Overview

AIF Handoff is a Turborepo monorepo of 6 packages. The React Kanban UI lets you create tasks, the API and Agent work through a centralized data layer on SQLite, and AI execution goes through `@aif/runtime` — provider-neutral.

```
Web (React) ←──HTTP/WS──► API (Hono)
                               │
Runtime adapters ◄────────► Agent
                               │
                          @aif/runtime
                               │
                          @aif/data
                               │
                           SQLite
```

## Packages

| Package        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `@aif/shared`  | Types, schema, state machine, logger               |
| `@aif/runtime` | Pluggable AI providers (Claude, Codex, OpenRouter) |
| `@aif/data`    | Centralized database access                        |
| `@aif/api`     | Hono REST + WebSocket (port 3009)                  |
| `@aif/web`     | React Kanban UI (port 5180)                        |
| `@aif/agent`   | Coordinator + subagent orchestration               |

## Task Pipeline

```
Backlog → Planning → Plan Ready → Implementing → Review → Done → Verified
```

| Transition           | Agent                                 | Description                                |
| -------------------- | ------------------------------------- | ------------------------------------------ |
| Backlog → Plan Ready | `plan-coordinator`                    | Iterative plan development                 |
| Plan Ready → Review  | `implement-coordinator`               | Parallel execution + quality sidecars      |
| Review → Done        | `review-sidecar` + `security-sidecar` | Code review and security audit in parallel |

## State Machine

| Status             | User Actions                                             |
| ------------------ | -------------------------------------------------------- |
| `backlog`          | `start_ai`                                               |
| `plan_ready`       | `start_implementation`, `request_replanning`, `fast_fix` |
| `blocked_external` | `retry_from_blocked`                                     |
| `done`             | `approve_done`, `request_changes`                        |
| `verified`         | (final status)                                           |

## Reliability

- **First-activity watchdog** — if the agent makes no tool call within 60s of starting, it restarts (up to 2 times)
- **Heartbeat** — tasks update `lastHeartbeatAt` while running
- **Stale watchdog** — tasks stuck in planning/implementing/review longer than timeout are automatically moved to `blocked_external`

## Parallel Execution (experimental)

Enabled in project settings. Up to `COORDINATOR_MAX_CONCURRENT_TASKS` (default 3) tasks run simultaneously. Tasks are atomically claimed via `lockedBy`/`lockedUntil` to avoid duplication.

## Real-time Updates

WebSocket at `/ws` broadcasts events to all clients:

| Event          | Trigger                           |
| -------------- | --------------------------------- |
| `task:created` | Task created                      |
| `task:updated` | Task fields updated               |
| `task:moved`   | Status changed                    |
| `task:deleted` | Task deleted                      |
| `agent:wake`   | Coordinator should check for work |
