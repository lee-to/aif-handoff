# Scheduled Task Execution & Auto-Queue Mode

- **Branch:** `feature/scheduled-tasks-auto-queue`
- **Created:** 2026-04-12
- **Issue:** https://github.com/lee-to/aif-handoff/issues/63

## Settings

- **Testing:** yes (Vitest, ≥70% coverage; no DB mocks per CLAUDE.md)
- **Logging:** verbose (DEBUG on decisions, INFO on state changes)
- **Docs:** yes — mandatory `/aif-docs` checkpoint at completion

## Roadmap Linkage

- **Milestone:** none
- **Rationale:** All current roadmap milestones are completed; this feature is a net-new capability and no unchecked milestone applies.

## Summary

Add two related capabilities to the autonomous task pipeline:

1. **Scheduled execution** — `scheduledAt` timestamp on a task; coordinator fires the task into its next actionable stage when the time arrives.
2. **Auto-queue mode** — per-project toggle; when on, coordinator advances tasks one-at-a-time by `position` (orderIndex) through the full pipeline.

Out of scope (per issue): recurring cron schedules, parallel auto-mode execution, cross-project orchestration.

## Architecture Notes

- `scheduledAt` lives on `tasks` — nullable `TEXT` ISO-8601 UTC string (matches project convention in `schema.ts`; do **not** use integer timestamp mode). Scheduler clears it on fire. ISO-8601 strings are lexically sortable, so `<=` comparisons work with string semantics.
- `autoQueueMode` lives on `projects` (boolean, default false). **Named to avoid collision with existing per-task `tasks.autoMode`** (which is a per-task AI-processing flag — different semantics).
- Sequential guarantee in auto-queue mode reuses existing `hasActiveLockedTaskForProject(projectId)` + non-parallel project locking in the PIPELINE loop — no new concurrency primitive.
- State machine is unchanged — scheduler and auto-queue both trigger the existing `backlog → planning` transition path (same code path as human `start_ai` API action). Tasks outside `backlog` are never re-triggered by these features.
- Past timestamps rejected with 400 on both create AND update (null allowed to clear).
- New WS events registered in `packages/shared/src/types.ts` `WsEvent` union as part of Task #1: `task:scheduled_fired`, `project:auto_queue_mode_changed`, `project:auto_queue_advanced`.
- Scheduler fire and auto-queue advance append entries to `tasks.agentActivityLog` so the timeline surfaces automated triggers.

## Tasks (by phase)

### Phase 1 — Data foundation
1. [x] Add `scheduledAt` (tasks) + `autoQueueMode` (projects) to DB schema + WsEvent union + drizzle migration (Task #1)
2. [x] Extend `@aif/data` layer with scheduler queries (Task #2, blocks Phase 2+)

### Phase 2 — Agent behavior
3. [x] Scheduled-task trigger in coordinator polling loop (Task #3)
4. [x] Auto-queue mode in coordinator (Task #4)

### Phase 3 — API surface
5. [x] `scheduledAt` on task endpoints (Task #5)
6. [x] `GET`/`PATCH /projects/:id/auto-queue-mode` endpoints + WS broadcast (Task #6)

### Phase 4 — Frontend
7. [x] Task scheduling UI — picker + card badge (Task #7)
8. [x] Auto-mode toggle + board indicator (Task #8)

### Phase 5 — Quality & release
9. [x] Tests: scheduler + auto-queue coverage (Task #9)
10. [x] Docs + Docker + validation (Task #10)

Dependencies are modeled in the task list (`TaskList`): #2 blocked by #1; #3–#6 blocked by #2; #7 blocked by #5; #8 blocked by #6; #9 blocked by #3/#4/#5/#6; #10 blocked by #7/#8/#9.

## Commit Plan

10 tasks → use commit checkpoints every 3-4 tasks.

| Checkpoint | After tasks | Suggested message |
|---|---|---|
| 1 | #1, #2 | `feat(shared,data): add scheduledAt + autoQueueMode schema and queries` |
| 2 | #3, #4 | `feat(agent): scheduled-task trigger and auto-queue mode in coordinator` |
| 3 | #5, #6 | `feat(api): scheduledAt field and project auto-queue-mode endpoints` |
| 4 | #7, #8 | `feat(web): task schedule picker and auto-queue-mode toggle` |
| 5 | #9, #10 | `test,docs: scheduler coverage and documentation updates` |

## Verification

- `npm run lint` — 0 errors, 0 warnings in PR scope
- `npm run build` — all packages
- `npm test` with coverage ≥70% per package
- `npm run ai:validate`
- `docker compose build`
- Mandatory `/aif-docs` checkpoint before completion
- Do NOT push until user confirms local testing
