# Handoff — REST API

Base URL: `http://localhost:3009`. All responses are JSON.

## System

```
GET /health              → { status, uptime }
GET /agent/readiness     → { ready, hasApiKey, hasClaudeAuth, authSource }
```

`authSource`: `api_key` | `claude_profile` | `both` | `none`

## Projects

| Method   | Path                           | Description                    |
| -------- | ------------------------------ | ------------------------------ |
| `GET`    | `/projects`                    | List projects                  |
| `POST`   | `/projects`                    | Create project                 |
| `PUT`    | `/projects/:id`                | Update project                 |
| `DELETE` | `/projects/:id`                | Delete project                 |
| `GET`    | `/projects/:id/roadmap/status` | Check if `ROADMAP.md` exists   |
| `POST`   | `/projects/:id/roadmap/import` | Import tasks from `ROADMAP.md` |
| `GET`    | `/projects/:id/mcp`            | Get project's `.mcp.json`      |

### Project fields

| Field                       | Type   | Description                 |
| --------------------------- | ------ | --------------------------- |
| `name`                      | string | Name (1-200 chars)          |
| `rootPath`                  | string | Absolute path to project    |
| `plannerMaxBudgetUsd`       | number | Planner budget limit        |
| `implementerMaxBudgetUsd`   | number | Implementer budget limit    |
| `reviewSidecarMaxBudgetUsd` | number | Review sidecar budget limit |

### Roadmap import

```
POST /projects/:id/roadmap/import
Body: { "roadmapAlias": "v1.0" }
```

Reads `.ai-factory/ROADMAP.md`, converts milestones to tasks, deduplicates by `projectId + title + alias`.

Tags added automatically: `roadmap`, `rm:<alias>`, `phase:<N>`, `seq:<NN>`.

Response:

```json
{
  "roadmapAlias": "v1.0",
  "created": 5,
  "skipped": 2,
  "taskIds": ["uuid-1", "..."],
  "byPhase": { "1": { "created": 3, "skipped": 1 } }
}
```

> May take 30-120 seconds due to Agent SDK processing.

## Tasks

| Method   | Path                                                   | Description                 |
| -------- | ------------------------------------------------------ | --------------------------- |
| `GET`    | `/tasks?projectId=<uuid>`                              | List tasks                  |
| `POST`   | `/tasks`                                               | Create task                 |
| `GET`    | `/tasks/:id`                                           | Get task                    |
| `PUT`    | `/tasks/:id`                                           | Update task                 |
| `DELETE` | `/tasks/:id`                                           | Delete task                 |
| `POST`   | `/tasks/:id/action`                                    | Execute state transition    |
| `GET`    | `/tasks/:id/attachments/:filename`                     | Download attachment         |
| `GET`    | `/tasks/:id/comments/:commentId/attachments/:filename` | Download comment attachment |

### Task creation fields

| Field          | Type     | Default | Description                       |
| -------------- | -------- | ------- | --------------------------------- |
| `projectId`    | string   | —       | Project UUID                      |
| `title`        | string   | —       | Title (1-500 chars)               |
| `description`  | string   | `""`    | Description                       |
| `priority`     | integer  | `0`     | Priority (0-5)                    |
| `autoMode`     | boolean  | `true`  | Auto-advance through stages       |
| `isFix`        | boolean  | `false` | Fix-flow task (uses FIX_PLAN)     |
| `skipReview`   | boolean  | `false` | Skip review stage                 |
| `paused`       | boolean  | `false` | Pause processing                  |
| `useSubagents` | boolean  | `true`  | Custom subagents vs aif-\* skills |
| `tags`         | string[] | `[]`    | Tags (max 50)                     |
| `roadmapAlias` | string   | `null`  | Roadmap grouping                  |

### Task actions

```
POST /tasks/:id/action
Body: { "action": "<action_name>" }
```

| Action                 | Condition               |
| ---------------------- | ----------------------- |
| `start_ai`             | from `backlog`          |
| `start_implementation` | from `plan_ready`       |
| `request_replanning`   | from `plan_ready`       |
| `fast_fix`             | from `plan_ready`       |
| `approve_done`         | from `done`             |
| `request_changes`      | from `done`             |
| `retry_from_blocked`   | from `blocked_external` |

## Runtime Profiles

| Method   | Path                          | Description           |
| -------- | ----------------------------- | --------------------- |
| `GET`    | `/runtime-profiles`           | List profiles         |
| `POST`   | `/runtime-profiles`           | Create profile        |
| `PUT`    | `/runtime-profiles/:id`       | Update profile        |
| `DELETE` | `/runtime-profiles/:id`       | Delete profile        |
| `GET`    | `/runtime-profiles/models`    | List available models |
| `GET`    | `/runtime-profiles/readiness` | Check readiness       |

## Chat (One-shot)

```
POST /chat
Body: { "projectId": "uuid", "message": "text", "profileId": "uuid" }
Response: { "content": "response", "usage": { "input_tokens": N, "output_tokens": N } }
```

Single AI request without context persistence.

## WebSocket

```
ws://localhost:3009/ws
```

| Event          | Trigger                           |
| -------------- | --------------------------------- |
| `task:created` | Task created                      |
| `task:updated` | Fields updated                    |
| `task:moved`   | Status changed                    |
| `task:deleted` | Task deleted                      |
| `agent:wake`   | Coordinator should check for work |

Message format:

```json
{ "type": "task:updated", "data": { "id": "uuid", "status": "implementing" } }
```
