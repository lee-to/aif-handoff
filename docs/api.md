[← Architecture](architecture.md) · [Back to README](../README.md) · [Configuration →](configuration.md)

# API Reference

Base URL: `http://localhost:3009`

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

### Runtime Settings

```
GET /settings
```

Returns frontend-visible defaults and runtime readiness metadata.

**Response:** `200 OK`

```json
{
  "useSubagents": false,
  "maxReviewIterations": 3,
  "autoReviewStrategy": "full_re_review",
  "runtimeReadiness": {
    "availableRuntimeCount": 3,
    "runtimeProfileCount": 6,
    "enabledRuntimeProfileCount": 5
  },
  "runtimeDefaults": {
    "modules": [],
    "openAiBaseUrlConfigured": false,
    "codexCliPathConfigured": true,
    "app": {
      "defaultTaskRuntimeProfileId": "uuid-or-null",
      "defaultPlanRuntimeProfileId": null,
      "defaultReviewRuntimeProfileId": null,
      "defaultChatRuntimeProfileId": "uuid-or-null",
      "resolvedDefaultTaskRuntimeProfileId": "uuid-or-null",
      "resolvedDefaultPlanRuntimeProfileId": "uuid-or-null",
      "resolvedDefaultReviewRuntimeProfileId": "uuid-or-null",
      "resolvedDefaultChatRuntimeProfileId": "uuid-or-null"
    }
  }
}
```

`autoReviewStrategy` is the resolved global auto-review mode (`full_re_review` or `closure_first`).

### App Runtime Defaults

```
GET /settings/runtime-defaults
PUT /settings/runtime-defaults
```

Reads or updates the app-wide runtime defaults used after project defaults and before environment fallback.

**PUT body:**

```json
{
  "defaultTaskRuntimeProfileId": "uuid-or-null",
  "defaultPlanRuntimeProfileId": "uuid-or-null",
  "defaultReviewRuntimeProfileId": "uuid-or-null",
  "defaultChatRuntimeProfileId": "uuid-or-null"
}
```

Rules:

- values must be `null` or enabled global runtime profiles
- `plan` / `review` fall back to the app task default when unset
- invalid scope combinations fail with `400` and `fieldErrors`

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
| `defaultTaskRuntimeProfileId` | string\|null | no | Project-level task/implementation runtime default |
| `defaultPlanRuntimeProfileId` | string\|null | no | Project-level planning runtime default |
| `defaultReviewRuntimeProfileId` | string\|null | no | Project-level review runtime default |
| `defaultChatRuntimeProfileId` | string\|null | no | Project-level chat runtime default |

**Response:** `201 Created` — the created project object.

### Update Project

```
PUT /projects/:id
```

**Body:** Same as Create Project.

**Response:** `200 OK` — the updated project object.

### Check Roadmap Status

```
GET /projects/:id/roadmap/status
```

Checks whether `.ai-factory/ROADMAP.md` exists in the project root directory.

**Response:** `200 OK`

```json
{
  "exists": true
}
```

**Errors:**

- `404` — Project not found

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

### Get Auto-Queue Mode

```
GET /projects/:id/auto-queue-mode
```

Returns the current auto-queue state for the project. When enabled, the
coordinator advances the next backlog task (by `position`) into planning
whenever the project has no active/locked task.

**Response:** `200 OK`

```json
{ "enabled": true }
```

### Toggle Auto-Queue Mode

```
PATCH /projects/:id/auto-queue-mode
```

**Body:** `{ "enabled": boolean }`

Broadcasts `project:auto_queue_mode_changed` over WebSocket so connected
clients can update their board indicator.

**Response:** `200 OK`

