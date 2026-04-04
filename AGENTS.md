# AGENTS.md

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Project Overview

Autonomous task management system with Kanban board and AI subagents. Tasks flow through stages automatically (Backlog → Planning → Plan Ready → Implementing → Review → Done), each handled by runtime-resolved subagent workflows (Claude adapter first).

## Tech Stack

- **Language:** TypeScript (ES2022, ESNext modules)
- **Monorepo:** Turborepo (npm workspaces)
- **API:** Hono + WebSocket
- **Runtime Abstraction:** `@aif/runtime` workspace (runtime/provider contracts + registry)
- **Database:** SQLite (better-sqlite3 + drizzle-orm)
- **Frontend:** React 19 + Vite + TailwindCSS 4
- **Agent:** Claude Agent SDK + node-cron
- **Testing:** Vitest

## Project Structure

```
packages/
├── shared/              # @aif/shared — contracts, schema, state machine, env, constants, logger
│   └── src/
│       ├── schema.ts        # Drizzle ORM schema (SQLite)
│       ├── types.ts         # Shared TypeScript types
│       ├── stateMachine.ts  # Task stage transitions
│       ├── constants.ts     # App constants
│       ├── env.ts           # Environment validation
│       ├── logger.ts        # Pino logger setup
│       ├── index.ts         # Node exports
│       └── browser.ts       # Browser-safe exports
├── runtime/             # @aif/runtime — runtime/provider contracts, registry, validation/discovery services, adapters
│   └── src/
│       ├── types.ts         # RuntimeAdapter/RuntimeRunInput/RuntimeSession contracts
│       ├── registry.ts      # Runtime registry + built-in/module registration
│       ├── module.ts        # registerRuntimeModule export resolution helpers
│       ├── errors.ts        # Runtime-specific error types
│       ├── resolution.ts    # Persisted profile + env resolution and validation
│       ├── capabilities.ts  # Capability gate helpers and errors
│       ├── modelDiscovery.ts # Shared model discovery + connection validation service
│       ├── cache.ts         # In-memory cache utility for runtime services
│       ├── workflowSpec.ts  # Runtime-independent workflow contract
│       ├── promptPolicy.ts  # Agent-definition vs slash-command fallback logic
│       ├── adapters/
│       │   └── claude/      # ClaudeRuntimeAdapter (run/sessions/errors/hooks)
│       └── index.ts         # Public runtime exports
├── data/                # @aif/data — centralized data-access layer
│   └── src/
│       └── index.ts         # Repository-style DB operations for API/Agent
├── api/                 # @aif/api — Hono REST + WebSocket server (port 3009)
│   └── src/
│       ├── index.ts         # Server entry point
│       ├── routes/          # tasks.ts, projects.ts
│       ├── middleware/      # logger.ts
│       ├── schemas.ts       # Zod request validation
│       └── ws.ts            # WebSocket handler
├── web/                 # @aif/web — React Kanban UI (port 5180)
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # TaskDetail, TaskPlan, TaskLog, AgentTimeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector
│       │   └── ui/          # Reusable UI primitives (badge, button, dialog, etc.)
│       ├── hooks/           # useTasks, useProjects, useWebSocket, useTheme
│       └── lib/             # api.ts, notifications.ts, utils.ts
└── agent/               # @aif/agent — Coordinator + runtime-driven subagent orchestration
    └── src/
        ├── index.ts         # Agent entry point
        ├── coordinator.ts   # Polling coordinator (node-cron)
        ├── subagentQuery.ts # Runtime profile resolution + registry execution
        ├── hooks.ts         # Agent lifecycle hooks
        ├── notifier.ts      # Notification system
        ├── claudeDiagnostics.ts  # Agent SDK diagnostics
        └── subagents/       # planner.ts, implementer.ts, reviewer.ts

.claude/agents/          # Agent definitions (loaded by Claude Agent SDK)
data/                    # SQLite database files (gitignored)
.ai-factory/             # AI Factory context and references
```

## Key Entry Points

| File                                  | Purpose                               |
| ------------------------------------- | ------------------------------------- |
| `packages/api/src/index.ts`           | API server entry (Hono, port 3009)    |
| `packages/web/src/main.tsx`           | Web app entry (React, port 5180)      |
| `packages/agent/src/index.ts`         | Agent coordinator entry               |
| `packages/agent/src/subagentQuery.ts` | Runtime-aware subagent execution path |
| `packages/runtime/src/index.ts`       | Shared runtime/provider contracts     |
| `packages/data/src/index.ts`          | Centralized data-access API           |
| `packages/shared/src/schema.ts`       | Database schema (drizzle-orm)         |
| `packages/shared/src/stateMachine.ts` | Task state transitions                |
| `turbo.json`                          | Turborepo task definitions            |

## Documentation

| Document        | Path                    | Description                              |
| --------------- | ----------------------- | ---------------------------------------- |
| README          | README.md               | Project landing page                     |
| Getting Started | docs/getting-started.md | Installation, setup, first steps         |
| Architecture    | docs/architecture.md    | Agent pipeline, state machine, data flow |
| API Reference   | docs/api.md             | REST endpoints, WebSocket events         |
| Configuration   | docs/configuration.md   | Environment variables, logging, auth     |

## AI Context Files

| File                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| CLAUDE.md                   | Project instructions for Claude Code  |
| AGENTS.md                   | This file — project structure map     |
| .ai-factory/DESCRIPTION.md  | Project specification and tech stack  |
| .ai-factory/ARCHITECTURE.md | Architecture decisions and guidelines |
| .ai-factory/RULES.md        | Project rules and conventions         |
| .ai-factory/references/     | Claude Agent SDK reference docs       |

## Agent Rules

- Never combine shell commands with `&&`, `||`, or `;` — execute each command as a separate Bash tool call. This applies even when a skill, plan, or instruction provides a combined command — always decompose it into individual calls.
  - Wrong: `git checkout main && git pull`
  - Right: Two separate Bash tool calls — first `git checkout main`, then `git pull`

- DB boundary is mandatory: `api` and `agent` access database only through `@aif/data`. Direct imports of DB helpers from `@aif/shared/server` and direct SQL construction imports are blocked by ESLint.

## Project Rules

- Every package must maintain at least 70% test coverage (measured by @vitest/coverage-v8)
- Write code following SOLID and DRY principles
- Always run linter after implementation: `npm run lint`
- Always run tests after implementation: `npm test`
