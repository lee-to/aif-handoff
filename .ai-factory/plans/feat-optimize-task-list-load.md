# Implementation Plan: Optimize Task List Page Load

Branch: `feat/optimize-task-list-load`
Created: 2026-06-26
Issue: https://github.com/lee-to/aif-handoff/issues/137

> **PR split (2026-06-28, rev 3 — reorder to replacement-before-victim):**
> After multiple review rounds, the chain was reordered so every PR is
> independently merge-safe (additive, no flag). This PR is now **additive**, not
> backend-only:
>
> - **#138 (this PR):** `TaskListItem` (shared) + `listTaskListItems()` (data) +
>   scoped `GET /tasks?projectId` returns lite `TaskListItem[]` + Board migrates
>   to TaskListItem (TS parity) + Board/TaskListItem parity test. **The bare
>   `GET /tasks` (no projectId) path stays alive** returning full `Task[]` until
>   dashboard consumers migrate to `/projects/overview` (cleanup PR). Merge-safe:
>   nothing breaks — Board uses the new lite path, dashboard keeps the legacy bare
>   path. No flag needed.
> - **#139:** `GET /projects/overview` aggregate endpoint (additive). Replaces
>   the bare `GET /tasks` for the dashboard once landed.
> - **#141 (dashboard migration):** `App.tsx` + `ProjectsOverview` consume
>   `/projects/overview`, drop bare-GET callers. Stacked on #138 + #139.
> - **cleanup (chore/remove-bare-task-list):** removes the bare `GET /tasks`
>   path once #141 has migrated its last consumer. Victim dies last.
> - **#140 (perf runner):** Windows hardening + scoped k6. Orthogonal.
>
> The earlier "bare GET /tasks returns 400" design (rev 2) was merge-unsafe: it
> killed the victim before its replacement existed. This additive model fixes
> that — see the chain-summary comment on the PR for the full rationale.

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: Skipped by user.

## Summary

Optimize the first board load when a project is already selected. The page must not fetch every task across every project as a fallback, and the project board list must not transfer full task detail payloads such as plans, implementation logs, review comments, agent activity logs, attachments, or runtime options.

Current code after the latest update already batch-resolves effective runtime profiles in `GET /tasks`, which removes the old runtime-profile N+1 path. The remaining problems are:

- `packages/api/src/routes/tasks.ts` still allows `GET /tasks` without `projectId`, which returns all tasks.
- `packages/api/src/routes/tasks.ts` still maps list results through the full task response.
- `packages/data/src/index.ts` still has `listTasks(projectId?: string)` as a full-row query.
- `packages/web/src/App.tsx` uses `useTasks(project?.id ?? null)`, so the task request waits for the project object instead of the known selected project id.
- `packages/web/src/App.tsx` and `packages/web/src/components/project/ProjectsOverview.tsx` call `api.listTasks()` without `projectId`.
- `packages/web/src/components/kanban/Board.tsx` uses `task.plan` for the `no_plan` filter, which forces the list payload to include heavy plan text unless replaced by a lightweight flag.

## Goals

- Opening `/project/:projectId` or a stored selected project should issue a project-scoped task list request immediately: `GET /tasks?projectId=:projectId`.
- `GET /tasks` without `projectId` should no longer be an implicit "load all tasks" API for the web UI.
- The task list response should be a lightweight list contract with only board, list, search, filter, metrics, and command-palette fields.
- Full task details should remain available from `GET /tasks/:id` and mutation responses.
- The projects overview should not load every task row. It should use an explicit lightweight overview endpoint or aggregate data.
- Tests and docs must capture the new contract so the all-task fallback does not return later.

## Non-Goals

- Do not redesign the Kanban UI.
- Do not introduce board pagination or virtualization in this pass unless tests show a project-scoped lightweight payload is still too large.
- Do not change task state-machine semantics.
- Do not remove the full task detail response used by task detail, comments, chat, and agent workflows.

## Commit Plan

- **Commit 1** (after tasks 1-3): `feat(tasks): add lightweight task list contract`
- **Commit 2** (after tasks 4-6): `feat(web): stop unscoped task loading`
- **Commit 3** (after task 7): `docs,test: document task list loading contract`

