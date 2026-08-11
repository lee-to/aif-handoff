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

## Participant Authentication and Administration

These contracts are active only when `PARTICIPANTS_MODE_ENABLED=true`. When disabled,
legacy anonymous access remains available and `GET /auth/session` reports
`participantsModeEnabled: false`. When enabled, only `GET /health`, `GET /auth/session`,
`POST /auth/login`, and CORS preflight are public. Browser requests use credentials;
unsafe methods also require an exact allowed `Origin` and `X-CSRF-Token` from the current
session response.

### Session and Login

```text
GET  /auth/session
POST /auth/login
POST /auth/change-password
POST /auth/logout
```

`POST /auth/login` accepts `{ "username": "admin", "password": "..." }`, sets an
opaque `HttpOnly; SameSite=Strict` session cookie, and returns:

```json
{
  "participantsModeEnabled": true,
  "authenticated": true,
  "participant": {
    "id": "uuid",
    "displayName": "Workspace Admin",
    "role": "admin",
    "active": true
  },
  "csrfToken": "session-bound-token",
  "expiresAt": "2026-08-07T12:00:00.000Z"
}
```

`GET /auth/session` returns the same shape, with `participant`, `csrfToken`, and
`expiresAt` set to `null` when unauthenticated. `POST /auth/logout` revokes the server
session, clears the cookie, and emits `auth:session_revoked`.

`POST /auth/change-password` requires an active member or admin session and accepts
`{ "currentPassword": "...", "newPassword": "at-least-12-characters" }`. It keeps the
current session active, revokes the participant's other sessions, and emits
`participant:updated`. Credential attempts use the configured login rate-limit window.

Authentication error codes include `invalid_credentials` (`401`),
`authentication_required` (`401`), `invalid_current_password` (`403`), `invalid_csrf` (`403`), `origin_not_allowed` (`403`),
`rate_limited` (`429`, with `Retry-After`), `participants_mode_disabled` (`409`), and
`auth_store_error` (`500`). Responses never include password hashes, raw session tokens,
cookies, or provider credentials.

### Participant Administration

All participant endpoints require an active admin session:

```text
GET   /participants?includeInactive=false
POST  /participants
PATCH /participants/:id
POST  /participants/:id/deactivate
POST  /participants/:id/reset-password
```

- Create body: `username`, `displayName`, `password` (minimum 12 characters), and optional
  `role` (`member` by default).
- Update body: at least one of `displayName` or `role`.
- Reset body: `{ "password": "at-least-12-characters" }`.
- Deactivation and password reset revoke the target participant's sessions. The final
  active admin cannot be deactivated or demoted.

Administration error codes are `forbidden`, `not_found`, `duplicate_username`,
`final_active_admin`, `inactive_participant`, `invalid_input`, and
`participant_store_error`.

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
    "pinnedAt": "2026-01-02T00:00:00.000Z",
    "groupName": "Platform",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

### Project Task Overview

```
GET /projects/overview
```

Returns compact per-project task aggregates for the projects overview screen.
This endpoint does not return full task rows.

**Response:** `200 OK`

```json
[
  {
    "projectId": "uuid",
    "lastActivityAt": "2026-01-03T12:00:00.000Z",
    "totalTasks": 12,
    "completedTasks": 2,
    "verifiedTasks": 0,
    "backlogTasks": 4,
    "activeTasks": 6,
    "blockedTasks": 1,
    "autoModeTasks": 3,
    "fixTasks": 1,
    "totalRetries": 3,
    "totalTokenInput": 1200,
    "totalTokenOutput": 800,
    "totalTokenTotal": 2000,
    "totalCostUsd": 0.25,
    "statusCounts": {
      "backlog": 4,
      "planning": 1,
      "plan_ready": 2,
      "implementing": 1,
      "review": 1,
      "blocked_external": 1,
      "done": 2,
      "verified": 0
    },
    "statusPreviews": {
      "backlog": [{ "id": "task-1", "title": "Queued work" }],
      "planning": [],
      "plan_ready": [],
      "implementing": [],
      "review": [],
      "blocked_external": [],
      "done": [],
      "verified": []
    }
  }
]
```

