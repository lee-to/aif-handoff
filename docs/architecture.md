[← Getting Started](getting-started.md) · [Back to README](../README.md) · [API Reference →](api.md)

# Architecture

## Overview

AIF Handoff is a Turborepo monorepo with six packages. The system automates task management: a React Kanban UI lets users create tasks, the API and agent operate through a centralized data layer backed by SQLite, and runtime execution goes through `@aif/runtime` so orchestration is provider-neutral.

```
┌─────────────┐     HTTP/WS      ┌─────────────┐
│   Web (UI)  │ ◄──────────────► │  API Server  │
│  React+Vite │                  │    Hono      │
└─────────────┘                  └──────┬───────┘
                                        │
┌───────────────┐   Runtime API   ┌──────┴───────┐
│ Runtime/Provider│ ◄────────────► │    Agent     │
│ adapters        │                │ Coordinator  │
└───────────────┘                  └──────┬───────┘
                                          │
                                   ┌──────┴───────┐
                                   │ @aif/runtime  │
                                   │ (registry +   │
                                   │ workflow spec)│
                                   └──────┬───────┘
                                        │
                                 ┌──────┴───────┐
                                 │ @aif/data     │
                                 │ (DB access)   │
                                 └──────┬───────┘
                                        │ SQLite
                                 ┌──────┴───────┐
                                 │   Database    │
                                 │ (drizzle-orm) │
                                 └──────────────┘
```

## Packages

| Package            | Name           | Purpose                                                       |
| ------------------ | -------------- | ------------------------------------------------------------- |
| `packages/shared`  | `@aif/shared`  | Types, schema, state machine, constants, env, logger          |
| `packages/runtime` | `@aif/runtime` | Runtime/provider contracts, registry, adapters, module loader |
| `packages/data`    | `@aif/data`    | Centralized DB access layer (all SQL/repository operations)   |
| `packages/api`     | `@aif/api`     | Hono REST + WebSocket server (port 3009)                      |
| `packages/web`     | `@aif/web`     | React Kanban UI (port 5180)                                   |
| `packages/agent`   | `@aif/agent`   | Coordinator + runtime-driven subagent orchestration           |

### Dependency Graph

```
shared ← data
shared ← runtime
runtime ← api
runtime ← agent
shared ← web (browser export only)
data   ← api
data   ← agent
```

No cross-dependencies between `api`, `web`, and `agent`. Runtime integration is:

- `web` ↔ `api` via HTTP/WebSocket
- `agent`/`api` → `@aif/runtime` for run/resume/session/model-discovery flows
- `api`/`agent` → SQLite via `@aif/data`
- `agent` → `api` via HTTP for best-effort broadcast notifications
- Lint guard enforces this boundary: `api` and `agent` cannot import DB helpers from `@aif/shared` or SQL builders directly.

## Runtime Registry and Profile Resolution

Runtime execution is centralized in `packages/runtime`:

- `registry.ts` registers built-in adapters and optional external modules (`AIF_RUNTIME_MODULES`).
- `workflowSpec.ts` defines runtime-independent execution intent (`planner`, `implementer`, `reviewer`, one-shot API flows).
- `resolution.ts` merges profile data + env secrets + model/runtime overrides with capability checks.

Effective task profile selection order is:

1. Task override (`tasks.runtime_profile_id`)
2. Project default (`projects.default_task_runtime_profile_id`)
3. System default (optional runtime bootstrap configuration)

The same pattern applies to chat mode using `default_chat_runtime_profile_id`.

### Runtime-Limit Snapshots and Auto-Pause

Runtime-limit state is normalized once in `@aif/runtime` and then persisted in SQLite so every process sees the same view:

- adapters translate provider-specific quota signals into a shared `runtimeLimitSnapshot` contract;
- `runtime_profiles.runtime_limit_snapshot_json` stores the latest authoritative profile-level state;
- `tasks.runtime_limit_snapshot_json` stores a task-level copy when work is blocked by quota pressure or hard exhaustion.
- API runs a background Codex indexer that reconciles `~/.codex/sessions` into SQLite read-model tables (`codex_sessions`, `codex_limit_heads`, `codex_limit_history`, `codex_index_cursors`) so hot endpoints (`/chat/sessions`, `/runtime-profiles`) use DB reads instead of request-path filesystem scans.

The source is explicit in the snapshot (`provider_api`, `sdk_event`, `api_headers`, `turn_usage`) so upper layers do not need adapter-specific branching.

The coordinator treats persisted profile state as authoritative:

- exact snapshots can proactively gate new work when the configured safety threshold has already been crossed;
- heuristic snapshots can proactively gate new work when the provider says the runtime is blocked;
- blocked tasks resume through the existing `blocked_external` + `retryAfter` release path when the provider reset time arrives.

Short-lived in-memory caches exist only for dedupe/throttling repeated identical writes; they are not the source of truth.

## Agent Pipeline

The coordinator (`packages/agent/src/coordinator.ts`) uses a dual-trigger model: it polls via `node-cron` every 30 seconds as a fallback and also reacts to real-time events from the API WebSocket (task creation, moves, and explicit `agent:wake` signals). Duplicate wakes are debounced. If the WebSocket is unavailable, the coordinator falls back to polling-only mode.

The coordinator supports **parallel task execution** (experimental, per-project). When a project has "Parallel Execution" enabled in settings, up to `COORDINATOR_MAX_CONCURRENT_TASKS` (default 3) tasks per stage run concurrently via `Promise.allSettled`. This value also serves as the global cap on total concurrent Claude processes across all stages and projects. Non-parallel projects always process 1 task at a time. Tasks are atomically claimed (`lockedBy`/`lockedUntil` columns) with lock duration tied to the stage timeout; heartbeats renew the lock periodically. Stale claims (expired TTL or dead heartbeat) are auto-released. On shutdown, active locks are released immediately.

It delegates workflow stages to `.claude/agents/` definitions, but actual execution transport/model/session behavior is adapter-owned through `@aif/runtime`:

```
Backlog ──[start_ai]──► Planning ──► Plan Ready ──► Implementing ──► Review ──► Done ──► Verified
                            │              │              │              │           │
                            │              │              │              │           └─[request_changes]──► Implementing (rework)
                            │              │              │              └─[auto-mode review gate]──► request_changes ─► Implementing (rework)
                            │              │              │              │
                            │              └─[request_    │              └─────────────────────────────────►
                            │                replanning]──┘
                            │
                     plan-coordinator          implement-coordinator        review + security sidecars
```

| Stage Transition                                                                                 | Agent                                                                     | Description                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backlog → Planning → Plan Ready                                                                  | `plan-coordinator`                                                        | Iterative plan refinement via `plan-polisher`                                                                                                          |
| Plan Ready → Implementing → Review                                                               | `implement-coordinator`                                                   | Parallel execution with worktrees + quality sidecars                                                                                                   |
| Review → Done / Review → request_changes → Implementing / Review → Done + manual review required | `review-sidecar` + `security-sidecar` (+ auto review gate in coordinator) | Code review and security audit in parallel; in auto mode, structured blocking findings drive automatic rework until success or explicit manual handoff |

### Reliability Guards

The pipeline includes four reliability layers for long-running autonomous execution:

- **First-activity watchdog (SDK only):** After agent start, if no tool call or subagent spawn arrives within `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` (default 60s), the agent is killed and restarted (up to 2 retries). Detects hung agents within seconds instead of waiting for the stale timeout. Disabled for CLI/API transports which do not stream tool events.
- **Heartbeat liveness:** Task rows are updated with `lastHeartbeatAt` during agent activity and stage transitions.
- **Stale-stage watchdog:** On each poll cycle, tasks stuck in `planning` / `implementing` / `review` beyond timeout are auto-recovered to `blocked_external` with retry backoff.
- **Runtime-limit auto-pause:** Exact/heuristic persisted runtime-limit snapshots can proactively move new work to `blocked_external` before a provider hard-fails, and structured `resetAt` / `retryAfterSeconds` replace random quota backoff when available.
- **Transition reset:** valid transitions clear watchdog state (`blocked*`, `retryAfter`, `retryCount`) and refresh heartbeat baseline.