## Tasks

### Phase 1: Contract and Data Layer

- [x] Task 1: Add shared lightweight task list and overview contracts.

  Deliverable:
  - Add a shared `TaskListItem` type exported through `@aif/shared` and `@aif/shared/browser`.
  - Add a shared project overview response type if the overview endpoint is implemented separately, for example `ProjectTaskOverview`.
  - `TaskListItem` should include fields used by the board, list table, filters, metrics, command palette, and runtime-limit display:
    - identity and display: `id`, `projectId`, `title`, `description`
    - board state: `status`, `priority`, `position`, `autoMode`, `isFix`, `paused`
    - scheduling and blocking: `scheduledAt`, `blockedReason`, `blockedFromStatus`, `retryAfter`, `retryCount`
    - metrics: `tokenInput`, `tokenOutput`, `tokenTotal`, `costUsd`
    - tags and roadmap: `tags`, `roadmapAlias`
    - review flags: `reworkRequested`, `reviewIterationCount`, `maxReviewIterations`, `manualReviewRequired`
    - runtime-limit display: `runtimeLimitSnapshot`, `runtimeLimitUpdatedAt`
    - runtime selectors needed by the list: `runtimeProfileId`, `modelOverride`
    - timestamps: `lastSyncedAt`, `createdAt`, `updatedAt`
    - derived flag: `hasPlan`
  - Exclude heavy detail-only fields from `TaskListItem`: `attachments`, `plan`, `implementationLog`, `reviewComments`, `agentActivityLog`, `runtimeOptions`, `autoReviewState`, and QA detail text fields.

  Files:
  - `packages/shared/src/types.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/browser.ts`

  Depends on:
  - None.

  Logging requirements:
  - No runtime logs are needed for type-only changes.
  - Document in comments or tests that `TaskListItem` intentionally excludes heavy fields; do not log task body contents.

- [x] Task 2: Add project-scoped lightweight task list and project overview data queries.

  Deliverable:
  - Add a data-layer function such as `listTaskListItems(projectId: string): TaskListItem[]`.
  - Make the function require a project id; do not accept optional `projectId` for this list path.
  - Use an explicit summary projection instead of full `tasks.*` selection.
  - Add `description`, `scheduledAt`, `tokenInput`, `tokenOutput`, and a derived `hasPlan` flag to the projection used by the board list.
  - Keep existing full-row `listTasks` available for detail, agent, and internal workflows that genuinely need full task rows.
  - Add a data-layer overview query for `ProjectsOverview`, for example `listProjectTaskOverviews()`, that returns per-project status counts, metric totals, retry/flag counts, and a small title preview per status without returning all tasks.
  - Prefer SQL aggregation for counts and totals. If preview titles require post-processing, select only the small preview projection.

  Files:
  - `packages/data/src/index.ts`
  - `packages/data/src/__tests__/index.test.ts`

  Depends on:
  - Task 1.

  Logging requirements:
  - Data-layer functions should not log per-row payloads.
  - If query timing/logging is added, log only aggregate metadata at DEBUG level: `{ projectId, count, projection: "task-list" }` or `{ projectCount, projection: "project-task-overview" }`.
  - Errors should keep existing exception behavior; do not swallow DB errors.

### Phase 2: API Surface

- [x] Task 3: Change the task list API to require `projectId` and return the lightweight contract.

  Deliverable:
  - Update `GET /tasks` so missing `projectId` returns `400` with a clear error.
  - Preserve current invalid UUID handling for malformed `projectId`.
  - Return `TaskListItem[]` from the project-scoped list path.
  - Keep `GET /tasks/:id` as the full `Task` response.
  - Do not run effective runtime resolution for list rows unless a current UI consumer truly needs it. If it is still needed, keep the existing batch resolver and return only the minimal effective runtime fields.
  - Add or update repository exports so API code reads task list data only through `@aif/data`.

  Files:
  - `packages/api/src/routes/tasks.ts`
  - `packages/api/src/repositories/tasks.ts`
  - `packages/api/src/__tests__/tasks.test.ts`
  - `packages/data/src/index.ts`

  Depends on:
  - Task 2.

  Logging requirements:
  - DEBUG on successful list requests: `{ projectId, count, responseType: "TaskListItem" }`.
  - WARN on missing or invalid `projectId`, without request cookies or auth headers.
  - ERROR only for unexpected failures; include `projectId` and route name, not task bodies.

