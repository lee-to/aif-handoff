[← Architecture](architecture.md) · [Back to README](../README.md) · [Configuration →](configuration.md)

# API Reference

Base URL: `http://localhost:3001`

All endpoints return JSON. Request bodies use `application/json`.

## System

### Health Check

```
GET /health
```

**Response:** `200 OK`

```json
{
  "status": "ok",
  "uptime": 123
}
```

### Agent Readiness

```
GET /agent/readiness
```

Checks whether agent authentication is configured via `ANTHROPIC_API_KEY` and/or Claude profile auth (`~/.claude`).

**Response:** `200 OK`

```json
{
  "ready": true,
  "hasApiKey": false,
  "hasClaudeAuth": true,
  "authSource": "claude_profile",
  "detectedPath": "/Users/you/.claude/auth.json",
  "message": "Agent authentication is configured.",
  "checkedAt": "2026-03-28T17:10:00.000Z"
}
```

`authSource` values: `api_key`, `claude_profile`, `both`, `none`.

## Projects

### List Projects

```
GET /projects
```

**Response:** `200 OK`

```json
[
  {
    "id": "uuid",
    "name": "My Project",
    "rootPath": "/path/to/project",
    "plannerMaxBudgetUsd": 10,
    "planCheckerMaxBudgetUsd": 2,
    "implementerMaxBudgetUsd": 15,
    "reviewSidecarMaxBudgetUsd": 2,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

### Create Project

```
POST /projects
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Project name (1-200 chars) |
| `rootPath` | string | yes | Absolute path to project root |
| `plannerMaxBudgetUsd` | number | no | Budget for planner agent. If omitted, unlimited |
| `planCheckerMaxBudgetUsd` | number | no | Budget for plan-checker agent. If omitted, unlimited |
| `implementerMaxBudgetUsd` | number | no | Budget for implementer agent. If omitted, unlimited |
| `reviewSidecarMaxBudgetUsd` | number | no | Per-sidecar budget for review/security sidecars. If omitted, unlimited |

**Response:** `201 Created` — the created project object.

### Update Project

```
PUT /projects/:id
```

**Body:** Same as Create Project.

**Response:** `200 OK` — the updated project object.

### Import Roadmap Tasks

```
POST /projects/:id/roadmap/import
```

Reads `.ai-factory/ROADMAP.md` from the project root, uses Agent SDK to convert milestones into structured tasks, and creates them as backlog items with deduplication.

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `roadmapAlias` | string | yes | Alias for grouping imported tasks (e.g., `v1.0`, `sprint-1`) |

**Response:** `201 Created`

```json
{
  "roadmapAlias": "v1.0",
  "created": 5,
  "skipped": 2,
  "taskIds": ["uuid-1", "uuid-2", "..."],
  "byPhase": {
    "1": { "created": 3, "skipped": 1 },
    "2": { "created": 2, "skipped": 1 }
  }
}
```

**Deduplication:** Tasks are deduped by `projectId + normalizedTitle + roadmapAlias`. Re-running import with the same alias skips already-existing tasks.

**Tag enrichment:** Each created task automatically receives tags: `roadmap`, `rm:<alias>`, `phase:<number>`, `phase:<name>`, `seq:<nn>`.

**Errors:**

- `404` — Project not found or `ROADMAP.md` missing
- `500` — Agent SDK unavailable or response parse failure

**WebSocket events:** `task:created` for each new task, `agent:wake` after batch completion.

**Timeout:** This endpoint may take 30-120 seconds due to Agent SDK processing.

### Delete Project

```
DELETE /projects/:id
```

**Response:** `200 OK`

```json
{ "success": true }
```

### Get Project MCP Config

```
GET /projects/:id/mcp
```

Reads `.mcp.json` from the project root and returns its MCP servers map.