`completedTasks` counts `done` + `verified`. `activeTasks` counts every status
that is not `backlog`, `done`, or `verified`. `blockedTasks` counts
`blocked_external`. `statusPreviews` lists are small (bounded in SQL) and
include only task id/title pairs — never plan text, logs, or other detail-only
fields. `lastActivityAt` is the latest task `updatedAt` timestamp for the
project, or `null` when the project has no tasks.

### Create Project

```
POST /projects
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Project name (1-200 chars) |
| `rootPath` | string | yes | Absolute path to project root, for example `/Users/me/projects/my-project`. With Docker, paths outside `PROJECTS_MOUNT` are resolved below that mount |
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

### Update Project Organization

```
PATCH /projects/:id/organization
```

Updates picker-only organization metadata without requiring the project's name
or root path.

**Body:**

| Field       | Type         | Required | Description                                                             |
| ----------- | ------------ | -------- | ----------------------------------------------------------------------- |
| `pinned`    | boolean      | no       | Pin or unpin the project. Pinning preserves the original pin timestamp. |
| `groupName` | string\|null | no       | Flat picker group (max 100 chars); `null` or an empty string clears it. |

At least one field is required.

**Response:** `200 OK` — the updated project object. Returns `404` when the
project does not exist.

**WebSocket event:** `project:organization_updated` with the full project
object.

Parallel auto-queue with `git.create_branches=true` requires
`AIF_TASK_WORKTREES_ENABLED=true`. With the default `false`, the API rejects
that combination and the coordinator keeps branch-isolated projects serial.

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

**Backlog ordering:** Roadmap import is the explicit front-of-queue path. New
roadmap tasks receive explicit backlog positions ahead of the current backlog
minimum so auto-queue consumes them by phase/sequence order before ordinary
backlog rows.

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
coordinator advances the next backlog task with the smallest `position` into
planning whenever the project has no active/locked task. Ordinary `POST /tasks`
creation appends new backlog rows to the tail of that project's backlog, so the
default create path is FIFO. When
`AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED=true`, a Git task does not become
terminal until its local completion commit is verified. The resulting SHA is
exposed as `commitSha`; `autoQueueCommitStatus` reports `committed`,
`no_changes`, `not_applicable`, or a non-terminal/failure state. A failed
commit moves the task to `blocked_external` and prevents the next queued task
from starting. The flag defaults to `false`, which preserves legacy terminal
transitions and queue concurrency.

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

Parallel auto-queue with `git.create_branches=true` requires
`AIF_TASK_WORKTREES_ENABLED=true`. Queued full-mode tasks then receive isolated
git worktrees when planning starts. Git projects without isolated task
worktrees are processed serially while the completion-commit flag is enabled,
preserving task-scoped commit boundaries. Non-auto-queue projects retain their
existing concurrency behavior.

### Get Project Warmup State

```
GET /projects/:id/warmup
```

Returns the feature flag state, warmup support metadata for the project's
effective planner, implementer, and review runtimes, and active ready warmup
sessions if they exist. The response never includes raw seed session ids.

**Response:** `200 OK`

```json
{
  "enabled": true,
  "support": {
    "supported": true,
    "skipReason": null,
    "workflowKind": "planner",
    "profileMode": "plan",
    "runtimeId": "claude",
    "providerId": "anthropic",
    "runtimeProfileId": "profile-1",
    "transport": "sdk",
    "model": "claude-sonnet-4",
    "selectionSource": "project_default"
  },
  "targets": [
    {
      "supported": true,
      "skipReason": null,
      "workflowKind": "planner",
      "profileMode": "plan",
      "runtimeId": "claude",
      "providerId": "anthropic",
      "runtimeProfileId": "profile-1",
      "transport": "sdk",
      "model": "claude-sonnet-4",
      "selectionSource": "project_default"
    }
  ],
  "warmup": {
    "id": "warmup-1",
    "projectId": "project-1",
    "runtimeProfileId": "profile-1",
    "runtimeId": "claude",
    "providerId": "anthropic",
    "transport": "sdk",
    "model": "claude-sonnet-4",
    "status": "ready",
    "ttlSeconds": 3600,
    "expiresAt": "2026-04-30T12:00:00.000Z",
    "remainingSeconds": 2400,
    "summary": "Warmup summary",
    "errorMessage": null,
    "createdAt": "2026-04-30T11:00:00.000Z",
    "updatedAt": "2026-04-30T11:00:10.000Z"
  },
  "warmups": [
    {
      "id": "warmup-1",
      "projectId": "project-1",
      "runtimeProfileId": "profile-1",
      "runtimeId": "claude",
      "providerId": "anthropic",
      "transport": "sdk",
      "model": "claude-sonnet-4",
      "status": "ready",
      "ttlSeconds": 3600,
      "expiresAt": "2026-04-30T12:00:00.000Z",
      "remainingSeconds": 2400,
      "summary": "Warmup summary",
      "errorMessage": null,
      "createdAt": "2026-04-30T11:00:00.000Z",
      "updatedAt": "2026-04-30T11:00:10.000Z"
    }
  ]
}
```

### Create Project Warmup

```
POST /projects/:id/warmup
```

Creates reusable seed sessions for each distinct effective warmup-capable
planner, implementer, and review runtime. Requires `AIF_WARMUP_ENABLED=true`
and a runtime transport that advertises session fork support. TTL is bounded to
60–86400 seconds.

**Body:**

```json
{ "ttlSeconds": 3600 }
```

**Response:** `201 Created`

Returns the same shape as `GET /projects/:id/warmup`.

If at least one target warmup is created successfully and a later target fails,
the endpoint returns `207 Multi-Status` with the active successful or previously
ready warmups instead of treating the whole request as a cold failure:

```json
{
  "error": "Runtime failed while creating warmup",
  "code": "partial_warmup_failed",
  "failedTarget": "implementer",
  "partial": true,
  "warmup": {
    "id": "warmup-failed",
    "status": "failed"
  },
  "warmups": [
    {
      "id": "warmup-ready",
      "status": "ready"
    }
  ],
  "support": {
    "supported": true,
    "workflowKind": "planner"
  },
  "targets": []
}
```

Clients should treat `warmups` in a partial response as usable for the listed
targets and retry only the failed/missing target instead of assuming all warmups
were discarded.

**Errors:**

- `400` — invalid TTL.
- `403` — warmup feature flag is disabled.
- `404` — project not found.
- `409` — none of the effective warmup target runtimes support session fork.
- `502` — runtime execution failed or did not return a seed session id.
- `207` — partial success; at least one target warmup remains active while another target failed.

**WebSocket event:** `project:warmup_updated` with `{ projectId, status }`.

### Clear Project Warmup

```
DELETE /projects/:id/warmup
```

Clears active warmup rows for the project's current effective warmup target
runtimes.

**Response:** `200 OK`

```json
{ "success": true, "cleared": 1 }
```

**WebSocket event:** `project:warmup_updated` when at least one row is cleared.

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
- Outside tests, `INTERNAL_BROADCAST_TOKEN` must be configured and callers must provide the same token via `Authorization: Bearer <token>` or `X-Internal-Broadcast-Token`.
- Client-supplied proxy headers such as `X-Forwarded-For` never authorize broadcasts.
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

## GitHub Issue-to-PR

All endpoints in this section return `403` with `code: "feature_disabled"` unless
`AIF_GITHUB_ISSUE_PR_ENABLED=true`.

GitHub endpoints use the project connection's token environment variable. Token values are
never accepted in request bodies or returned in responses.

### Get GitHub State

`GET /projects/:id/github` returns `{ connection, issues }`. The connection includes
`tokenConfigured` but never the token. Each issue contains its task link and current PR,
checks, and review state.

### Connect or Disconnect

`PUT /projects/:id/github` validates repository access and stores the connection.

```json
{
  "repository": "owner/repository",
  "tokenEnvVar": "GITHUB_TOKEN",
  "enabled": true,
  "eligibility": {
    "labels": ["aif"],
    "assignee": null,
    "milestone": null
  }
}
```

`DELETE /projects/:id/github` removes the connection but preserves already imported tasks
and issue linkage.

### Synchronize Issues and Pull Requests

`POST /projects/:id/github/sync` with `{}` imports eligible open issues, refreshes linked
issues/comments, and reconciles PR review/check state. Repeated calls update the same task.
For a newly imported issue, sync also detects an open PR whose body contains a same-repository
`Closes`, `Fixes`, or `Resolves #<issue>` reference and creates the linked task directly in
`done`. If that PR already has an outstanding changes-requested review, the task instead
resumes at `implementing`. A closed issue pauses its task; an unmerged closed PR also pauses
it. A later `changes_requested` review resumes the same task at `implementing`; a merged PR
advances a PR-ready `done` task to `verified`.

