# Implementation Plan: GitHub Issue-to-PR Mode

Branch: feature/github-issue-pr-mode
Created: 2026-08-08

## Original Request

https://github.com/lee-to/aif-handoff/issues/154 реализуй

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: The current roadmap has no GitHub integration milestone.

## Commit Plan

- **Commit 1** (after tasks 1-3): "feat: add GitHub repository and issue synchronization"
- **Commit 2** (after tasks 4-6): "feat: complete GitHub issue-to-PR workflow"

## Tasks

### Phase 1: Persistent GitHub source-of-truth model

- [x] Task 1: Add append-only migration v28, Drizzle schema, and shared browser-safe contracts for one GitHub repository connection per project and idempotent issue/PR linkage. Store only an environment-variable name for credentials, never a token. Log migration/bootstrap state at existing DB log levels. Files: `packages/shared/src/schema.ts`, `packages/shared/src/db.ts`, `packages/shared/src/types.ts`, public exports, and focused schema tests.
- [x] Task 2: Add cohesive `@aif/data` repository operations for repository configuration, atomic issue import/deduplication, issue snapshot refresh, PR linkage, sync errors, and human-decision/revision state. Log repository sync mutations at DEBUG/INFO and structured failures at ERROR without secrets. Files: `packages/data/src/github.ts`, `packages/data/src/index.ts`, and focused data tests. (depends on 1)

### Phase 2: GitHub REST orchestration

- [x] Task 3: Implement native-fetch GitHub REST client and validated project endpoints to connect/disconnect, list state, synchronize eligible issues, and create/update the linked PR and review feedback idempotently. Handle 401/403, rate limits, closed issues/PRs, review changes, and CI state using structured HTTP fields. Log external calls without authorization headers. Files: `packages/api/src/services/github.ts`, `packages/api/src/routes/github.ts`, `packages/api/src/schemas.ts`, route registration, and API tests. (depends on 2)
<!-- Commit checkpoint: tasks 1-3 -->

### Phase 3: Autonomous terminal workflow

- [x] Task 4: Reuse the existing task branch/worktree and commit gate, push the persisted issue branch, request PR publication through the internal API, publish automated review output once per revision, and use Done as the terminal PR-ready state without merging. Poll configured repositories for issue/PR changes and resume the same task/PR when GitHub requests changes; only a merged PR advances to Verified. Log branch, PR, and handoff state transitions without credentials. Files: `packages/agent/src/githubWorkflow.ts`, `packages/agent/src/notifier.ts`, `packages/agent/src/coordinator.ts`, and agent tests. (depends on 3)

### Phase 4: UI, documentation, and validation

- [x] Task 5: Extend existing project edit/settings and task detail components with repository connection, eligibility filters, manual sync, connection status, and issue/PR links. Reuse existing UI primitives, API client, and query hooks; add no new visual primitive. Log client mutation outcomes through existing diagnostics. Files: existing files under `packages/web/src/components/project/`, `packages/web/src/components/task/`, `packages/web/src/hooks/`, `packages/web/src/lib/api.ts`, and web tests. (depends on 3)
- [x] Task 6: Document GitHub authentication permissions, configuration, API contracts, workflow behavior, recovery semantics, and the explicit no-auto-merge guarantee; run every touched package checklist, coverage, and `npm run ai:validate`. Files: `README.md`, `docs/configuration.md`, `docs/api.md`, `docs/architecture.md`, and package checklists as applicable. (depends on 4, 5)
<!-- Commit checkpoint: tasks 4-6 -->
