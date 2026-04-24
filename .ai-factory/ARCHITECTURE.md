# Architecture: Modular Monolith

## Overview

AIF Handoff uses a Modular Monolith architecture implemented via Turborepo workspaces. Each package (`shared`, `data`, `api`, `web`, `agent`) is an independent module with its own build, tests, and dependencies — but they deploy and run together as a single system.

This architecture was chosen because the project has clear domain boundaries (data layer, API, UI, agent orchestration) that benefit from strong module separation, while the small team and single-system deployment make microservices unnecessary overhead.

## Decision Rationale

- **Project type:** Autonomous task management system with Kanban UI and AI agent pipeline
- **Tech stack:** TypeScript monorepo (Turborepo), Hono API, React frontend, pluggable runtime adapters
- **Key factor:** Natural module boundaries already exist via Turborepo workspaces — formalizing the pattern prevents coupling drift

## Folder Structure

```
packages/
├── shared/              # @aif/shared — foundation contracts module
│   └── src/
│       ├── schema.ts        # Drizzle ORM table definitions
│       ├── types.ts         # Shared TypeScript types & interfaces
│       ├── stateMachine.ts  # Task stage transition rules
│       ├── constants.ts     # Application constants
│       ├── env.ts           # Environment config validation (zod)
│       ├── logger.ts        # Pino logger factory
│       ├── index.ts         # Public API (Node.js)
│       └── browser.ts       # Public API (browser-safe subset)
│
├── runtime/             # @aif/runtime — runtime/provider abstraction + adapter services
│   └── src/
│       ├── types.ts         # Runtime contracts (adapter/input/output/session/capabilities)
│       ├── registry.ts      # Runtime registration + module loading
│       ├── module.ts        # registerRuntimeModule export resolver
│       ├── errors.ts        # Runtime domain errors
│       ├── resolution.ts    # Runtime profile merge + env/auth resolution
│       ├── capabilities.ts  # Capability gating helpers
│       ├── modelDiscovery.ts # Model listing + connection validation service
│       ├── cache.ts         # Shared runtime memory cache utility
│       ├── workflowSpec.ts  # Runtime-independent workflow contract
│       ├── promptPolicy.ts  # Agent-definition fallback policy
│       ├── adapters/
│       │   └── claude/      # Claude adapter (run, sessions, hooks, error mapping)
│       └── index.ts         # Public runtime API
│
├── data/                # @aif/data — centralized data-access module
│   └── src/
│       └── index.ts         # Repository-style DB operations
│
├── api/                 # @aif/api — HTTP + WebSocket server module
│   └── src/
│       ├── index.ts         # Server bootstrap (Hono + node-server)
│       ├── routes/          # Route handlers (tasks.ts, projects.ts)
│       ├── middleware/      # Hono middleware (logger.ts)
│       ├── schemas.ts       # Request validation schemas (zod)
│       └── ws.ts            # WebSocket event handler
│
├── web/                 # @aif/web — React SPA module
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # TaskDetail, TaskPlan, TaskLog, AgentTimeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector
│       │   └── ui/          # Reusable primitives (button, dialog, badge, etc.)
│       ├── hooks/           # React hooks (useTasks, useWebSocket, useTheme, etc.)
│       └── lib/             # Utilities (api.ts, notifications.ts, utils.ts)
│
└── agent/               # @aif/agent — Agent orchestration module
    └── src/
        ├── index.ts         # Agent bootstrap
        ├── coordinator.ts   # Polling loop (node-cron, 30s interval)
        ├── subagentQuery.ts # Runtime-aware execution bridge
        ├── hooks.ts         # Agent lifecycle hooks
        ├── notifier.ts      # Notification dispatch
        ├── claudeDiagnostics.ts  # Agent SDK health checks
        └── subagents/       # Subagent launchers (planner, implementer, reviewer)

.claude/agents/          # Claude-native custom agents loaded by Claude runtimes
```

## Dependency Rules

Module dependency graph (arrows = "depends on"):

```
web ──→ shared (browser export)
data ──→ shared
api ──→ data
api ──→ runtime
agent ──→ data
agent ──→ runtime
```

### Allowed

- ✅ `data` → import from `@aif/shared`
- ✅ `runtime` → standalone abstraction package used by `api` and `agent`
- ✅ `api`, `agent` → import from `@aif/data` for DB operations
- ✅ `api`, `agent` → import runtime contracts and registry from `@aif/runtime`
- ✅ `api`, `agent`, `web` → import shared contracts/types from `@aif/shared` as needed
- ✅ `web` → import from `@aif/shared/browser` (browser-safe subset)
- ✅ `web` → call `api` via HTTP/WebSocket at runtime (not import)
- ✅ `agent` → call `api` via HTTP at runtime for broadcasts

### Forbidden