### Publish a Task Pull Request

`POST /projects/:id/github/tasks/:taskId/publish` is used by the agent after pushing the
persisted task branch:

```json
{
  "branch": "feature/github-issue-154",
  "commitSha": "0123456789abcdef",
  "implementationLog": "Implemented and tested the requested change.",
  "reviewComments": "Automated review passed."
}
```

The endpoint creates or updates one PR containing `Closes #<issue>`, implementation and
test evidence, and a no-auto-merge notice. Automated review feedback uses one marker
comment updated only when its fingerprint changes. HTTP failures use structured
`code`, status, and optional `retryAt` fields for authentication, access, validation, and
rate-limit recovery. Trusted agent calls to sync/publish may use
`INTERNAL_BROADCAST_TOKEN`; browser calls use normal participant auth and CSRF rules.

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

| Param       | Type         | Required | Description                                                                                                                                                                                                        |
| ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectId` | query string | optional | Project UUID. Scoped to a project returns lightweight `TaskListItem[]`. Omitting it returns the legacy full `Task[]` across all projects (retained until dashboard consumers migrate to `GET /projects/overview`). |

**Response (scoped):** `200 OK` - array of lightweight `TaskListItem` objects sorted by
status order, then position.

**Response (bare, legacy):** `200 OK` - array of full `Task` objects across all
projects. This path is transitional and will be removed once the dashboard
moves to `GET /projects/overview`.

```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "title": "Task title",
    "description": "Short board text",
    "status": "backlog",
    "priority": 0,
    "position": 1100,
    "autoMode": true,
    "executionOwner": "ai",
    "ownershipRevision": 0,
    "assignees": [],
    "isFix": false,
    "paused": false,
    "hasPlan": false,
    "tokenInput": 0,
    "tokenOutput": 0,
    "tokenTotal": 0,
    "costUsd": 0,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

