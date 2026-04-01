# MCP Sync Server

The Handoff MCP server enables bidirectional synchronization between the Handoff task management system and AI Factory (AIF) tooling via the [Model Context Protocol](https://modelcontextprotocol.io).

## Setup

### Prerequisites

- Node.js 20+
- Built project: `npm run build`

### Configuration

The MCP server supports two transport modes:

#### stdio (default) — local Claude Code

Configured in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "./data/handoff.sqlite"
      }
    }
  }
}
```

After building, the Claude CLI auto-discovers the Handoff MCP server.

#### HTTP — Docker / remote

When running in Docker, the MCP server uses Streamable HTTP transport. Set `MCP_TRANSPORT=http` and the server listens on `MCP_PORT` (default `3100`):

```json
{
  "mcpServers": {
    "handoff": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

The HTTP mode also exposes a `/health` endpoint for Docker healthchecks.

### Environment Variables

The MCP server uses the shared monorepo environment (`packages/shared/src/env.ts`) for database and API configuration. MCP-specific variables:

| Variable                     | Default | Description                                     |
| ---------------------------- | ------- | ----------------------------------------------- |
| `MCP_TRANSPORT`              | `stdio` | Transport mode: `stdio` or `http`               |
| `MCP_PORT`                   | `3100`  | HTTP port (only used when `MCP_TRANSPORT=http`) |
| `MCP_RATE_LIMIT_READ_RPM`    | `120`   | Read tool rate limit (requests/minute)          |
| `MCP_RATE_LIMIT_READ_BURST`  | `10`    | Read tool burst capacity                        |
| `MCP_RATE_LIMIT_WRITE_RPM`   | `30`    | Write tool rate limit (requests/minute)         |
| `MCP_RATE_LIMIT_WRITE_BURST` | `5`     | Write tool burst capacity                       |

Shared variables (from `@aif/shared`):

| Variable       | Default                 | Description                             |
| -------------- | ----------------------- | --------------------------------------- |
| `DATABASE_URL` | `./data/aif.sqlite`     | SQLite database path                    |
| `API_BASE_URL` | `http://localhost:3009` | API server URL for WebSocket broadcasts |

## Tools Reference

### Read Tools

#### `handoff_list_tasks`

List tasks with optional filters and pagination. Returns **summary fields** (no plan, description, or logs) to keep payloads small. Use `handoff_get_task` to fetch full task details.

| Parameter   | Type       | Required | Description                                |
| ----------- | ---------- | -------- | ------------------------------------------ |
| `projectId` | UUID       | No       | Filter by project                          |
| `status`    | TaskStatus | No       | Filter by status                           |
| `limit`     | number     | No       | Max results per page (default 20, max 100) |
| `offset`    | number     | No       | Number of results to skip (default 0)      |

**Response:**

```json
{
  "items": [{ "id": "abc-123", "title": "Example task", "status": "backlog" }],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

Summary fields include: `id`, `projectId`, `title`, `status`, `priority`, `position`, `autoMode`, `isFix`, `paused`, `roadmapAlias`, `tags`, `blockedReason`, `retryCount`, `tokenTotal`, `costUsd`, `lastSyncedAt`, `createdAt`, `updatedAt`.

#### `handoff_get_task`

Get a single task by ID with **full detail** (including plan, description, logs).

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `taskId`  | UUID | Yes      | Task ID     |

#### `handoff_search_tasks`

Full-text search across task titles and descriptions with pagination. Returns **summary fields**.

| Parameter   | Type   | Required | Description                               |
| ----------- | ------ | -------- | ----------------------------------------- |
| `query`     | string | Yes      | Search query (max 200 chars)              |
| `projectId` | UUID   | No       | Scope search to project                   |
| `limit`     | number | No       | Max results per page (default 20, max 50) |
| `offset`    | number | No       | Number of results to skip (default 0)     |

Response format is the same as `handoff_list_tasks`.

#### `handoff_list_projects`

List all projects. No parameters required.

### Write Tools

#### `handoff_create_task`

Create a new task.

| Parameter     | Type           | Required | Description                |
| ------------- | -------------- | -------- | -------------------------- |
| `projectId`   | UUID           | Yes      | Project ID (must exist)    |
| `title`       | string         | Yes      | Task title (max 500 chars) |
| `description` | string         | No       | Task description           |
| `priority`    | 0-3            | No       | Priority level             |
| `tags`        | string[]       | No       | Tags                       |
| `plannerMode` | `fast`\|`full` | No       | Planner mode               |
| `autoMode`    | boolean        | No       | Auto mode                  |

#### `handoff_update_task`

Update an existing task.

| Parameter     | Type         | Required | Description             |
| ------------- | ------------ | -------- | ----------------------- |
| `taskId`      | UUID         | Yes      | Task ID (must exist)    |
| `title`       | string       | No       | New title               |
| `description` | string       | No       | New description         |
| `priority`    | 0-3          | No       | New priority            |
| `plan`        | string\|null | No       | Plan content            |
| ...           |              |          | All mutable task fields |

#### `handoff_sync_status`

Bidirectional status sync with conflict detection.

| Parameter         | Type                               | Required | Description                                                                                                                                                     |
| ----------------- | ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`          | UUID                               | Yes      | Task ID                                                                                                                                                         |
| `newStatus`       | TaskStatus                         | Yes      | Desired status                                                                                                                                                  |
| `sourceTimestamp` | ISO string                         | Yes      | Source system timestamp (ms precision)                                                                                                                          |
| `direction`       | `aif_to_handoff`\|`handoff_to_aif` | Yes      | Sync direction                                                                                                                                                  |
| `paused`          | boolean                            | No       | Set paused flag atomically with the status change (e.g. `true` to prevent Handoff from picking up the task during manual work, `false` on `done` to release it) |

**Response:**

```json
{
  "applied": true,
  "conflict": false,
  "conflictResolution": { "winner": "source", "field": "status" },
  "task": { "id": "abc-123", "title": "Example task", "status": "in_progress" },
  "lastSyncedAt": "2026-03-31T12:00:00.123Z"
}
```

#### `handoff_push_plan`

Push plan content to a task with annotation validation.

| Parameter     | Type   | Required | Description               |
| ------------- | ------ | -------- | ------------------------- |
| `taskId`      | UUID   | Yes      | Task ID                   |
| `planContent` | string | Yes      | Plan markdown (max 100KB) |

#### `handoff_annotate_plan`

Insert or update task ID annotations in plan markdown. Does NOT persist -- use `handoff_push_plan` or `handoff_update_task` to save.

| Parameter        | Type   | Required | Description               |
| ---------------- | ------ | -------- | ------------------------- |
| `taskId`         | UUID   | Yes      | Task ID for annotation    |
| `planContent`    | string | Yes      | Plan markdown             |
| `sectionHeading` | string | No       | Insert after this heading |

## Plan Annotation Format

Annotations use HTML comments that are invisible in rendered markdown:

```markdown
## Overview

<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890 -->

This section implements the authentication feature.
```

- Format: `<!-- handoff:task:<uuid> -->`
- Parsed by `parsePlanAnnotations()` from `@aif/shared`
- Inserted by `insertPlanAnnotation()` from `@aif/shared`

## Conflict Resolution

The MCP server uses **last-write-wins** with millisecond-precision timestamps:

1. When `handoff_sync_status` is called, it compares `sourceTimestamp` against the task's `updatedAt`.
2. If the source timestamp is newer or equal, the change is applied and `lastSyncedAt` is updated.
3. If the target (Handoff) timestamp is newer, a conflict is returned without modifying the task.
4. The caller decides how to handle conflicts.

The `lastSyncedAt` column tracks when each task was last synced via MCP, distinct from `updatedAt` which changes on any modification.

## Rate Limiting

Per-tool rate limits use a token bucket algorithm:

- **Read tools** (list, get, search): 120 requests/minute, burst of 10
- **Write tools** (create, update, sync, push): 30 requests/minute, burst of 5

Excess requests receive an MCP error response. Configure via environment variables.

## WebSocket Integration

When MCP tools modify tasks, the server broadcasts events to the API's WebSocket system so the Kanban UI updates in real time. Broadcasts are best-effort and non-blocking.

## Bidirectional Sync: How It Works

The system supports two execution modes for AIF skills and agents. The mode determines **who** is responsible for keeping Handoff task state in sync.

### Environment Variables

Every `query()` call from the Handoff agent system injects these env vars into the Claude Code subprocess:

| Variable              | Set when                        | Description                                               |
| --------------------- | ------------------------------- | --------------------------------------------------------- |
| `HANDOFF_MODE`        | Always `"1"` from Handoff agent | Signals that the Handoff coordinator is managing this run |
| `HANDOFF_TASK_ID`     | Task ID is known                | UUID of the associated Handoff task                       |
| `HANDOFF_SKIP_REVIEW` | `task.skipReview` is true       | Skip the review stage (implementing → done)               |

Skills read these at load time via dynamic shell substitution:

```yaml
Handoff mode: !`echo ${HANDOFF_MODE:-}`
Handoff task ID: !`echo ${HANDOFF_TASK_ID:-}`
Handoff skip review: !`echo ${HANDOFF_SKIP_REVIEW:-}`
```

### Mode 1: Managed by Handoff (`HANDOFF_MODE=1`)

When a task runs through the Handoff pipeline (coordinator → planner → implementer → reviewer), the coordinator manages all status transitions and DB writes directly. Skills and agents **do not** call MCP tools.

```
Handoff Coordinator (TypeScript)
  │
  ├─ updateTaskStatus(id, "planning")     ← direct DB write
  ├─ runPlanner(id)                       ← spawns Claude Code with env vars
  │   └─ /aif-plan sees HANDOFF_MODE=1
  │       ├─ Inserts <!-- handoff:task:<id> --> in plan
  │       ├─ Skips AskUserQuestion (uses defaults)
  │       └─ Does NOT call MCP (coordinator handles status)
  ├─ updateTaskStatus(id, "plan_ready")   ← direct DB write
  ├─ runImplementer(id)
  │   └─ /aif-implement sees HANDOFF_MODE=1
  │       ├─ Skips interactive prompts
  │       └─ Does NOT call MCP
  ├─ if skipReview: updateTaskStatus(id, "done")
  │   else: updateTaskStatus(id, "review") → runReviewer(id)
  └─ WebSocket broadcast → Kanban UI updates
```

### Mode 2: Manual Claude Code session (`HANDOFF_TASK_ID` set, `HANDOFF_MODE` not set)

When a developer runs `/aif-plan` or `/aif-implement` directly in Claude Code but wants to sync with Handoff, `HANDOFF_TASK_ID` is set (either via env or the MCP server is available). Skills call MCP tools themselves because there is no coordinator managing the run.

```
Developer in Claude Code
  │
  ├─ /aif-plan "add user auth"
  │   └─ Skill sees HANDOFF_TASK_ID but no HANDOFF_MODE
  │       ├─ Calls handoff_sync_status(newStatus: "planning")
  │       ├─ Inserts <!-- handoff:task:<id> --> in plan
  │       ├─ AskUserQuestion works normally (interactive)
  │       ├─ Calls handoff_push_plan(planContent: ...)
  │       └─ Calls handoff_sync_status(newStatus: "plan_ready")
  │
  ├─ /aif-implement
  │   └─ Skill sees HANDOFF_TASK_ID but no HANDOFF_MODE
  │       ├─ Calls handoff_sync_status(newStatus: "implementing")
  │       ├─ On each checklist update: calls handoff_push_plan(...)
  │       ├─ On completion:
  │       │   ├─ If HANDOFF_SKIP_REVIEW=1: handoff_sync_status("done")
  │       │   └─ Else: handoff_sync_status("review")
  │       └─ Kanban UI updates via WebSocket broadcast from MCP
```

### Task Lifecycle

```
backlog ──start_ai──► planning ──────────► plan_ready ──────────► implementing ──┬──► review ──► done
                      ▲                    │                                      │              │
                      │                    ├─ request_replanning ─►  planning     │              ├─ approve_done ─► verified
                      │                    └─ fast_fix ─► plan_ready              │              └─ request_changes ─► implementing
                      │                                                           │
                      │                                                           └─ (skipReview) ─► done
```

Status transitions driven by AIF:

| Stage        | Start status   | End status         | Who updates                          |
| ------------ | -------------- | ------------------ | ------------------------------------ |
| Planning     | `planning`     | `plan_ready`       | Coordinator (mode 1) or MCP (mode 2) |
| Implementing | `implementing` | `review` or `done` | Coordinator (mode 1) or MCP (mode 2) |
| Review       | `review`       | `done`             | Coordinator only (mode 1)            |

### Plan Annotations

Every plan file created with a `HANDOFF_TASK_ID` gets an annotation as the first line:

```markdown
<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890 -->

# Implementation Plan: User Authentication

...
```

This annotation is inserted regardless of mode (both mode 1 and mode 2). It enables:

- Traceability between plan files on disk and Handoff tasks
- `handoff_push_plan` to validate that the plan belongs to the correct task
- `parsePlanAnnotations()` to discover linked tasks from plan markdown

### Affected Skills and Agents

| File                            | Handoff behavior                                                      |
| ------------------------------- | --------------------------------------------------------------------- |
| `aif-plan` (skill)              | Annotation + MCP sync (mode 2) or no-interactivity (mode 1)           |
| `aif-fix` (skill)               | Annotation + MCP sync (mode 2) or no-interactivity (mode 1)           |
| `aif-implement` (skill)         | MCP sync with checklist updates (mode 2) or no-interactivity (mode 1) |
| `plan-coordinator` (agent)      | MCP sync (mode 2) or pass-through (mode 1)                            |
| `plan-polisher` (agent)         | Annotation only (never calls MCP)                                     |
| `implement-coordinator` (agent) | MCP sync with layer updates (mode 2) or pass-through (mode 1)         |
| `implement-worker` (agent)      | Never calls MCP (coordinator handles sync)                            |

### MCP Server Requirement

For mode 2 (manual Claude Code session) to work, the Handoff MCP server must be registered in `.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "command": "node",
      "args": ["packages/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "./data/aif.sqlite"
      }
    }
  }
}
```

Mode 1 does not require MCP — the coordinator writes to the database directly via `@aif/data`.

## Troubleshooting

- **Server won't start**: Check that `DATABASE_URL` points to an existing SQLite database and that the project has been built (`npm run build`).
- **Rate limit errors**: Increase `MCP_RATE_LIMIT_*` environment variables or wait for the token bucket to refill.
- **Conflict on sync**: The target task was modified more recently. Fetch the latest task state and retry with a newer timestamp, or accept the conflict.
- **Annotation not found**: Ensure task IDs in annotations are valid UUIDs matching existing tasks.