For stale `implementing`, recovery resumes from `plan_ready` to force a clean implementation pass instead of continuing a potentially inconsistent in-flight run.

### Layer-Driven Implementation Dispatch

Before launching `implement-coordinator`, the implementer computes dependency layers from the active plan (`.ai-factory/PLAN.md` or `.ai-factory/FIX_PLAN.md`) and injects a precomputed execution summary into the prompt.

This makes parallelism explicit:

- layers with one ready task are sequential,
- layers with multiple ready tasks are parallel and must dispatch `implement-worker` subagents.

### Agent Definitions

All agents are defined as markdown files in `.claude/agents/*.md` and loaded by runtimes that support agent definitions (e.g. Claude adapter via `settingSources: ["project"]`). The `agent` package orchestrates _when_ to invoke them; the markdown files define _what_ they do. For runtimes without agent definition support, the prompt policy falls back to slash-command injection.

## Task State Machine

Defined in `packages/shared/src/stateMachine.ts`. Human actions available per status:

| Status             | Human Actions                                            |
| ------------------ | -------------------------------------------------------- |
| `backlog`          | `start_ai`                                               |
| `planning`         | _(none — agent working)_                                 |
| `plan_ready`       | `start_implementation`, `request_replanning`, `fast_fix` |
| `implementing`     | _(none — agent working)_                                 |
| `review`           | _(none — agent working)_                                 |
| `blocked_external` | `retry_from_blocked`                                     |
| `done`             | `approve_done`, `request_changes`                        |
| `verified`         | _(terminal state)_                                       |

Tasks have an `autoMode` flag. When `true`, the agent automatically transitions through all stages. This includes an automatic post-review gate: reviewer output is stored in a structured format, parsed deterministically, and converted into blocking findings for the next cycle. When blockers remain, the coordinator applies a `request_changes`-style transition (`done -> implementing`) with an agent comment containing required fixes. When `false`, the user must manually trigger `start_implementation` from `plan_ready`.

Auto-review strategy is controlled globally by `AGENT_AUTO_REVIEW_STRATEGY`:

- `full_re_review` (default): every review cycle can trigger another automatic rework if current blocking findings exist.
- `closure_first`: rework cycles verify previously-blocking findings first; only `still_blocking` previous findings can trigger another automatic loop.
- If `closure_first` resolves previous blockers but the reviewer finds new blockers, or if max review iterations are reached, the task moves to `done` with `manualReviewRequired=true` and preserved `autoReviewState` for explicit human triage.

Tasks also have a `skipReview` flag (default `false`). When `true`, the coordinator bypasses the review stage entirely — after successful implementation the task moves directly to `done`, skipping the `review-sidecar` and `security-sidecar` runs. This is useful for small changes or tasks where code review is unnecessary.

### Pause / Resume

Tasks have a `paused` flag (default `false`). When `true`, the coordinator skips the task in all selection queries:

- `findCoordinatorTaskCandidate` — paused tasks are not picked up for any stage (planning, plan-checking, implementing, reviewing).
- `listDueBlockedExternalTasks` — paused blocked tasks are not auto-released when their retry window elapses.
- `listStaleInProgressTasks` — paused tasks are not treated as stale by the watchdog, so they won't be force-recovered to `blocked_external`.

**Important:** pausing a task does **not** abort an already running runtime session. If a query is in flight, it will finish. The pause takes effect on the **next** coordinator cycle — the task simply won't be picked up for the next stage transition.