The list contract excludes detail-only fields such as `attachments`, `plan`,
`implementationLog`, `reviewComments`, `agentActivityLog`, `runtimeOptions`,
`autoReviewState`, and QA markdown artifacts. Use `GET /tasks/:id` for the full
task detail payload.

**Errors:**

- `400` - invalid `projectId` format

> Backlog ordering: ordinary task creation places new rows at the backlog tail,
> so API consumers see default-created backlog tasks in creation order unless a
> caller supplies an explicit `position`.

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
| `attachments` | array | no | `[]` | File attachments (max 100) |
| `priority` | integer | no | `0` | Priority level (0-5) |
| `autoMode` | boolean | no | `true` | Auto-advance through agent pipeline, including automatic post-review rework loop when fixes are detected |
| `executionOwner` | `ai` \| `human` | no | `ai` | Responsible executor; independent from `autoMode` |
| `assigneeIds` | string[] | no | `[]` | Active participant IDs for Human ownership (max 100); must be empty for AI ownership |
| `isFix` | boolean | no | `false` | Marks the task as fix-flow task (uses FIX plan conventions) |
| `skipReview` | boolean | no | `false` | Skip the review stage — task moves directly from implementing to done |
| `paused` | boolean | no | `false` | Pause agent processing — coordinator skips this task until resumed |
| `useSubagents` | boolean | no | `false` | Run via custom subagents (`plan-coordinator`, `implement-coordinator`, sidecars). `false` uses `aif-*` skills directly |
| `runPlanImprove` | boolean | no | `false` | Skills-mode only (`useSubagents=false`): run optional `/aif-improve` after planning and before `plan_ready`. Ignored and stored as `false` for subagent tasks |
| `runPostVerify` | boolean | no | `false` | Skills-mode only (`useSubagents=false`): run optional `/aif-verify` after implementation and before review. With `skipReview=true`, verification moves directly to `done`. Ignored and stored as `false` for subagent tasks |
| `autoQa` | boolean | no | `false` | Automatically run the QA pipeline (`/aif-qa --all`) when the task is approved (`approve_done`: `done → verified`) |
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