**Response:** `200 OK`

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["./server.js"]
    }
  }
}
```

If `.mcp.json` does not exist (or cannot be parsed), returns:

```json
{ "mcpServers": {} }
```

---

## Tasks

### List Tasks

```
GET /tasks?projectId=<uuid>
```

| Param       | Type         | Required | Description                               |
| ----------- | ------------ | -------- | ----------------------------------------- |
| `projectId` | query string | no       | Filter by project. Omit to list all tasks |

**Response:** `200 OK` — array of task objects sorted by status order, then position.

### Create Task

```
POST /tasks
```

**Body:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `projectId` | string | yes | | Project UUID |
| `title` | string | yes | | Task title (1-500 chars) |
| `description` | string | no | `""` | Task description |
| `attachments` | array | no | `[]` | File attachments (max 10) |
| `priority` | integer | no | `0` | Priority level (0-5) |
| `autoMode` | boolean | no | `true` | Auto-advance through agent pipeline, including automatic post-review rework loop when fixes are detected |
| `isFix` | boolean | no | `false` | Marks the task as fix-flow task (uses FIX plan conventions) |
| `skipReview` | boolean | no | `false` | Skip the review stage — task moves directly from implementing to done |
| `roadmapAlias` | string | no | `null` | Roadmap alias for grouping (e.g., `v1.0`) |
| `tags` | string[] | no | `[]` | Tags for filtering/categorization (max 50, each max 100 chars) |

**Attachment object:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | File name (1-500 chars) |
| `mimeType` | string | MIME type (max 200 chars) |
| `size` | integer | File size in bytes (max 10MB) |
| `content` | string\|null | Base64 content (max 2MB encoded) |

**Response:** `201 Created` — the created task object.

**WebSocket event:** `task:created`

### Get Task

```
GET /tasks/:id
```

**Response:** `200 OK` — full task object.

### Download Task Attachment

```
GET /tasks/:id/attachments/:filename
```

Downloads a file-backed attachment from the task. The `:filename` must match the attachment `name` in the task's attachments array.

**Response:** `200 OK` — binary file with `Content-Disposition: attachment`.

**Errors:**

- `404` — task not found, attachment not found, or file missing from disk.

### Download Comment Attachment

```
GET /tasks/:id/comments/:commentId/attachments/:filename
```

Downloads a file-backed attachment from a task comment. The `:filename` must match the attachment `name` in the comment's attachments array.

**Response:** `200 OK` — binary file with `Content-Disposition: attachment`.

**Errors:**

- `404` — task, comment, or attachment not found, or file missing from disk.

### Update Task

```
PUT /tasks/:id
```

**Body:** All fields optional:
| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Task title |
| `description` | string | Task description |
| `attachments` | array | File attachments |
| `priority` | integer | Priority (0-5) |
| `autoMode` | boolean | Auto-advance mode (includes automatic post-review rework loop when enabled) |
| `isFix` | boolean | Marks task as fix-flow |
| `plan` | string\|null | Generated plan (markdown) |
| `implementationLog` | string\|null | Implementation output |
| `reviewComments` | string\|null | Review feedback |
| `agentActivityLog` | string\|null | Agent activity timeline |
| `blockedReason` | string\|null | Why the task is blocked |
| `blockedFromStatus` | string\|null | Status before being blocked |
| `retryAfter` | string\|null | ISO timestamp for retry |
| `roadmapAlias` | string\|null | Roadmap alias for grouping |
| `tags` | string[] | Tags for filtering |
| `retryCount` | integer | Number of retries |
| `lastHeartbeatAt` | string\|null | Last heartbeat timestamp from coordinator/subagent activity |

**Response:** `200 OK` — the updated task object.

**WebSocket event:** `task:updated`

### Delete Task

```
DELETE /tasks/:id
```

**Response:** `200 OK`

```json
{ "success": true }
```

**WebSocket event:** `task:deleted`

### Apply State Event

```
POST /tasks/:id/events
```

Transitions a task through the state machine.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `event` | string | One of the valid task events |

**Valid events by current status:**

| Current Status     | Valid Events                                             |
| ------------------ | -------------------------------------------------------- |
| `backlog`          | `start_ai`                                               |
| `plan_ready`       | `start_implementation`, `request_replanning`, `fast_fix` |
| `blocked_external` | `retry_from_blocked`                                     |
| `done`             | `approve_done`, `request_changes`                        |

Additional constraints:

- `start_implementation` requires `autoMode=false` (manual gate). For `autoMode=true`, implementation is picked automatically by the coordinator.
- `fast_fix` requires `autoMode=false` and at least one human comment on the task.
- `request_changes` transitions `done -> implementing`, sets `reworkRequested=true`, and resets watchdog retry state (`retryCount=0`).
- With `autoMode=true`, coordinator can trigger this same `request_changes`-style rework loop automatically after review if fix items are extracted from `reviewComments`.

**Response:** `200 OK` — the updated task object.

**Error:** `409 Conflict` if the event is not valid for the current status.

**WebSocket event:** `task:moved`

### Reorder Task

```
PATCH /tasks/:id/position
```

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `position` | number | New position value for sorting |

**Response:** `200 OK` — the updated task object.

**WebSocket event:** `task:updated`

### Broadcast Task Update

```
POST /tasks/:id/broadcast
```

Used by the agent process to trigger WebSocket broadcasts after updating a task.

**Body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | `task:updated` | Event type: `task:updated` or `task:moved` |

**Response:** `200 OK`

```json
{ "success": true }
```

---

## Task Comments

### List Comments

```
GET /tasks/:id/comments
```

**Response:** `200 OK` — array of comment objects sorted by `createdAt` ascending.

```json
[
  {
    "id": "uuid",
    "taskId": "uuid",
    "author": "human",
    "message": "Comment text",
    "attachments": [],
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

### Create Comment

```
POST /tasks/:id/comments
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Comment text (1-20,000 chars) |
| `attachments` | array | no | File attachments (max 10) |

**Response:** `201 Created` — the created comment object.

---

## WebSocket

Connect to `ws://localhost:3001/ws` for real-time updates.

### Events

All events are JSON with this structure:

```json
{
  "type": "project:created | task:created | task:updated | task:moved | task:deleted",
  "payload": {
    /* project/task object or { id } for deletes */
  }
}
```

| Event             | Payload             | Triggered By                                                                         |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `project:created` | Full project object | `POST /projects`                                                                     |
| `task:created`    | Full task object    | `POST /tasks`, `POST /projects/:id/roadmap/import`                                   |
| `task:updated`    | Full task object    | `PUT /tasks/:id`, `PATCH /tasks/:id/position`, `POST /tasks/:id/events` (`fast_fix`) |
| `task:moved`      | Full task object    | `POST /tasks/:id/events`                                                             |
| `task:deleted`    | `{ id: string }`    | `DELETE /tasks/:id`                                                                  |

### Connection

The WebSocket endpoint is a simple broadcast channel — no authentication, no subscription topics. All connected clients receive all events.

## See Also

- [Architecture](architecture.md) — system overview and data flow
- [Configuration](configuration.md) — server port and environment settings