The Pause/Resume button is shown in the TaskDetail Actions bar for active processing stages (`planning`, `plan_ready`, `implementing`, `review`, `blocked_external`). It is hidden for `backlog`, `done`, and `verified` where the agent pipeline is not running.

### Scheduled Execution

Tasks expose an optional `scheduledAt` column (ISO-8601 UTC, nullable). On every
poll cycle the coordinator calls `processDueScheduledTasks()` which:

1. Lists backlog tasks with `scheduledAt <= now` (paused tasks skipped).
2. Transitions each from `backlog` to `planning` using the same state patch as
   the human `start_ai` event, clearing `scheduledAt` in the same write.
3. Appends a `[scheduler]` entry to the task activity log.
4. Broadcasts `task:scheduled_fired` via WebSocket.

Past timestamps are rejected at the API layer with `400`; `null` clears a
previous schedule. Scheduled firing is one-shot — the task never re-fires
automatically after `scheduledAt` is cleared.

### Auto-Queue Mode

Projects expose an `autoQueueMode` flag (default `false`). When `true`,
`processAutoQueueAdvance()` runs every poll cycle and for each such project
fills the pipeline up to a **pool depth**:

- **Sequential project** (`parallelEnabled = false`): pool depth = `1`. The
  next backlog task fires into `planning` only after the previous one
  reaches a terminal status (`done` / `verified`). "In-flight" is counted by
  pipeline status, not by lock — so transitions between stages do not open a
  window for early advance.
- **Parallel project** (`parallelEnabled = true`): pool depth =
  `COORDINATOR_MAX_CONCURRENT_TASKS`. Auto-queue keeps that many tasks in
  flight, advancing as soon as room frees up.

The advance step:

1. Compute `limit = parallelEnabled ? COORDINATOR_MAX_CONCURRENT_TASKS : 1`.
2. Read `active = countActivePipelineTasksForProject(project)` — counts tasks
   in `planning`, `plan_ready`, `implementing`, `review`, or `blocked_external`.
   Backlog (source) and `done`/`verified` (terminal) do not count.
3. While `active < limit`, pick the next backlog task by ascending `position`
   (skipping paused tasks and tasks with future `scheduledAt`), fire it into
   `planning`, append an `[auto-queue]` activity-log entry, and broadcast
   `project:auto_queue_advanced` with the new task id.
4. The fill loop runs in a single tick so a parallel project can start its
   full pool without waiting for additional poll cycles.

Auto-queue and scheduled execution compose in the same poll cycle:
`processDueScheduledTasks()` runs first and fires every backlog task whose
`scheduledAt` is due, then `processAutoQueueAdvance()` runs and **tops up the
remaining pool slots**. Order matters because once the scheduler advances a
task, it counts as in-flight and reduces how many slots auto-queue still
needs to fill. Both passes use the same atomic `claimBacklogTaskForAdvance`
write so a row is moved out of `backlog` exactly once even when both passes
target the same task in the same cycle.

## Roadmap Import

The system supports bulk task creation from a project's `.ai-factory/ROADMAP.md` file via `POST /projects/:id/roadmap/import`.

**Flow:**

1. API reads `ROADMAP.md` from the project root
2. Agent SDK (haiku model) converts markdown milestones into structured JSON
3. Response is validated via zod schema
4. Tasks are created in batch with deduplication (by `projectId + normalizedTitle + roadmapAlias`)
5. Each task receives automatic tags: `roadmap`, `rm:<alias>`, `phase:<N>`, `phase:<name>`, `seq:<NN>`
6. WebSocket broadcasts `task:created` per task and `agent:wake` after batch

**Deduplication:** Re-running import with the same alias is safe — existing tasks with matching titles are skipped. This makes the endpoint idempotent for reruns.

**Tag taxonomy:** Tags enable UI filtering. The `roadmap` quick filter in the Board shows only roadmap-generated tasks. When the roadmap filter is active, a sub-filter row displays all available `roadmapAlias` values (e.g., `v1.0`, `v2.0`) as clickable chips, allowing users to narrow results to a specific roadmap. Selecting no alias shows all roadmap tasks; selecting one or more aliases filters to only those. Tags like `phase:backend` allow additional grouping refinements.