**Backlog ordering:** When `position` is not supplied by a specialized caller,
the data layer appends the new backlog task to the tail of that project's
backlog by assigning `max(position) + 100` within the project. Auto-queue then
consumes the smallest backlog position.

**WebSocket event:** `task:created`

### Get Task

```
GET /tasks/:id
```

**Response:** `200 OK` — full task object.

This is the full detail endpoint. It includes heavy task fields such as
attachments, plan, implementation log, review comments, agent activity log,
runtime options, auto-review state, and QA detail text when present.

Notable task fields in the response:

| Field                   | Type          | Description                                                                                                      |
| ----------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `manualReviewRequired`  | boolean       | `true` when auto-review stopped and explicit human review is required while the task remains in `done`           |
| `autoReviewState`       | object\|null  | Latest persisted blocking-findings snapshot used by the auto-review loop (`strategy`, `iteration`, `findings[]`) |
| `runtimeLimitSnapshot`  | object\|null  | Persisted runtime-limit snapshot copied onto the task when quota gating or quota failure blocks execution        |
| `runtimeLimitUpdatedAt` | string\|null  | ISO timestamp for the last task-level runtime-limit snapshot write                                               |
| `autoQa`                | boolean       | When `true`, the QA pipeline runs automatically once the task is approved (`approve_done`)                       |
| `qaStatus`              | string        | QA run lifecycle: `idle`, `running`, `done`, or `error`                                                          |
| `qaChangeSummary`       | string\|null  | Markdown change-summary artifact from the latest QA run (`null` until generated)                                 |
| `qaTestPlan`            | string\|null  | Markdown test-plan artifact from the latest QA run (`null` until generated)                                      |
| `qaTestCases`           | string\|null  | Markdown test-cases artifact from the latest QA run (`null` until generated)                                     |
| `executionOwner`        | `ai`\|`human` | Executor responsible for the task; independent from `autoMode`                                                   |
| `ownershipRevision`     | integer       | Monotonic optimistic-concurrency revision for assignments/handoffs                                               |
| `assignees`             | array         | Immutable participant summaries for current Human assignees                                                      |
| `permissions`           | object        | Server-derived `canAssign`, `canHandoff`, `canSelfAssign`, `canAct`, `canComment`, and `permittedActions`        |

### Handoff Task Ownership

```text
POST /tasks/:id/handoff
```

```json
{
  "executionOwner": "human",
  "assigneeIds": ["participant-uuid"],
  "expectedOwnershipRevision": 2,
  "expectedExecutionOwner": "ai",
  "expectedStatus": "implementing",
  "reason": "Optional audit reason"
}
```

The response contains `{ task, ownership, history }`. AI ownership requires an empty
`assigneeIds` array. Human ownership may be unassigned or have multiple active assignees.
Administrators may assign/handoff; a member may self-assign an unassigned Human task or
hand an assigned Human task back to AI. For Human → AI at manual `plan_ready`, include
`resumeAction: "start_implementation"`; for `blocked_external`, include
`resumeAction: "retry_from_blocked"` and the task must have `blockedFromStatus`.
`verified` is terminal and cannot be handed off.

Conflicts return `409` with `task_locked`, `ownership_revision_conflict`,
`inactive_assignee`, or `invalid_ownership_transition`. Authorization returns `403`
with `forbidden`; missing tasks return `404` with `task_not_found`. A successful handoff
emits `task:handoff` and `task:assignment_updated`.

### Executor History

```text
GET /tasks/:id/executor-history
```

Returns executor snapshots ordered by `ownershipRevision`, then creation time and ID.
Each immutable row records task title/status, owner, assignee display-name/role/active
snapshots, actor, optional reason, and timestamp. It is not derived from mutable activity
logs.

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
| `useSubagents` | boolean | Run via custom subagents. When set to `true`, `runPlanImprove` and `runPostVerify` are reset to `false` |
| `runPlanImprove` | boolean | Skills-mode only: run optional `/aif-improve` after planning and before `plan_ready` |
| `runPostVerify` | boolean | Skills-mode only: run optional `/aif-verify` after implementation and before review. With `skipReview=true`, verification moves directly to `done` |
| `autoQa` | boolean | Auto-run the QA pipeline when the task is approved (`done → verified`) |
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