- ❌ `shared` → import from `api`, `web`, or `agent` (shared is the foundation, no upward deps)
- ❌ `data` → import from `api`, `web`, or `agent`
- ❌ `runtime` → import from `api`, `agent`, or `web` (runtime is shared infra, no upward deps)
- ❌ `api` → import from `web` or `agent` (API is independent)
- ❌ `web` → import from `api` or `agent` (UI communicates via HTTP/WS only)
- ❌ `agent` → import from `api` or `web` (agent runtime integration is via HTTP, not code imports)
- ❌ Cross-package deep imports (e.g., `@aif/shared/src/db` — use public API only)
- ❌ DB access from `api`/`agent` outside `@aif/data` (enforced by lint guards)

## Module Communication

- **web ↔ api:** HTTP REST calls + WebSocket for real-time updates
- **api/agent → data:** DB operations through centralized repository layer
- **api/agent → runtime:** Runtime/provider selection and adapter execution via shared registry APIs
- **data → shared:** Uses shared schema, DB helpers, and data contracts
- **agent → api:** HTTP REST calls for WebSocket broadcasts (best-effort via notifier.ts)
- **runtime adapters → provider SDKs:** Each adapter (Claude, Codex, custom) wraps its provider SDK while agent/api stay provider-agnostic
- **Shared types:** All modules import types and schemas from `@aif/shared`

## Key Principles

1. **Public API via exports** — Each package exposes its API through `exports` in `package.json`. Never import internal files directly. `shared` has two entry points: `index.ts` (Node) and `browser.ts` (browser-safe).

2. **Shared is pure foundation** — The `shared` package contains only types, schemas, validation, and utilities. It has zero knowledge of HTTP, React, or agent logic. If code needs framework-specific features, it belongs in the consuming module.

3. **Runtime communication over imports** — Modules that need to interact at runtime (web→api, agent→api) do so via HTTP/WebSocket, never via direct imports.

4. **Single source of truth for data access** — Database schema and low-level primitives live in `shared`, but all reads/writes outside `shared` go through `@aif/data`. This keeps query construction and repository logic centralized. `web` always goes through the API via HTTP/WebSocket.

5. **Agent definitions are config, not code** — Subagent behavior is defined in runtime-facing agent assets. The `agent` package orchestrates when to invoke them, not what they do.

6. **Code quality principles are mandatory** — All modules must follow SOLID and DRY principles to keep responsibilities clear, reduce duplication, and preserve maintainability as the monorepo grows.

## Code Examples

### Importing from shared (correct)

```typescript
// In packages/api/src/routes/tasks.ts
import { listTasks, toTaskResponse } from "@aif/data";
import { TaskStatus } from "@aif/shared";

// In packages/web/src/hooks/useTasks.ts
import { TaskStatus, type Task } from "@aif/shared/browser";
```

### Adding a new API route

```typescript
// packages/api/src/routes/newFeature.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createTask, toTaskResponse } from "@aif/data";

const app = new Hono();

app.post("/", async (c) => {
  const body = await c.req.json();
  const created = createTask({
    projectId: body.projectId,
    title: body.title,
    description: body.description,
  });
  return c.json(created ? toTaskResponse(created) : null);
});

export default app;
```

### Agent runtime execution pattern

```typescript
// packages/agent/src/subagentQuery.ts
import {
  assertRuntimeCapabilities,
  createClaudeRuntimeAdapter,
  createRuntimeRegistry,
  createRuntimeWorkflowSpec,
} from "@aif/runtime";

export async function executeRuntimeQuery(prompt: string) {
  const registry = createRuntimeRegistry({
    builtInAdapters: [createClaudeRuntimeAdapter()],
  });
  const runtime = registry.resolveRuntime("claude");
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: "planner",
    prompt,
    requiredCapabilities: ["supportsAgentDefinitions"],
    agentDefinitionName: "plan-coordinator",
  });

  assertRuntimeCapabilities({
    runtimeId: runtime.descriptor.id,
    workflowKind: workflow.workflowKind,
    capabilities: runtime.descriptor.capabilities,
    required: workflow.requiredCapabilities,
  });

  return runtime.run({
    runtimeId: runtime.descriptor.id,
    providerId: runtime.descriptor.providerId,
    workflowKind: workflow.workflowKind,
    prompt: workflow.promptInput.prompt,
  });
}
```

### Web calling API (correct runtime communication)

```typescript
// packages/web/src/lib/api.ts
const API_BASE = "http://localhost:3009";

export async function fetchTasks(projectId: string) {
  const res = await fetch(`${API_BASE}/api/tasks?projectId=${projectId}`);
  return res.json();
}
```

## Anti-Patterns

- ❌ **Importing across sibling packages** — Never `import { something } from "@aif/api"` inside `@aif/web`. Use HTTP calls instead.
- ❌ **Putting DB queries in api/agent directly** — Keep data access in `@aif/data`. Routes/coordinator should stay thin.
- ❌ **Shared depending on Node-only APIs without a browser guard** — `shared/browser.ts` must remain browser-safe. Node-only code stays in `shared/index.ts`.
- ❌ **Hardcoding agent prompts in TypeScript** — Agent behavior belongs in `.claude/agents/*.md` files, not in the `agent` package source code.
- ❌ **Introducing new external clients with direct DB writes** — `web` and any third-party integrations must go through API endpoints.
