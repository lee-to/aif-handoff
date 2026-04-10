# Handoff — MCP Sync Server

The MCP server provides bidirectional synchronization between Handoff and AIF tooling via the [Model Context Protocol](https://modelcontextprotocol.io).

## Transports

### stdio (local)

Configure in `.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "cwd": "/absolute/path/to/aif-handoff",
      "env": {
        "DATABASE_URL": "/absolute/path/to/aif-handoff/data/aif.sqlite",
        "PROJECTS_DIR": "/absolute/path/to/aif-handoff/.projects"
      }
    }
  }
}
```

> Use **absolute paths** — relative paths don't work.

Claude Code automatically discovers the server from `.mcp.json`.

### HTTP (Docker / remote)

```json
{
  "mcpServers": {
    "handoff": { "url": "http://localhost:3100/mcp" }
  }
}
```

Start: set `MCP_TRANSPORT=http`. Default port — `3100`. `/health` endpoint for healthchecks.

## Environment Variables

| Variable                   | Default | Description                |
| -------------------------- | ------- | -------------------------- |
| `MCP_TRANSPORT`            | `stdio` | Mode: `stdio` or `http`    |
| `MCP_PORT`                 | `3100`  | HTTP port                  |
| `MCP_RATE_LIMIT_READ_RPM`  | `120`   | Read limit (requests/min)  |
| `MCP_RATE_LIMIT_WRITE_RPM` | `30`    | Write limit (requests/min) |

## Tools — Read

### `handoff_list_tasks`

List tasks with filters. Returns summary fields (no plan or logs).

| Parameter   | Type       | Description                       |
| ----------- | ---------- | --------------------------------- |
| `projectId` | UUID       | Filter by project                 |
| `status`    | TaskStatus | Filter by status                  |
| `limit`     | number     | Max results (default 20, max 100) |
| `offset`    | number     | Skip N results                    |

### `handoff_get_task`

Get a task by ID with **full data** (plan, description, logs).

### `handoff_search_tasks`

Full-text search across titles and descriptions.

| Parameter   | Type   | Description                  |
| ----------- | ------ | ---------------------------- |
| `query`     | string | Search query (max 200 chars) |
| `projectId` | UUID   | Scope search to project      |

### `handoff_list_projects`

List all projects. No parameters.

## Tools — Write

### `handoff_create_task`

Create a task.

| Parameter     | Type           | Description           |
| ------------- | -------------- | --------------------- |
| `projectId`   | UUID           | Project ID (required) |
| `title`       | string         | Title (max 500 chars) |
| `description` | string         | Description           |
| `priority`    | 0-3            | Priority              |
| `plannerMode` | `fast`\|`full` | Planner mode          |

### `handoff_update_task`

Update an existing task (any mutable fields).

### `handoff_sync_status`

Bidirectional status sync with conflict detection.

| Parameter         | Type                               | Description          |
| ----------------- | ---------------------------------- | -------------------- |
| `taskId`          | UUID                               | Task ID              |
| `newStatus`       | TaskStatus                         | Desired status       |
| `sourceTimestamp` | ISO string                         | Source timestamp     |
| `direction`       | `aif_to_handoff`\|`handoff_to_aif` | Direction            |
| `paused`          | boolean                            | Set pause atomically |

Response:

```json
{
  "applied": true,
  "conflict": false,
  "task": { "id": "abc-123", "status": "in_progress" },
  "lastSyncedAt": "2026-03-31T12:00:00.123Z"
}
```

### `handoff_push_plan`

Save plan content to a task (max 100KB).

### `handoff_annotate_plan`

Insert/update a task annotation in plan markdown. **Does not persist** — use `handoff_push_plan` to save.

Annotation format:

```markdown
<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890 -->
```

## Conflict Resolution

**Last-write-wins** strategy with millisecond precision:

1. `sourceTimestamp` is compared against the task's `updatedAt`
2. If source is newer or equal — change is applied
3. If target is newer — conflict is returned without changes
4. Caller decides how to handle conflicts

## Bidirectional Sync

### Mode 1: Managed by Handoff (`HANDOFF_MODE=1`)

When a task runs through the Handoff coordinator, it manages all status transitions directly. Skills and agents **do not call** MCP tools.

```
Handoff Coordinator
  ├─ updateTaskStatus(id, "planning")   ← direct DB write
  ├─ runPlanner(id)                      ← spawns Claude Code with env vars
  │   └─ /aif-plan sees HANDOFF_MODE=1
  │       ├─ Inserts annotation into plan
  │       └─ Does NOT call MCP (coordinator manages)
  └─ WebSocket broadcast → updates Kanban UI
```

### Mode 2: Manual Claude Code session

When a developer runs `/aif-plan` directly with `HANDOFF_TASK_ID` in env, skills call MCP tools themselves for sync.

```
Developer
  └─ /aif-plan "add user auth"
      └─ Skill sees HANDOFF_TASK_ID but not HANDOFF_MODE
          ├─ Calls handoff_sync_status(newStatus: "planning")
          ├─ AskUserQuestion works normally (interactive mode)
          └─ Calls handoff_sync_status(newStatus: "plan_ready") after
```

### Env variables in subprocess

| Variable              | Description                                 |
| --------------------- | ------------------------------------------- |
| `HANDOFF_MODE=1`      | Coordinator manages — skills don't call MCP |
| `HANDOFF_TASK_ID`     | UUID of the associated task                 |
| `HANDOFF_SKIP_REVIEW` | Skip review stage                           |

## Rate Limiting

- **Read** (list, get, search): 120 req/min, burst 10
- **Write** (create, update, sync, push): 30 req/min, burst 5

Uses token bucket algorithm. Excess → MCP error response.

## WebSocket Integration

When MCP tools modify tasks, the server broadcasts events to the WebSocket API to update the Kanban UI in real time. Broadcast is best-effort and non-blocking.