With Participants Mode enabled, this endpoint, `POST /tasks/:id/sync-plan`,
`POST /tasks/:id/run-qa`, and `PATCH /tasks/:id/position` require either an
administrator or an active task assignee. Other authenticated participants receive
`403` with `code: "forbidden"` before any mutation or runtime dispatch occurs.

**WebSocket event:** `task:updated`

### Sync Task Plan

```text
POST /tasks/:id/sync-plan
```

Reads the task's configured plan file and persists its current contents. Returns the
updated task, `404` when the task/project or plan file is missing, and the authorization
error described under Update Task when Participants Mode is enabled.

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

With Participants Mode enabled, the server returns the authoritative action subset in
`task.permissions.permittedActions`. An assigned Human-owned task also supports:

| Current status        | Human-owned events                          |
| --------------------- | ------------------------------------------- |
| `backlog`             | `start_human_work`                          |
| `planning`, `improve` | `mark_plan_ready`                           |
| `plan_ready`          | `start_implementation`                      |
| `implementing`        | `submit_implementation`                     |
| `review`              | `complete_review`, `request_review_changes` |
| `verify`              | `pass_verification`, `fail_verification`    |
| `blocked_external`    | `retry_from_blocked`                        |
| `done`                | `approve_done`, `request_changes`           |

For AI-owned tasks, `improve` and `verify` are coordinator-only stages and intentionally
expose no legacy manual action. Human-owned tasks use the explicit actions above.

Additional constraints:

- `start_implementation` requires `autoMode=false` (manual gate). For `autoMode=true`, implementation is picked automatically by the coordinator.
- `accept_existing_plan` reads the plan file from disk, saves it to the database, and transitions directly to `plan_ready` — skipping the planning stage entirely. Returns `404` if the plan file does not exist on disk.
- `fast_fix` requires `autoMode=false` and at least one human comment on the task.
- `request_changes` transitions `done -> implementing`, sets `reworkRequested=true`, and resets watchdog retry state (`retryCount=0`).
- With `autoMode=true`, coordinator can trigger this same `request_changes`-style rework loop automatically after review if blocking findings are extracted from `reviewComments`.
- If auto-review stops converging, the coordinator leaves the task in `done`, sets `manualReviewRequired=true`, and waits for a human `approve_done` or `request_changes` action.

**Response:** `200 OK` — the updated task object.

**Errors:** `403` for `actor_not_authorized` or `assignment_required`; `409` for
`action_not_allowed`, `ai_handoff_required`, `blocked_status_missing`, or another
state-machine conflict.

**WebSocket event:** `task:moved`

### Run QA

```
POST /tasks/:id/run-qa
```

Manually triggers the `/aif-qa --all` pipeline for the task (fire-and-forget). The
runner generates three markdown artifacts under `<paths.qa>/<branch-slug>/`
(`change-summary.md`, `test-plan.md`, `test-cases.md`), persists them onto the task
(`qaChangeSummary`, `qaTestPlan`, `qaTestCases`), and updates `qaStatus`. Execution
uses the task's worktree root when present (`worktreePath`), otherwise the project
root. Artifact slugs use the task's persisted `branchName` when present; branchless
tasks fall back to the current git branch in the execution root. The same pipeline
runs automatically after `approve_done` when `autoQa = true`.

**Response:** `202 Accepted`

```json
{ "status": "accepted" }
```

**Errors:**

- `403` — QA pipeline feature flag is disabled (`AIF_QA_PIPELINE_ENABLED=false`); body carries `code: "feature_disabled"`
- `403` — participant is neither an administrator nor an active task assignee; body carries `code: "forbidden"`
- `404` — task not found
- `404` — project not found
- `409` — QA is already running (`qaStatus === "running"`)

**WebSocket events:** `task:qa_started` immediately, then `task:qa_done` or
`task:qa_failed` when the run finishes. The runner also broadcasts `task:updated`
as it writes `qaStatus` and the artifacts.