```json
{ "enabled": true }
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

### Broadcast Project Update

```
POST /projects/:id/broadcast
```

Used by API/agent services to trigger project-scoped WebSocket broadcasts without polling.

**Security contract:**

- Intended for trusted internal callers (API/agent/mcp services).
- If `INTERNAL_BROADCAST_TOKEN` is configured, callers must provide the same token via `Authorization: Bearer <token>` or `X-Internal-Broadcast-Token`.
- If no token is configured, only `NODE_ENV=development` enables the fallback path, and it only accepts loopback caller headers (`127.0.0.1`, `::1`, `localhost`).
- Unauthorized callers receive `401`.
- Relation validation is enforced before broadcasting:
  - `project:auto_queue_advanced` returns `400` when `taskId` does not belong to the target project.
  - `project:runtime_limit_updated` returns `400` when `runtimeProfileId` is omitted.
  - `project:runtime_limit_updated` returns `400` when `runtimeProfileId` does not belong to the target project and is not global.

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | One of `project:auto_queue_mode_changed`, `project:auto_queue_advanced`, `project:runtime_limit_updated` |
| `taskId` | string | no | Optional related task id for runtime-limit updates |
| `runtimeProfileId` | string\|null | conditional | Required for `project:runtime_limit_updated`; runtime profile whose persisted limit snapshot changed |

**Response:** `200 OK`

```json
{ "success": true }
```

---

## Runtime Profiles

Runtime profiles carry non-secret transport/model config plus the latest persisted runtime-limit snapshot used by API, agent, and UI surfaces.
For local Codex runtimes (`runtimeId=codex` with `sdk`/`cli` transport), `/runtime-profiles` and `/runtime-profiles/effective/*` now read limit overlays from the SQLite Codex index (`codex_limit_heads`) maintained by the background API indexer. Request handlers do not perform direct `~/.codex/sessions` scans.

### List Runtime Profiles

```
GET /runtime-profiles?projectId=<uuid>&includeGlobal=true&enabledOnly=false
```

**Response:** `200 OK` — array of runtime profile objects.

Notable runtime profile fields in list/detail/effective responses:

| Field                   | Type         | Description                                                                |
| ----------------------- | ------------ | -------------------------------------------------------------------------- |
| `runtimeLimitSnapshot`  | object\|null | Latest normalized provider/runtime limit state persisted for this profile  |
| `runtimeLimitUpdatedAt` | string\|null | ISO timestamp when the profile snapshot was last written or cleared        |
| `lastUsage`             | object\|null | Last recorded per-run usage totals for this profile (`input/output/total`) |
| `lastUsageAt`           | string\|null | ISO timestamp of the latest recorded usage event for this profile          |

### Effective Runtime Selection

```
GET /runtime-profiles/effective/task/:taskId
GET /runtime-profiles/effective/chat/:projectId
```

Both responses include the resolved `profile` object (or `null`) plus source metadata. When a profile is present, its payload includes `runtimeLimitSnapshot` and `runtimeLimitUpdatedAt`.
If no indexed Codex head is available for the resolved account/project scope, the response falls back to the persisted profile snapshot.

### Runtime Limit Snapshot Shape

The normalized `runtimeLimitSnapshot` object is shared across runtime-profile, task, and chat payloads:

| Field               | Type         | Description                                                                |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `source`            | string       | Limit source: `provider_api`, `sdk_event`, `api_headers`, or `turn_usage`  |
| `status`            | string       | `ok`, `warning`, `blocked`, or `unknown`                                   |
| `precision`         | string       | `exact` for hard quota data, `heuristic` for provider qualitative state    |
| `checkedAt`         | string       | ISO timestamp when the snapshot was observed                               |
| `providerId`        | string       | Provider namespace (for example `anthropic`, `openai`)                     |
| `runtimeId`         | string\|null | Runtime adapter id                                                         |
| `profileId`         | string\|null | Runtime profile id when known                                              |
| `primaryScope`      | string\|null | Main quota window scope (`requests`, `tokens`, `time`, etc.)               |
| `resetAt`           | string\|null | Provider reset timestamp when available                                    |
| `retryAfterSeconds` | number\|null | Retry hint when only backoff seconds are known                             |
| `warningThreshold`  | number\|null | Exact threshold percentage when the provider reports it                    |
| `windows`           | array        | Per-window quota details (`remaining`, `percentRemaining`, `resetAt`, ...) |
| `providerMeta`      | object\|null | Sanitized provider-specific qualitative metadata kept for diagnostics/UI   |

`providerMeta` is client-visible and always normalized before leaving the server. It may include safe identifiers such as `limitId`, `providerLabel`, `quotaSource`, `accountLabel`, `accountFingerprint`, `planType`, `modelUsageSummary`, or `toolUsageSummary`, but raw provider responses, headers, bodies, traces, and token-like fields are stripped or redacted.

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
| `paused` | boolean | no | `false` | Pause agent processing — coordinator skips this task until resumed |
| `useSubagents` | boolean | no | `false` | Run via custom subagents (`plan-coordinator`, `implement-coordinator`, sidecars). `false` uses `aif-*` skills directly |
| `runtimeProfileId` | string \| null | no | `null` | Task-specific runtime override. When absent, resolution falls back to project default, then app default, then environment fallback |
| `roadmapAlias` | string | no | `null` | Roadmap alias for grouping (e.g., `v1.0`) |
| `tags` | string[] | no | `[]` | Tags for filtering/categorization (max 50, each max 100 chars) |
| `scheduledAt` | string \| null | no | `null` | ISO-8601 UTC timestamp. If set, the coordinator fires the task into planning at that time. Must be in the future; `null` clears it. Accepted on both create and update. |

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

Notable task fields in the response:

| Field                   | Type         | Description                                                                                                      |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `manualReviewRequired`  | boolean      | `true` when auto-review stopped and explicit human review is required while the task remains in `done`           |
| `autoReviewState`       | object\|null | Latest persisted blocking-findings snapshot used by the auto-review loop (`strategy`, `iteration`, `findings[]`) |
| `runtimeLimitSnapshot`  | object\|null | Persisted runtime-limit snapshot copied onto the task when quota gating or quota failure blocks execution        |
| `runtimeLimitUpdatedAt` | string\|null | ISO timestamp for the last task-level runtime-limit snapshot write                                               |

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
| `paused` | boolean | Pause/resume agent processing for this task |
| `runtimeProfileId` | string\|null | Task-specific runtime override |
| `isFix` | boolean | Marks task as fix-flow |
| `plan` | string\|null | Generated plan (markdown) |
| `implementationLog` | string\|null | Implementation output |
| `reviewComments` | string\|null | Review feedback |
| `manualReviewRequired` | boolean | Explicit human-review handoff flag for `done` tasks |
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
| `backlog`          | `start_ai`, `accept_existing_plan`                       |
| `plan_ready`       | `start_implementation`, `request_replanning`, `fast_fix` |
| `blocked_external` | `retry_from_blocked`                                     |
| `done`             | `approve_done`, `request_changes`                        |

Additional constraints:

- `start_implementation` requires `autoMode=false` (manual gate). For `autoMode=true`, implementation is picked automatically by the coordinator.
- `accept_existing_plan` reads the plan file from disk, saves it to the database, and transitions directly to `plan_ready` — skipping the planning stage entirely. Returns `404` if the plan file does not exist on disk.
- `fast_fix` requires `autoMode=false` and at least one human comment on the task.
- `request_changes` transitions `done -> implementing`, sets `reworkRequested=true`, and resets watchdog retry state (`retryCount=0`).
- With `autoMode=true`, coordinator can trigger this same `request_changes`-style rework loop automatically after review if blocking findings are extracted from `reviewComments`.
- If auto-review stops converging, the coordinator leaves the task in `done`, sets `manualReviewRequired=true`, and waits for a human `approve_done` or `request_changes` action.

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

**Security contract:**

- Intended for trusted internal callers (agent/API services only).
- Uses the same internal auth rules as `POST /projects/:id/broadcast`.
- Unauthorized callers receive `401`.

**Body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | `task:updated` | Event type: `task:updated`, `task:moved`, `task:activity`, or `task:scheduled_fired` |

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

## Runtime Profiles

### List Runtime Profiles

```
GET /runtime-profiles
```

**Query params:**

| Param           | Type                           | Required | Description                                                                                                             |
| --------------- | ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `projectId`     | string                         | no       | Project id for project-scoped queries and mixed listings                                                                |
| `includeGlobal` | boolean                        | no       | Include global profiles alongside project profiles                                                                      |
| `enabledOnly`   | boolean                        | no       | Return only enabled profiles                                                                                            |
| `scope`         | `global`\|`project`\|`visible` | no       | `global`: only global profiles, `project`: only same-project profiles, `visible`: project profiles plus visible globals |

`scope=project` requires `projectId`. `scope=global` returns only reusable profiles (`projectId = null`).
`scope=visible` is the default when omitted.
For local Codex profiles, this endpoint overlays the response from indexed Codex limit heads in SQLite instead of scanning `~/.codex/sessions` during request handling.

### Effective Runtime Resolution

```
GET /runtime-profiles/effective/task/:taskId
GET /runtime-profiles/effective/chat/:projectId
```

These endpoints return the effective runtime profile plus the resolution source. The runtime chain is:

1. task override
2. project default
3. app default
4. environment fallback

Planning and review follow the same pattern but use their dedicated defaults before inheriting from the task default at the same scope.

---

## AI Chat

Interactive AI chat powered by the runtime adapter system. Messages are sent via REST, responses stream back through WebSocket as tokens. The runtime used depends on the effective chat runtime for the project: project chat default, then app chat default, then environment fallback.

### Send Message

```
POST /chat
```

**Body:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `projectId` | string | yes | | Project UUID — sets the agent's working directory |
| `message` | string | yes | | User message (1-50,000 chars) |
| `clientId` | string | yes | | WebSocket client ID for streaming tokens back |
| `conversationId` | string | no | auto-generated | Pass the previous `conversationId` to continue a multi-turn conversation |
| `explore` | boolean | no | `false` | When `true`, the message is prefixed with `/aif-explore` for codebase exploration mode |
| `taskId` | string | no | | Task UUID — injects the task's full context (status, plan, implementation log, review comments, and redacted activity log) into the chat session for task-aware discussion |

**Response:** `200 OK`

```json
{
  "conversationId": "uuid",
  "sessionId": "uuid-or-null",
  "assistantMessage": null,
  "attachments": [],
  "runtimeLimitSnapshot": null
}
```

**Errors:**

- `404` — Project not found
- `429` — Runtime usage limit reached (`code: "CHAT_USAGE_LIMIT"`, response may include `runtimeLimitSnapshot`)
- `500` — Chat request failed (`code: "CHAT_REQUEST_FAILED"`)

On error, a `chat:error` event is sent via WebSocket before the HTTP response. Both HTTP and WebSocket chat payloads normalize `runtimeLimitSnapshot` before emission, so client-visible snapshots follow the same sanitized contract as runtime-profile and task payloads.

**Timeout:** Requests may take up to 120 seconds due to agent processing.

### Streaming

Chat responses stream via WebSocket events to the `clientId` specified in the request:

| Event        | Payload                                                                                            | Description                           |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `chat:token` | `{ conversationId, token }`                                                                        | Incremental text token from the agent |
| `chat:done`  | `{ conversationId, usage?, projectId?, taskId?, runtimeProfileId?, runtimeLimitSnapshot? }`        | Stream completed                      |
| `chat:error` | `{ conversationId, message, code, projectId?, taskId?, runtimeProfileId?, runtimeLimitSnapshot? }` | Error occurred during streaming       |

### Multi-turn Conversations

To continue a conversation, pass the `conversationId` returned from the first message in subsequent requests. The server tracks runtime session IDs internally and uses `resume` to maintain context (for runtimes that support it).

Calling `clearMessages` on the client (or omitting `conversationId`) starts a fresh conversation.

### Chat Sessions

```
GET /chat/sessions?projectId=<uuid>
POST /chat/sessions
PUT /chat/sessions/:id
DELETE /chat/sessions/:id
```

Chat sessions persist the runtime profile chosen when the session starts. This keeps older conversations tied to the runtime they were created with even if the project's current default changes later.
For local Codex runtimes, session discovery uses the indexed `codex_sessions` read-model. Session detail/message reads resolve `sessionId -> filePath` from the same index before compatibility fallback to runtime-adapter lookups.

`POST` and `PUT` accept `runtimeProfileId` as an optional field. The value must be either a global profile or one owned by the same project.

### Permissions

The agent runs with `permissionMode: "bypassPermissions"` by default (when `AGENT_BYPASS_PERMISSIONS=true` in environment) — all file edits and shell commands are auto-approved, matching the behavior of task-processing subagents.

When `AGENT_BYPASS_PERMISSIONS=false`, the agent runs with `permissionMode: "acceptEdits"` — file reads and edits are auto-approved, but dangerous shell commands require confirmation.

### Agent Capabilities

The chat agent has access to: `Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, `Skill`. Max turns per request: 20. The agent is scoped to the project's root path and instructed not to access files outside it.

**Allowed skills:** `aif-docs`, `aif-ci`, `aif-explore`, `aif-reference`, `aif-evolve`, `aif-build-automation`, `aif-dockerize`, `aif-grounded`, `aif`, `aif-rules`. Other skills are blocked by the system prompt.

### Task-Aware Context

When `taskId` is provided, the chat session's system prompt includes the full task context:

- Task title, status, and description
- Plan (if available)
- Implementation log (if available)
- Review comments (if available)
- Agent activity log (if available)

This allows the agent to discuss implementation details, summarize what was done, help debug review feedback, or create follow-up tasks — all without re-reading from storage.

### Chat Actions

The chat agent can emit structured actions embedded in responses. The client parses these and presents confirmation cards for user approval.

**CREATE_TASK** — when the user asks to create a task from the conversation, the agent outputs:

```html
<!--ACTION:CREATE_TASK-->
{"title": "Task title", "description": "Detailed description"}
<!--/ACTION-->
```

The client extracts the JSON, renders a preview card with the task title and description, and shows a "Create Task" button. On confirmation, the task is created via `POST /tasks` in the current project.

### Error and Tool Feedback

The chat streams additional feedback beyond text tokens:

- **Tool use summaries** — after a tool executes, its human-readable summary is streamed as a blockquote
- **Permission denials** — if a tool is blocked by the permission mode, a `**Permission denied**` message is streamed with the tool name
- **Agent errors** — max turns, budget limits, and execution errors are surfaced as `**Error:**` messages instead of silent failures

### Explore Mode

When `explore: true`, the user message is wrapped as `/aif-explore <message>`, invoking the codebase exploration skill. This is toggled via the "Explore" checkbox in the UI.

---

## WebSocket

Connect to `ws://localhost:3009/ws` for real-time updates.

### Events

All events are JSON with this structure:

```json
{
  "type": "event-type",
  "payload": {}
}
```

| Event                             | Payload                                                                                            | Triggered By                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `project:created`                 | Full project object                                                                                | `POST /projects`                                                                     |
| `task:created`                    | Full task object                                                                                   | `POST /tasks`, `POST /projects/:id/roadmap/import`                                   |
| `task:updated`                    | Full task object                                                                                   | `PUT /tasks/:id`, `PATCH /tasks/:id/position`, `POST /tasks/:id/events` (`fast_fix`) |
| `task:moved`                      | Full task object                                                                                   | `POST /tasks/:id/events`                                                             |
| `task:deleted`                    | `{ id: string }`                                                                                   | `DELETE /tasks/:id`                                                                  |
| `sync:task_created`               | Full task object                                                                                   | MCP `handoff_create_task`                                                            |
| `sync:task_updated`               | Full task object                                                                                   | MCP `handoff_update_task`, `handoff_push_plan`                                       |
| `sync:status_changed`             | Full task object                                                                                   | MCP `handoff_sync_status`                                                            |
| `sync:plan_pushed`                | Full task object                                                                                   | MCP `handoff_push_plan`                                                              |
| `chat:token`                      | `{ conversationId, token }`                                                                        | `POST /chat` — streaming response tokens                                             |
| `chat:done`                       | `{ conversationId, usage?, projectId?, taskId?, runtimeProfileId?, runtimeLimitSnapshot? }`        | `POST /chat` — stream completed                                                      |
| `chat:error`                      | `{ conversationId, message, code, projectId?, taskId?, runtimeProfileId?, runtimeLimitSnapshot? }` | `POST /chat` — error during streaming                                                |
| `task:scheduled_fired`            | Full task object                                                                                   | Coordinator fires a backlog task whose `scheduledAt` is due                          |
| `project:auto_queue_mode_changed` | Full project object                                                                                | `PATCH /projects/:id/auto-queue-mode`                                                |
| `project:auto_queue_advanced`     | `{ id: string }` (task id)                                                                         | Coordinator auto-advances the next backlog task in an auto-queue project             |
| `project:runtime_limit_updated`   | `{ projectId, runtimeProfileId, taskId? }`                                                         | Persisted runtime-profile limit state or last usage changed                          |

### Connection

The WebSocket endpoint is a broadcast channel with no topic subscriptions; connected clients receive all events. Keep this endpoint behind trusted network boundaries and do not include raw provider diagnostics or secrets in event payloads.

Runtime-limit invalidation is project-scoped:

- `project:runtime_limit_updated` payload is `{ projectId, runtimeProfileId, taskId? }`, and `runtimeProfileId` is required at emission time.
- API/agent callers emit this via `POST /projects/:id/broadcast` after runtime snapshot/usage updates.

## MCP Sync Integration

The Handoff MCP server (`packages/mcp`) provides bidirectional sync between AIF tooling and Handoff via the Model Context Protocol. When MCP tools modify tasks, they broadcast `sync:*` events over the WebSocket system so the Kanban UI reflects changes in real time.

The web settings route `POST /settings/mcp/install` installs the MCP server into supported runtimes. When `MCP_PORT` is a valid integer port in the server environment, it writes a streamable HTTP entry pointing to `http://localhost:<MCP_PORT>/mcp`; otherwise it writes the local `stdio` launcher entry. The response includes per-runtime success/error entries, so partial install failures are surfaced without hiding runtimes that succeeded.

See [MCP Sync Server](mcp-sync.md) for full documentation.

## See Also

- [Architecture](architecture.md) — system overview and data flow
- [Configuration](configuration.md) — server port and environment settings
- [MCP Sync Server](mcp-sync.md) — MCP tools and sync protocol