- [x] Task 4: Add an explicit lightweight project overview API and remove overview dependence on unscoped task lists.

  Deliverable:
  - Add an endpoint such as `GET /projects/overview` before dynamic `/:id` routes.
  - Return compact per-project task metrics, status counts, and preview titles needed by `ProjectsOverview`.
  - Keep `GET /projects` behavior compatible unless the implementation deliberately extends `Project` with optional overview fields.
  - Ensure the overview endpoint never returns full task rows.
  - Update API tests for empty projects, multiple projects, status grouping, metrics, and preview limits.

  Files:
  - `packages/api/src/routes/projects.ts`
  - `packages/api/src/repositories/projects.ts`
  - `packages/api/src/__tests__/projects.test.ts`
  - `packages/data/src/index.ts`
  - `packages/shared/src/types.ts`

  Depends on:
  - Task 2.

  Logging requirements:
  - DEBUG on successful overview requests: `{ projectCount, responseType: "ProjectTaskOverview" }`.
  - WARN for validation errors if query parameters are added later.
  - Do not log preview task titles in production logs; counts and ids are enough for diagnostics.

### Phase 3: Web Integration

- [x] Task 5: Update the web API client, hooks, and selected-project startup path.

  Deliverable:
  - Change `api.listTasks` to require `projectId: string` and return `Promise<TaskListItem[]>`.
  - Add `api.listProjectTaskOverviews()` for the new overview endpoint.
  - Change `useTasks` to accept only a selected project id and call `api.listTasks(projectId)`.
  - Initialize `selectedProjectId` synchronously from the URL path or stored project id before `projects` are loaded.
  - Use `useTasks(selectedProjectId)` instead of `useTasks(project?.id ?? null)` so the selected-project task request can start before project metadata resolves.
  - When `projects` eventually load, validate that the selected project still exists; clear stale selection only after validation.
  - Remove the `App.tsx` `api.listTasks()` all-task fallback.
  - Ensure no query with key `["tasks", "all"]` remains for the selected-project startup path.

  Files:
  - `packages/web/src/lib/api.ts`
  - `packages/web/src/hooks/useTasks.ts`
  - `packages/web/src/App.tsx`
  - `packages/web/src/__tests__/App.test.tsx` if present, or add focused tests under `packages/web/src/__tests__/`

  Depends on:
  - Tasks 3 and 4.

  Logging requirements:
  - Keep verbose client logs at API boundaries:
    - `console.debug("[api] GET /tasks?projectId=%s", projectId)`
    - `console.debug("[api] GET /projects/overview")`
  - Do not log task arrays or descriptions.
  - Add DEBUG-only logs around stale selected-project clearing if helpful: `{ selectedProjectId, reason }`.

- [x] Task 6: Update board, overview, metrics, command palette, and WebSocket cache typing to use lightweight list items.

  Deliverable:
  - Change board/list-only components from `Task` to `TaskListItem` where they do not need full details:
    - `Board`
    - `Column`
    - `TaskCard`
    - `TaskListTable`
    - `CommandPalette`
    - `useTaskFiltering`
  - Change `calculateTaskMetrics` to accept a lightweight metric input type or `TaskListItem[]`.
  - Replace the board `no_plan` filter from `task.plan` to `task.hasPlan`.
  - Update `ProjectsOverview` to use project overview data instead of `api.listTasks()`.
  - Update WebSocket status lookup from `getQueriesData<Task[]>({ queryKey: ["tasks"] })` to the lightweight list item type.
  - Keep `TaskDetail`, task settings, task plan, comments, and chat on the full `Task` detail contract.
  - Ensure task mutations still invalidate `["tasks"]` scoped lists and full `["task", id]` details.

  Files:
  - `packages/web/src/components/kanban/Board.tsx`
  - `packages/web/src/components/kanban/Column.tsx`
  - `packages/web/src/components/kanban/TaskCard.tsx`
  - `packages/web/src/components/kanban/TaskListTable.tsx`
  - `packages/web/src/components/layout/CommandPalette.tsx`
  - `packages/web/src/components/project/ProjectsOverview.tsx`
  - `packages/web/src/hooks/useTaskFiltering.ts`
  - `packages/web/src/hooks/useWebSocket.ts`
  - `packages/web/src/lib/taskMetrics.ts`
  - `packages/web/src/__tests__/Board.test.tsx`
  - `packages/web/src/__tests__/TaskListTable.test.tsx`
  - `packages/web/src/__tests__/taskMetrics.test.ts`

  Depends on:
  - Task 5.

  Logging requirements:
  - Keep WebSocket logs event-oriented: event type, task id, affected query keys.
  - Do not log full cached task arrays.
  - If query invalidation debugging is added, log at DEBUG with `{ taskId, projectId, queryKey }`.