### Reorder Task

```
PATCH /tasks/:id/position
```

Manually changing backlog `position` changes auto-queue priority because the
coordinator always consumes the smallest backlog position first.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `position` | number | New position value for sorting |

**Response:** `200 OK` — the updated task object.

**Errors:** `403` with `code: "forbidden"` when Participants Mode is enabled and the
participant is neither an administrator nor an active task assignee.

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
    "participantId": "participant-uuid",
    "participant": {
      "id": "participant-uuid",
      "displayName": "Ada",
      "role": "member",
      "active": true
    },
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

With Participants Mode enabled, any active authenticated participant may comment on any
workspace task and attach files. Assignment controls task mutations, not visibility or
comment access.

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Comment text (1-20,000 chars) |
| `attachments` | array | no | File attachments (max 100) |

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

## Codex OAuth Login (Docker)

Wraps `codex login --device-auth` running inside the agent container so the
host browser can complete the device-code flow. All `/auth/codex/login/*`
mutating endpoints are gated behind `AIF_ENABLE_CODEX_LOGIN_PROXY=true`. When
the flag is `false` only `/auth/codex/capabilities` is mounted; the others
return `404`. See [Providers](providers.md#codex-oauth-login-in-docker-broker)
for the full design.

### Capabilities

```
GET /auth/codex/capabilities
```

**Response:** `200 OK`

```json
{ "loginProxyEnabled": true }
```

### Start Login

```
POST /auth/codex/login/start
```

Spawns `codex login --device-auth` in the agent container and parses the
verification URL plus one-time code.

**Response:** `200 OK`

```json
{
  "sessionId": "9f3c1a8e-...",
  "verificationUrl": "https://auth.openai.com/codex/device",
  "userCode": "ABCD-12345",
  "startedAt": "2026-04-27T16:30:00.000Z"
}
```

`409 Conflict` when a session is already active — the body still carries
`{sessionId, verificationUrl, userCode}` so the client can adopt it.
`500` on spawn failure or device-auth parse timeout.
`502` when the API cannot reach the broker over the docker network.

### Status

```
GET /auth/codex/login/status
```

**Response:** `200 OK`

```json
{
  "active": true,
  "sessionId": "9f3c1a8e-...",
  "verificationUrl": "https://auth.openai.com/codex/device",
  "userCode": "ABCD-12345",
  "startedAt": "2026-04-27T16:30:00.000Z"
}
```

When no session is active the response carries the **terminal result of the
last run** so the client can distinguish success from failure:

```json
{
  "active": false,
  "lastResult": {
    "ok": true,
    "sessionId": "9f3c1a8e-...",
    "reason": "success",
    "exitCode": 0,
    "signal": null,
    "finishedAt": "2026-04-27T16:32:14.000Z"
  }
}
```

`reason` is one of `success`, `exit_nonzero`, `signal`, `timeout`,
`parse_timeout`, `cancel`, `spawn_failed`. The UI **must** gate the success
transition on `lastResult.ok === true`. If no session has ever run the field
is omitted.

| Reason          | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `success`       | Codex CLI exited with code `0` and no signal — `~/.codex/auth.json` was written.   |
| `exit_nonzero`  | Codex CLI exited with a non-zero status code (network/TLS failure, server reject). |
| `signal`        | Codex CLI was killed by a signal (e.g. `SIGKILL`) before completing login.         |
| `timeout`       | The 5-minute wizard session expired before the user completed the browser flow.    |
| `parse_timeout` | The CLI did not print a verification URL + code within 15 seconds of spawn.        |
| `cancel`        | The user pressed Cancel; broker SIGTERMed the child.                               |
| `spawn_failed`  | The codex binary could not be spawned (missing/unexecutable, ENOENT/EACCES).       |

### Cancel

```
POST /auth/codex/login/cancel
```

`SIGTERM`s the active child process. Records a terminal result with
`reason: "cancel"`, `ok: false`.

**Response:** `200 OK`

```json
{ "ok": true, "cancelled": true, "sessionId": "9f3c1a8e-..." }
```

`{ ok: true, cancelled: false }` when there was no active session.

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
| `project:organization_updated`    | Full project object                                                                                | `PATCH /projects/:id/organization`                                                   |
| `task:created`                    | Full task object                                                                                   | `POST /tasks`, `POST /projects/:id/roadmap/import`                                   |
| `task:updated`                    | Full task object                                                                                   | `PUT /tasks/:id`, `PATCH /tasks/:id/position`, `POST /tasks/:id/events` (`fast_fix`) |
| `task:moved`                      | Full task object                                                                                   | `POST /tasks/:id/events`                                                             |
| `task:deleted`                    | `{ id: string }`                                                                                   | `DELETE /tasks/:id`                                                                  |
| `task:handoff`                    | `{ taskId, projectId, ownership, actor, responsibleParticipants }`                                 | Successful `POST /tasks/:id/handoff`                                                 |
| `task:assignment_updated`         | Same ownership payload as `task:handoff`                                                           | Successful ownership/assignment replacement                                          |
| `task:comment_created`            | Comment payload with participant summary when authored by a participant                            | `POST /tasks/:id/comments`                                                           |
| `task:qa_started`                 | `{ taskId, projectId, status: "started" }`                                                         | `POST /tasks/:id/run-qa`, or `approve_done` with `autoQa=true`                       |
| `task:qa_done`                    | `{ taskId, projectId, status: "done" }`                                                            | QA pipeline finished successfully                                                    |
| `task:qa_failed`                  | `{ taskId, projectId, status: "failed", error? }`                                                  | QA pipeline failed (runner returned `{ ok: false }`)                                 |
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
| `project:warmup_updated`          | `{ projectId, status }`                                                                            | Warmup create/delete/failure changed project warmup state                            |
| `participant:created`             | `{ participant, actor }`                                                                           | Admin participant creation                                                           |
| `participant:updated`             | `{ participant, actor }`                                                                           | Participant update, password change, or password reset                               |
| `participant:deactivated`         | `{ participant, actor }`                                                                           | Admin participant deactivation                                                       |
| `auth:session_revoked`            | `{ participantId }` (participant-targeted; not broadcast to other clients)                         | Logout, deactivation, role change, or password reset                                 |

### Connection

The WebSocket endpoint is a workspace broadcast channel with no topic subscriptions or
project ACL filtering: every authenticated socket receives task and project events. The
`auth:session_revoked` event is the exception and is delivered only by disconnecting the
matching participant's sockets. With
Participants Mode disabled, it keeps the legacy anonymous behavior. With Participants
Mode enabled, the upgrade must include the valid participant session cookie and an exact
allowed `Origin`; missing, expired, inactive, or disallowed sessions are rejected before
the connection is accepted. Revocation events make matching browser clients clear their
session and return to login. Event payloads contain IDs and safe snapshots, never raw
cookies, CSRF values, bearer tokens, passwords/hashes, or provider credentials.

Runtime-limit invalidation is project-scoped:

- `project:runtime_limit_updated` payload is `{ projectId, runtimeProfileId, taskId? }`, and `runtimeProfileId` is required at emission time.
- API/agent callers emit this via `POST /projects/:id/broadcast` after runtime snapshot/usage updates.
- `project:warmup_updated` payload is `{ projectId, status }`, where `status` is `ready`, `failed`, `partial`, `cleared`, or `expired`.

## MCP Sync Integration

The Handoff MCP server (`packages/mcp`) provides bidirectional sync between AIF tooling and Handoff via the Model Context Protocol. When MCP tools modify tasks, they broadcast `sync:*` events over the WebSocket system so the Kanban UI reflects changes in real time.

The web settings route `POST /settings/mcp/install` installs the MCP server into supported runtimes. When `MCP_PORT` is a valid integer port in the server environment, it writes a streamable HTTP entry pointing to `http://localhost:<MCP_PORT>/mcp`; otherwise it writes the local `stdio` launcher entry. The response includes per-runtime success/error entries, so partial install failures are surfaced without hiding runtimes that succeeded.

See [MCP Sync Server](mcp-sync.md) for full documentation.

## See Also

- [Architecture](architecture.md) — system overview and data flow
- [Configuration](configuration.md) — server port and environment settings
- [MCP Sync Server](mcp-sync.md) — MCP tools and sync protocol
