# AGENTS.md

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Project Overview

Autonomous task management system with Kanban board and AI subagents. Tasks flow through stages automatically (Backlog → Planning → Plan Ready → Implementing → Review → Done), each handled by runtime-resolved subagent workflows.

## Tech Stack

- **Language:** TypeScript (ES2022, ESNext modules)
- **Monorepo:** Turborepo (npm workspaces)
- **API:** Hono + WebSocket
- **Runtime Abstraction:** `@aif/runtime` workspace (runtime/provider contracts + registry)
- **Database:** SQLite (better-sqlite3 + drizzle-orm)
- **Frontend:** React 19 + Vite + TailwindCSS 4
- **Runtime:** Pluggable adapter system (`@aif/runtime`) — built-in Claude (Agent SDK) + Codex (CLI/API) + OpenRouter (API) adapters
- **Agent:** Runtime-neutral coordinator + node-cron
- **Testing:** Vitest

## Project Structure

```
packages/
├── shared/              # @aif/shared — contracts, schema, state machine, env, constants, logger
│   └── src/
│       ├── schema.ts        # Drizzle ORM schema (SQLite)
│       ├── types.ts         # Shared TypeScript types + RuntimeTransport enum
│       ├── stateMachine.ts  # Task stage transitions
│       ├── constants.ts     # App constants
│       ├── env.ts           # Environment validation
│       ├── logger.ts        # Pino logger setup
│       ├── index.ts         # Node exports
│       └── browser.ts       # Browser-safe exports
├── runtime/             # @aif/runtime — runtime/provider contracts, registry, validation/discovery services, adapters
│   └── src/
│       ├── index.ts         # Public API exports
│       ├── types.ts         # RuntimeAdapter interface, capabilities, execution intent
│       ├── registry.ts      # RuntimeRegistry — adapter registration and lookup
│       ├── bootstrap.ts     # Factory: create registry with built-in adapters
│       ├── resolution.ts    # Profile resolution (task → project → system → env fallback)
│       ├── readiness.ts     # Health check across all registered runtimes
│       ├── capabilities.ts  # Capability assertion before workflow execution
│       ├── promptPolicy.ts  # Agent definition vs slash-command fallback
│       ├── workflowSpec.ts  # Workflow kind, session reuse, required capabilities
│       ├── modelDiscovery.ts # Model listing + connection validation with cache
│       ├── cache.ts         # Generic in-memory TTL cache
│       ├── trust.ts         # Opaque Symbol-based trust token for permission bypass
│       ├── errors.ts        # Runtime error hierarchy
│       ├── module.ts        # Dynamic module loader for external adapters
│       └── adapters/
│           ├── TEMPLATE.ts      # Adapter development guide + skeleton
│           ├── claude/          # Claude adapter (Agent SDK transport)
│           ├── codex/           # Codex adapter (CLI + API transports)
│           └── openrouter/      # OpenRouter adapter (API transport)
├── data/                # @aif/data — centralized data-access layer
│   └── src/
│       └── index.ts         # Repository-style DB operations for API/Agent
├── api/                 # @aif/api — Hono REST + WebSocket server (port 3009)
│   └── src/
│       ├── index.ts         # Server entry point
│       ├── routes/          # tasks.ts, projects.ts, chat.ts, runtimeProfiles.ts
│       ├── services/        # runtime.ts, fastFix.ts, roadmapGeneration.ts
│       ├── middleware/      # logger.ts, rateLimit.ts, zodValidator.ts
│       ├── schemas.ts       # Zod request validation
│       └── ws.ts            # WebSocket handler
├── web/                 # @aif/web — React Kanban UI (port 5180)
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # TaskDetail, TaskPlan, TaskLog, AgentTimeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector, ProjectRuntimeSettings
│       │   ├── settings/    # RuntimeProfileForm
│       │   └── ui/          # Reusable UI primitives (badge, button, dialog, etc.)
│       ├── hooks/           # useTasks, useProjects, useWebSocket, useTheme, useRuntimeProfiles
│       └── lib/             # api.ts, notifications.ts, utils.ts
└── agent/               # @aif/agent — Coordinator + runtime-driven subagent orchestration
    └── src/
        ├── index.ts         # Agent entry point
        ├── coordinator.ts   # Polling coordinator (node-cron)
        ├── subagentQuery.ts # Universal runtime-backed query execution
        ├── reviewGate.ts    # Auto-review gate using adapter lightModel
        ├── hooks.ts         # Activity logging, project root
        ├── stderrCollector.ts # Generic stderr ring-buffer
        ├── notifier.ts      # Notification system
        └── subagents/       # planner.ts, implementer.ts, reviewer.ts

.claude/agents/          # Claude-native agent definitions
.docker/                 # Dockerfile, entrypoint, Angie configs
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
| .ai-factory/references/     | AI provider SDK reference docs        |

## Agent Rules

- Never combine shell commands with `&&`, `||`, or `;` — execute each command as a separate Bash tool call. This applies even when a skill, plan, or instruction provides a combined command — always decompose it into individual calls.
  - Wrong: `git checkout main && git pull`
  - Right: Two separate Bash tool calls — first `git checkout main`, then `git pull`

- DB boundary is mandatory: `api`, `agent`, and `runtime` access database only through `@aif/data`. Direct imports of DB helpers from `@aif/shared/server` and direct SQL construction imports are blocked by ESLint.

## Package Checklist Rule

**CRITICAL:** Check the `CHECKLIST.md` file and ensure all items are completed.

## UI Component Rules

- **Reuse existing components first.** Before creating a new UI component, check `packages/web/src/components/ui/` for an existing primitive that fits the need. Compose existing primitives (e.g. `Dialog` + `Button`) instead of writing new wrappers.
- **Pencil sync required for new components.** If a new UI component is genuinely needed, its design must be synced with the Pencil design system (`.pen` files) using the `pencil` MCP tools (`batch_design`, `get_guidelines`). Never add a visual component to the codebase without a corresponding Pencil representation.
- **UI primitives live in `packages/web/src/components/ui/`.** Domain-specific compositions belong in their feature folder (e.g. `components/task/`, `components/kanban/`).
- **No expensive CSS properties.** Never use `box-shadow`, `backdrop-filter`, `filter: blur()`, `text-shadow`, or other GPU/paint-heavy CSS in components. These trigger costly compositing and repaint cycles, especially on low-end devices and during scroll/animation. Use `border`, `outline`, `opacity`, or solid `background-color` as lightweight alternatives.

## Docker Sync Rule

- **Docker config must stay in sync with packages.** When adding a new package under `packages/` or introducing new inter-package dependencies, update the Docker configuration accordingly:
  - `.docker/Dockerfile` — add build stages, `COPY` directives, and build steps for the new package.
  - `docker-compose.yml` / `docker-compose.production.yml` — add or update services, volumes, and dependency links as needed.
  - Verify the Docker build still succeeds after changes: `docker compose build`.

## Runtime Adapter Sync Rule

- **Docs must stay in sync when adding or modifying runtime adapters.** When a new adapter is added to `packages/runtime/src/adapters/` or an existing adapter's capabilities change:
  - `docs/providers.md` — update the "Supported Runtimes" table.
  - `packages/runtime/src/adapters/TEMPLATE.ts` — verify the template still reflects current conventions.
  - `packages/runtime/src/bootstrap.ts` — register the new built-in adapter.
  - `.docker/Dockerfile` — add any new system-level dependencies.

## Project Rules

- Every package must maintain at least 70% test coverage (measured by @vitest/coverage-v8)
- Write code following SOLID and DRY principles
- Always run after implementation: `npm run ai:validate`