### Phase 4: Tests, Docs, and Verification

- [x] Task 7: Add regression tests, update docs, and verify the optimized load path.

  Deliverable:
  - API tests:
    - `GET /tasks` without `projectId` returns `400`.
    - `GET /tasks?projectId=:id` returns only that project's `TaskListItem[]`.
    - List response includes `hasPlan` and excludes heavy fields.
    - `GET /tasks/:id` still returns full task detail including `plan` and logs.
    - `GET /projects/overview` returns aggregates and preview data without full task rows.
  - Data tests:
    - lightweight list query filters by project id.
    - lightweight projection includes board-required fields.
    - lightweight projection excludes heavy fields.
    - overview aggregation handles empty projects and multiple projects.
  - Web tests:
    - selected project from URL or storage triggers `GET /tasks?projectId=:id`.
    - selected-project startup does not call bare `GET /tasks`.
    - `ProjectsOverview` calls the overview endpoint instead of bare `GET /tasks`.
    - `no_plan` filter uses `hasPlan`.
  - Docs:
    - Update `docs/api.md` for the new task list contract and overview endpoint.
    - Update `docs/architecture.md` if needed to describe list-vs-detail task payloads.
    - Mention that `GET /tasks/:id` remains the full detail endpoint.
  - Manual/perf check:
    - Open a selected project page and confirm network requests include `GET /tasks?projectId=:id` and do not include bare `GET /tasks`.
    - Compare response payload shape to confirm heavy fields are absent from the list endpoint.

  Files:
  - `packages/data/src/__tests__/index.test.ts`
  - `packages/api/src/__tests__/tasks.test.ts`
  - `packages/api/src/__tests__/projects.test.ts`
  - `packages/web/src/__tests__/Board.test.tsx`
  - `packages/web/src/__tests__/TaskListTable.test.tsx`
  - `packages/web/src/__tests__/taskMetrics.test.ts`
  - `docs/api.md`
  - `docs/architecture.md`

  Depends on:
  - Tasks 1-6.

  Logging requirements:
  - Tests should assert behavior, not log snapshots.
  - If a test captures logs, assert route-level metadata only and no task bodies.
  - Manual verification notes should include request path, status code, item count, and response field presence/absence.

## Verification Commands

Run these after implementation:

- `npm run lint`
- `npm test`
- `npm run build`

Targeted checks during implementation:

- `npm test --workspace @aif/data`
- `npm test --workspace @aif/api -- tasks`
- `npm test --workspace @aif/api -- projects`
- `npm test --workspace @aif/web`

## Acceptance Criteria

- A selected project page no longer triggers a bare `GET /tasks`.
- `GET /tasks` without `projectId` returns `400`.
- `GET /tasks?projectId=:id` returns lightweight list items only for that project.
- Task list payloads do not include `plan`, `implementationLog`, `reviewComments`, `agentActivityLog`, `attachments`, or `runtimeOptions`.
- `GET /tasks/:id` still returns full task detail.
- `ProjectsOverview` no longer loads all tasks.
- Existing board filters, list mode, command palette, metrics, and runtime-limit display still work.
- Lint, tests, and build pass.
- Docs describe the list/detail contract split.