**Logging:** Import logs at INFO level for start/finish with counts, DEBUG for per-task decisions, and ERROR for parse/validation failures. Check API logs during failures by filtering for the `roadmap-generation` component.

## Real-Time Updates

The API broadcasts events via WebSocket (`/ws` endpoint) on every state change:

| Event                           | Trigger                                             |
| ------------------------------- | --------------------------------------------------- |
| `task:created`                  | New task created                                    |
| `task:updated`                  | Task fields updated                                 |
| `task:moved`                    | Task status changed via state machine               |
| `task:deleted`                  | Task deleted                                        |
| `agent:wake`                    | Coordinator should check for work                   |
| `project:runtime_limit_updated` | Runtime-profile limit snapshot persisted or cleared |

The web UI connects via `useWebSocket` hook and invalidates React Query caches on incoming events. The agent coordinator also subscribes to this WebSocket to receive wake signals for immediate task processing (see Agent Pipeline above).

### Activity Logging

Agent tool events are tracked in each task's `agentActivityLog` field. Two modes are supported (configured via `ACTIVITY_LOG_MODE`):

- **sync** (default): Each event writes immediately to the database.
- **batch**: Events are buffered in an in-memory queue per task and flushed when the batch size, max age timer, or stage boundary is reached. Shutdown handlers ensure buffered entries are persisted on `SIGINT`/`SIGTERM`.

## Database

SQLite via `better-sqlite3` with `drizzle-orm` for type-safe queries. Schema is defined in `packages/shared/src/schema.ts`, and all DB reads/writes are executed through `packages/data/src/index.ts`.

Key tables:

- **tasks** — task data, status, plan/logs, heartbeat metadata, runtime override fields (`runtime_profile_id`, `model_override`, `runtime_options_json`), runtime session id (`session_id`), auto-review convergence state (`manual_review_required`, `auto_review_state_json`), and task-level runtime-limit copy (`runtime_limit_snapshot_json`, `runtime_limit_updated_at`)
- **runtime_profiles** — project-scoped or global runtime/provider profiles with non-secret transport/model config plus authoritative runtime-limit state (`runtime_limit_snapshot_json`, `runtime_limit_updated_at`)
- **projects** — project metadata plus default runtime profile ids for tasks and chat
- **chat_sessions / chat_messages** — persisted chat state with runtime profile/session linkage
- **codex_sessions** — indexed Codex session metadata keyed by runtime session id and source file state
- **codex_limit_heads / codex_limit_history** — latest and recent normalized Codex limit snapshots keyed by account fingerprint/project scope/limit id
- **codex_index_cursors** — per-indexer progress/watermark state for incremental reconcile
- **task_comments** — human/agent comments with optional attachments

### Indexes

Runtime index bootstrap creates the following indexes via `CREATE INDEX IF NOT EXISTS` at startup:

- `idx_tasks_status` — coordinator stage filtering
- `idx_tasks_retry_after` — blocked-task retry scans
- `idx_tasks_project_id` — project-scoped task lists
- `idx_tasks_status_retry` — composite for coordinator retry queries
- `idx_tasks_project_status` — composite for ordered task-list queries
- `idx_task_comments_task_id` — comment lookups by task
- `idx_tasks_locked` — parallel execution: find unlocked or stale-locked tasks
- `idx_codex_sessions_project_root_updated` / `idx_codex_sessions_file_path` — local Codex session listing and session-id/file-path lookup
- `idx_codex_limit_heads_lookup` — account/project/limit scoped head overlay queries
- `idx_codex_limit_history_head` / `idx_codex_limit_history_account` — bounded recent limit history by head and account scope

## See Also

- [Getting Started](getting-started.md) — installation and setup
- [API Reference](api.md) — REST endpoints and WebSocket protocol
