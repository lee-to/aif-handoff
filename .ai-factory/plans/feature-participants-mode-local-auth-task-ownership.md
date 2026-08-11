# Implementation Plan: Participants Mode with Local Authentication and Human/AI Task Ownership

Branch: feature/participants-mode-local-auth-task-ownership
Created: 2026-07-24
Source: https://github.com/lee-to/aif-handoff/issues/159

## Original Request

https://github.com/lee-to/aif-handoff/issues/159 tests docs

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: "Skipped by user; the current roadmap contains no active unchecked milestone for Participants Mode."

## Scope

Add an off-by-default Participants Mode that lets one instance coordinate authenticated human participants and AI executors on the same board. The implementation must provide local accounts, secure sessions, explicit task execution ownership, multi-assignee human tasks, concurrency-safe AI/human handoffs, immutable executor history, authenticated actor attribution, role-aware UI, and filters/notifications for shared work.

When Participants Mode is disabled, the current anonymous single-user behavior, API contracts, WebSocket behavior, and AI-owned task lifecycle must remain compatible.

### Non-goals

- External identity providers, SSO, or OAuth for participant accounts.
- Public self-registration.
- Project membership, organization tenancy, or fine-grained enterprise RBAC.
- Replacing or sharing credentials with runtime-provider authentication.
- A general-purpose team chat system or automated evaluation of human work.

## Architecture and Security Decisions

### Identity and authorization

- Add `PARTICIPANTS_MODE_ENABLED=false` as the default. The authenticated application shell, REST authorization, CSRF checks, and WebSocket authentication activate only when it is enabled.
- Keep `/health`, the login/session capability endpoints, static login assets, and token-authenticated internal broadcasts available as narrowly scoped exceptions. All board, task, project, settings, chat, attachment, and runtime-profile REST routes require an active participant session when the mode is enabled.
- Roles are `admin` and `member`. All active participants can view the shared instance. Admins manage accounts and configuration and may act on any task. Members may create/comment, self-assign an unassigned human task, and act on or hand off human tasks assigned to them. Project-level membership remains out of scope.
- Prevent deactivation or demotion of the final active admin. Deactivation revokes all sessions and audibly removes that participant from current assignments while preserving historical snapshots.
- Participant credentials, runtime-provider credentials, internal broadcast credentials, and MCP transport credentials remain separate.

### Credential and session security

- Hash passwords with asynchronous `node:crypto.scrypt`, a unique random salt, versioned parameters, and constant-time verification. Avoid a new native dependency.
- Generate opaque 256-bit session and CSRF tokens. Store only digests in SQLite; place only the opaque session token in an expiring `HttpOnly`, `SameSite=Lax`, path-scoped cookie, with `Secure` enabled for HTTPS/production.
- Use a session-bound synchronizer CSRF token returned by the session endpoint and require `X-CSRF-Token` plus same-origin validation for unsafe participant-authenticated requests.
- Apply a login-specific rate limiter and a dummy password verification path for unknown/inactive usernames to reduce timing and enumeration signals.
- Never log passwords, password hashes, raw session/CSRF tokens, cookies, bootstrap secrets, or runtime-provider secrets.
- Bootstrap the first administrator through a non-interactive command that reads the password from a file or stdin, refuses unsafe argument-based secret input, and is idempotent/refuses once an account already exists.

### Ownership model

- Add `executionOwner: "ai" | "human"` independently of `autoMode`. `executionOwner` selects the current executor; `autoMode` continues to control existing AI workflow approval gates.
- Existing tasks and all compatibility-mode creates default to `ai`.
- Human tasks may have multiple active participant assignees or remain visibly unassigned, but an unassigned member cannot advance the task until they self-assign or an admin assigns them.
- Ownership changes use a dedicated `@aif/data` transaction with an `ownershipRevision`, expected owner/status checks, active-assignee validation, and a no-live-lock condition. Generic task updates must not mutate ownership or assignments.
- If an AI lease wins the race, handoff returns structured `409 task_locked`; if handoff wins, every AI claim/CAS fails its `execution_owner='ai'` condition.
- Preserve plan, implementation/review logs, comments, attachments, session metadata, branch/worktree metadata, and task artifacts across handoffs.
- Executor history and general audit records are append-only and retain task/participant display snapshots after participant rename, deactivation, or task deletion.

### Stage and handoff policy

| Current stage | AI → Human | Human → AI | Explicit human action |
| --- | --- | --- | --- |
| `backlog` | Preserve stage | Normalize to `planning`, then wake the coordinator | Start work → `planning` |
| `planning` / `improve` | Preserve stage | Preserve stage and wake | Mark plan ready → `plan_ready` |
| `plan_ready` | Preserve stage | Preserve and wake when `autoMode=true`; otherwise require explicit start-implementation action | Start implementation → `implementing` |
| `implementing` | Preserve stage | Preserve stage and wake | Submit work → `review`, `verify`, or `done` according to review/verify settings |
| `review` | Preserve stage | Preserve stage and wake | Request changes → `implementing`; complete → `verify` or `done` |
| `verify` | Preserve stage | Preserve stage and wake | Fail → `implementing`; pass → `review` or `done` according to policy |
| `blocked_external` | Preserve stage | Require explicit `retry_from_blocked` normalization | Retry to `blockedFromStatus` |
| `done` | Preserve stage | No implicit automation restart | Approve → `verified`; request changes → `implementing` |
| `verified` | Reject executor changes | Reject executor changes | Terminal |

- AI → Human preserves the current stage and is rejected while an unexpired AI lock exists.
- Runtime-backed helper actions such as fast-fix, AI-generated commit, and QA are rejected for human-owned tasks with a structured `ai_handoff_required` response unless the task is explicitly handed to AI first.
- Auto-review convergence that requires human intervention creates a system-authored AI → Human handoff, potentially unassigned, instead of only setting `manualReviewRequired`.
- Human tasks do not consume AI concurrency or runtime budgets. Shared-worktree collision protection remains a separate filesystem-safety gate; isolated worktrees should allow unrelated AI work to continue.

## Commit Plan

- **Commit 1** (after tasks 1-3): `feat(data): add participant identity and task ownership model`
- **Commit 2** (after tasks 4-5): `feat(agent): enforce owner-aware workflow transitions`
- **Commit 3** (after tasks 6-9): `feat(api): secure participants mode and collaboration contracts`
- **Commit 4** (after tasks 10-12): `feat(web): add participant collaboration experience`
- **Commit 5** (after tasks 13-14): `test(docs): verify and document participants mode`

## Tasks

### Phase 1: Persistent Identity and Ownership Foundation

- [x] **Task 1: Add shared participant, ownership, history, audit, and session contracts**

  **Deliverable:** Extend the browser-safe shared contracts and SQLite schema with the complete Participants Mode data model.

  **Files:** `packages/shared/src/schema.ts`, `packages/shared/src/db.ts`, `packages/shared/src/types.ts`, `packages/shared/src/browser.ts`, `packages/shared/src/__tests__/db.test.ts`, related shared type tests.

  **Implementation details:**
  - Add `participants`, `participant_sessions`, `task_assignments`, `task_executor_history`, and `audit_events`.
  - Add `tasks.execution_owner NOT NULL DEFAULT 'ai'`, `tasks.ownership_revision NOT NULL DEFAULT 0`, and nullable `task_comments.participant_id`.
  - Store stable task-title, participant display-name, owner, assignee, stage, actor, reason, and timestamp snapshots in append-only history/audit rows.
  - Append migration **v27** and update fresh-database DDL/index creation; never edit or renumber v1-v26.
  - Backfill existing tasks to AI ownership and create a system-authored initial executor-history record.
  - Add typed DTOs for participants, auth/session state, owner/assignee summaries, executor history, audit actors, task permissions, and new WebSocket payloads without importing Node-only code from `browser.ts`.

  **Tests:** Cover fresh DB creation, upgrade from a v26-shaped DB, AI-default backfill, history backfill, unique normalized usernames, indexes, append-only enforcement, and browser-safe exports.

  **Logging:** Log migration version and aggregate backfill counts at DEBUG/INFO; never log password/session/CSRF columns or full audit payloads.

  **Dependencies:** None.

- [x] **Task 2: Implement participant credentials, sessions, administration invariants, and audit repositories**

  **Deliverable:** Add cohesive `@aif/data` repository services for participants, password verification, session lifecycle, and immutable audit writes.

  **Files:** `packages/data/src/index.ts`, new focused internal modules such as `packages/data/src/participants.ts`, `packages/data/src/authSessions.ts`, and `packages/data/src/audit.ts`, plus `packages/data/src/__tests__/*`.

  **Implementation details:**
  - Implement versioned `scrypt` hash/verify helpers using random salts and constant-time comparison.
  - Create random opaque sessions, persist only token/CSRF digests, resolve active sessions, expire/revoke sessions, and revoke all sessions after password reset or deactivation.
  - Implement create/list/update/deactivate/reset participant operations, normalized username lookup, and final-active-admin protection.
  - On deactivation, transactionally revoke sessions and remove the participant from current task assignments while adding executor-history and audit entries.
  - Expose repository intents through `@aif/data`; do not expose Drizzle primitives or permit API/MCP callers to construct SQL.

  **Tests:** Cover hash versioning, wrong-password and dummy-verification paths, expiry, revocation, reset/deactivation invalidation, duplicate usernames, inactive accounts, final-admin protection, and missing-row/conflict cases.

  **Logging:** DEBUG for repository lifecycle and participant IDs, INFO for successful administrative actions, WARN for rejected/invariant-violating actions, and ERROR for persistence failures; never log credential or token material.

  **Dependencies:** Task 1.

- [x] **Task 3: Build assignment hydration and the atomic ownership/handoff repository**

  **Deliverable:** Add a single transactional data-layer path for task assignment, reassignment, and AI/Human handoff, plus efficient owner/assignee reads and filters.

  **Files:** `packages/data/src/index.ts`, new `packages/data/src/taskOwnership.ts` or equivalent, `packages/data/src/__tests__/index.test.ts`, new ownership-focused tests, `packages/shared/src/types.ts`.

  **Implementation details:**
  - Add batch owner/assignee hydration to full task, task-list, summary, paginated search, and comment response mappers without N+1 queries.
  - Add owner, assignee, current-participant, and unassigned filters.
  - Implement `handoffTaskExecution()` as a SQLite transaction that validates active assignees, expected revision/owner/status, and expired/unset locks; replaces current assignments; increments the revision; appends executor history and audit; and returns structured outcomes (`not_found`, `locked`, `revision_conflict`, `inactive_assignee`, `invalid_transition`).
  - Keep ownership out of generic `updateTask()` / `setTaskFields()` mutation paths.
  - Retain history/audit snapshots after participant/task removal, while current assignments follow task lifecycle cleanup.

  **Tests:** Cover AI↔Human, Human↔Human, multi-assignee, unassigned, inactive-assignee, stale revision, live/expired lock, concurrent claim-vs-handoff, ordered immutable history, filters, and deletion/rename snapshot retention.

  **Logging:** DEBUG expected/actual owner revision and lock state, INFO successful assignment/handoff IDs and stages, WARN structured conflicts, and ERROR transaction failures; use IDs/counts rather than sensitive task content.

  **Dependencies:** Tasks 1-2.

### Phase 2: State Machine and Automation Safety

- [x] **Task 4: Make task transitions actor-aware and atomically auditable**

  **Deliverable:** Expand the shared state machine and data services so anonymous legacy actions, participant manual actions, automated transitions, and handoff normalization follow one explicit policy.

  **Files:** `packages/shared/src/stateMachine.ts`, `packages/shared/src/types.ts`, `packages/shared/src/__tests__/stateMachine.test.ts`, `packages/data/src/index.ts`, `packages/api/src/services/taskEvents.ts`, related API/data tests.

  **Implementation details:**
  - Replace the ambiguous human-initiated-only model with pure owner/actor-aware allowed-action and transition resolvers while preserving disabled-mode legacy behavior.
  - Add explicit actions for starting human work, marking a plan ready, submitting implementation, completing/requesting changes from review, passing/failing verification, retrying blocked work, and terminal approval.
  - Apply the stage matrix above, including `skipReview` / `runPostVerify` behavior and explicit normalization for Human → AI handoff.
  - Centralize status mutations in an `@aif/data` transaction that writes the task change and immutable audit event together; update API, agent, watchdog, auto-queue, and MCP callers to identify participant/agent/system actors.
  - Return server-derived permitted actions/permissions so the UI does not duplicate authorization logic.

  **Tests:** Exhaust the owner × stage × actor/role matrix, legacy disabled mode, review/verify flags, blocked retry, terminal behavior, unauthorized actors, and atomic audit rollback.

  **Logging:** DEBUG transition evaluation, INFO accepted transitions with actor kind/ID and from/to stage, WARN denied actions with structured codes, and ERROR transactional failures; never log plans/comments.

  **Dependencies:** Tasks 1 and 3.

- [x] **Task 5: Exclude human-owned tasks from every AI execution, budget, scheduler, auto-queue, and watchdog path**

  **Deliverable:** Enforce AI ownership in both selection and atomic writes so human tasks can never start or be mutated by background automation.

  **Files:** `packages/data/src/index.ts`, `packages/agent/src/coordinator.ts`, `packages/agent/src/taskWatchdog.ts`, `packages/agent/src/autoReviewHandler.ts`, `packages/agent/src/notifier.ts`, relevant agent/data tests.

  **Implementation details:**
  - Add `execution_owner='ai'` to coordinator stage filters, actionable-project discovery, `claimTask`, `claimCoordinatorTaskIfEligible`, runtime-limit blocking CAS, scheduled-task CAS, backlog auto-advance, due-blocked recovery, stale-task discovery, and active-pipeline counts.
  - Make auto-queue skip human backlog tasks and ignore human tasks for runtime concurrency/budget/commit-gate capacity, while preserving explicit shared-worktree collision safety.
  - Add a defensive AI-owner assertion immediately before runtime execution and revalidate after semaphore waits.
  - Ensure human tasks are absent from `/agent/status`, stale retry/quarantine, scheduler firing, and runtime-limit resolution.
  - Convert auto-review manual handoff into the same system-authored transaction/history/notification path and include latest handoff responsibility in subsequent AI prompts without copying secrets.
  - Reject fast-fix, commit generation, and QA runtime helpers on human-owned tasks unless an explicit AI handoff occurs first.

  **Tests:** Cover every pipeline stage, owner flip while waiting on a permit, pre-claim runtime-gate race, scheduler, auto-queue pool counts, commit gate, watchdog, stale claims, runtime-budget non-consumption, auto-review handoff, and exception-safe permit/claim cleanup.

  **Logging:** DEBUG owner eligibility and skipped human candidates, INFO system handoffs, WARN defensive owner mismatches/race losses, and ERROR unexpected execution-boundary violations; never emit task bodies or runtime credentials.

  **Dependencies:** Tasks 3-4.

### Phase 3: Authenticated API, WebSocket, and MCP Contracts

- [x] **Task 6: Add Participants Mode configuration, session authentication, CSRF, CORS, and RBAC middleware**

  **Deliverable:** Secure the REST application with off-by-default participant authentication while preserving anonymous compatibility.

  **Files:** `packages/shared/src/env.ts`, `packages/api/src/index.ts`, `packages/api/src/schemas.ts`, new `packages/api/src/routes/auth.ts`, new `packages/api/src/middleware/participantAuth.ts` / `csrf.ts` / `requireRole.ts`, `packages/api/src/middleware/rateLimit.ts`, API tests.

  **Implementation details:**
  - Add validated environment settings for feature enablement, session TTL/cookie behavior, login rate limits, and exact allowed origins.
  - Add session context middleware and `GET /auth/session`, `POST /auth/login`, and `POST /auth/logout`.
  - Require session-bound CSRF and Origin/Host checks for unsafe cookie-authenticated requests.
  - Apply admin/member route guards, including admin-only project/global/runtime configuration and destructive actions; keep internal broadcast token auth as a separate bypass.
  - Configure credentialed CORS only for exact origins; reject wildcard origin when Participants Mode is enabled.
  - In disabled mode, bypass participant auth/CSRF/RBAC and keep legacy anonymous comments/actions with `participantId=null`.

  **Tests:** Cover enabled/disabled mode, login success/failure timing path, inactive/expired/reset sessions, cookie flags, CSRF, exact-origin CORS, route role matrix, internal broadcast isolation, and consistent 401/403/409 structured errors.

  **Logging:** DEBUG session resolution by participant/session IDs, INFO login/logout, WARN failed login/rate limit/CSRF/authorization, and ERROR auth-store failures; never log usernames with secrets, request bodies, cookies, hashes, or raw tokens.

  **Dependencies:** Tasks 1-2.

- [x] **Task 7: Add participant administration APIs and secure first-admin bootstrap**

  **Deliverable:** Let administrators manage local participants without public registration and bootstrap the first admin safely in native and Docker deployments.

  **Files:** new `packages/api/src/routes/participants.ts`, `packages/api/src/schemas.ts`, `packages/api/src/index.ts`, new bootstrap script under `packages/api/src/scripts/`, `packages/api/package.json`, root `package.json`, API/data tests.

  **Implementation details:**
  - Add list/create/update-role/deactivate/reset-password endpoints with admin guards and active/inactive views.
  - Require the admin to supply a new password on create/reset; never return stored credential material or persist plaintext in caches.
  - Broadcast participant and assignment changes after successful transactions.
  - Add an idempotent first-admin bootstrap command that accepts username/display name and reads the password from a protected file or stdin; refuse public registration and unsafe argument-based passwords.
  - Ensure deactivation, demotion, and reset use the Task 2 invariants and session invalidation transaction.

  **Tests:** Cover happy/error paths for every endpoint, member denial, final-admin protection, reset/deactivation session invalidation, assignment cleanup, bootstrap first-run/refusal/idempotency, and output/log redaction.

  **Logging:** INFO administrative action type and participant IDs, DEBUG validation/control flow, WARN denied/final-admin/bootstrap conflicts, and ERROR persistence failures; never log password inputs or generated hashes.

  **Dependencies:** Tasks 2 and 6.

- [x] **Task 8: Add task ownership, handoff, actor, history, and authenticated WebSocket APIs**

  **Deliverable:** Expose complete collaboration contracts through REST and both WebSocket transports.

  **Files:** `packages/api/src/routes/tasks.ts`, `packages/api/src/schemas.ts`, `packages/api/src/services/taskEvents.ts`, `packages/api/src/ws.ts`, `packages/api/src/legacyWebSocket.ts`, `packages/api/src/serverBootstrap.ts`, `packages/shared/src/types.ts`, API integration tests.

  **Implementation details:**
  - Accept owner/assignees on task create; keep ownership changes out of generic update schemas.
  - Add `POST /tasks/:id/handoff` and `GET /tasks/:id/executor-history`, including revision, optional reason, explicit resume action, task permissions, active-assignee validation, and structured conflict responses.
  - Attribute comments and user-triggered task events to the authenticated participant while retaining `author: "human"`.
  - Return owner/assignees/permissions from list/detail APIs and add owner/assignee/unassigned query filters.
  - Authenticate the cookie and validate Origin during both legacy and node-server-v2 WebSocket upgrades; associate sockets with participant IDs and terminate/deny expired or deactivated sessions.
  - Add backward-compatible assignment/handoff/participant/comment event payloads with initiating actor and responsible participant summaries.

  **Tests:** Add route happy/error cases, RBAC/assignment authorization, lock/revision conflicts, actor attribution, filter contracts, dual WebSocket transport authorization/rejection/session invalidation, and backward-compatible payload fields.

  **Logging:** DEBUG handshake/route decisions and IDs, INFO successful handoffs/comments/broadcast counts, WARN rejected upgrades or ownership conflicts, and ERROR transport/transaction failures; never log cookies, CSRF values, reasons containing secrets, or comment bodies.

  **Dependencies:** Tasks 3-4 and 6-7.

- [x] **Task 9: Keep MCP task contracts secure and ownership-aware**

  **Deliverable:** Prevent MCP HTTP from bypassing Participants Mode security while keeping trusted stdio and agent-attributed task operations compatible.

  **Files:** `packages/mcp/src/env.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/tools/createTask.ts`, `updateTask.ts`, `getTask.ts`, `listTasks.ts`, `searchTasks.ts`, `syncStatus.ts`, optional dedicated handoff tool, `packages/mcp/src/utils/compactResponse.ts`, MCP tests.

  **Implementation details:**
  - Require a separate bearer `MCP_AUTH_TOKEN` for HTTP transport when Participants Mode is enabled, or fail startup; keep local stdio explicitly trusted.
  - Default MCP-created tasks to AI ownership and expose owner/assignee fields and list/search filters.
  - Do not let generic MCP updates impersonate participants or mutate ownership. If MCP handoff support is added, route it through the same transactional service with actor kind `agent`.
  - Attribute MCP status changes to the agent actor and preserve the shared status-audit contract.
  - Update field allowlists, compact responses, rate limits, tool schemas, and broadcasts without exposing participant credentials/session fields.

  **Tests:** Cover HTTP token required/invalid/valid behavior, stdio trust, AI create defaults, read/filter contracts, prohibited generic ownership mutation, agent-attributed status/handoff audit, and payload redaction.

  **Logging:** DEBUG tool/transport decisions, INFO agent-attributed mutation IDs, WARN missing/invalid transport auth, and ERROR tool failures; never log bearer tokens, participant session data, or task content.

  **Dependencies:** Tasks 1-4 and 6.

### Phase 4: Participant and Ownership User Experience

- [x] **Task 10: Build the authenticated web shell, login flow, participant menu, and admin management UI**

  **Deliverable:** Gate the application before authenticated queries/WebSocket startup and provide login/logout/current-user/admin participant experiences.

  **Files:** `aif-handoff-ui-kit.lib.pen`, `packages/web/src/App.tsx`, `packages/web/src/lib/api.ts`, new `packages/web/src/hooks/useAuth.ts` / `useParticipants.ts`, `packages/web/src/hooks/useWebSocket.ts`, `packages/web/src/components/layout/Header.tsx`, new domain components under `packages/web/src/components/auth/` and `components/participants/`, `packages/web/vite.config.ts`, web tests.

  **Implementation details:**
  - Before coding new visual components, sync login, identity menu, and participant-management representations through Pencil `get_guidelines` and `batch_design`.
  - Centralize `credentials`, CSRF acquisition/refresh, 401 handling, and secret-free request logging in `lib/api.ts`.
  - Mount React Query consumers and WebSocket only after session capability/auth bootstrap; disabled mode falls through to the existing app.
  - Add login/logout, current display name/role, auth-expiry recovery, and admin-only participant create/deactivate/reset flows with existing `Card`, `Input`, `Button`, `Dialog/FormDialog`, `ConfirmDialog`, `Avatar`, `Badge`, `Select`, and table primitives.
  - Hide member-ineligible configuration controls in Header, ProjectSelector, global/runtime settings, and Codex provider login while keeping the API authoritative.
  - Stop WebSocket reconnect loops on authentication failure and resume only after a valid session.

  **Tests:** Cover enabled/disabled auth gates, login/logout/errors, CSRF retry/session expiry, role-aware navigation, participant administration, password-field clearing, WebSocket lifecycle, and no secret-bearing console/API calls.

  **Logging:** Browser DEBUG for auth state transitions and participant IDs only, INFO login/logout UI completion, WARN recoverable session failures, and ERROR unexpected transport failures; never log form values, CSRF/session tokens, or cookies.

  **Dependencies:** Tasks 6-8.

- [x] **Task 11: Add owner, assignee, handoff, and manual-transition controls to task creation and details**

  **Deliverable:** Let users choose AI/Human ownership, assign active participants, perform safe handoffs at supported stages, and see responsibility throughout task UI.

  **Files:** `aif-handoff-ui-kit.lib.pen`, `packages/web/src/components/kanban/AddTaskForm.tsx`, `TaskCard.tsx`, `TaskListTable.tsx`, `Column.tsx`, `packages/web/src/components/task/TaskDetail.tsx`, `TaskDetailHeader.tsx`, `TaskSettings.tsx`, `useTaskDetailActions.ts`, new ownership domain components, hooks/API client, web tests.

  **Implementation details:**
  - Sync owner badges, multi-assignee selection, handoff dialog, manual-action controls, and error states in Pencil before adding components.
  - Compose existing primitives; implement multi-assignee selection as a domain checkbox/list composition rather than a new generic UI primitive unless Pencil is updated for that primitive.
  - Keep `autoMode` visibly separate from execution owner and replace misleading `AI/MANUAL` labels or static column “owner” badges.
  - Render owner and assignees on cards, list rows, task header, and settings; keep inactive historical participants distinguishable.
  - Submit expected ownership revision, target owner/assignees, optional reason, and explicit resume action; surface structured lock/revision/inactive-assignee conflicts.
  - Render only server-permitted manual actions and enforce assignment/admin eligibility in the UI.
  - Follow theme-pairing rules, verify light/dark/focus/disabled states, and add no expensive CSS properties.

  **Tests:** Cover create defaults/validation, AI vs Human, multi-assignee/unassigned, all stage actions, handoff conflict recovery, role/assignment permissions, autoMode separation, card/list/detail parity, and light/dark semantic class expectations.

  **Logging:** DEBUG owner/action mutation lifecycle with task/participant IDs, INFO successful handoffs/actions, WARN structured conflicts, and ERROR unexpected API failures; never log handoff reason text or task content.

  **Dependencies:** Tasks 8 and 10.

- [x] **Task 12: Add ownership filters, participant-aware comments, executor timeline, and assignment notifications**

  **Deliverable:** Complete the shared-board collaboration experience with accountable identity, history, filtering, and real-time updates.

  **Files:** `aif-handoff-ui-kit.lib.pen`, `packages/web/src/components/kanban/Board.tsx`, `FilterBar.tsx`, `packages/web/src/components/task/TaskComments.tsx`, new `ExecutorTimeline.tsx`, `packages/web/src/hooks/useWebSocket.ts`, `packages/web/src/lib/notifications.ts`, shared/web fixtures and tests.

  **Implementation details:**
  - Make **My tasks** use the authenticated participant assignment rather than `autoMode`; add **Human-owned**, **AI-owned**, and **Unassigned** filters to both Kanban and list views.
  - Display participant identity on human comments while retaining Human/Agent actor badges.
  - Build a structured chronological executor-history timeline; do not derive it from mutable agent activity logs.
  - Invalidate auth/participant/task/history queries for new WebSocket events and show notifications containing the task, assignment change, and responsible participant where applicable.
  - Sync the executor timeline and notification/empty states in Pencil and compose existing timeline/card/avatar/badge primitives.

  **Tests:** Cover filter combinations, current-user changes, comment identity/inactive participants, immutable timeline ordering/snapshots, WebSocket invalidation, session deactivation, and assignment-aware desktop/sound notification behavior.

  **Logging:** DEBUG filter/event/invalidation decisions and IDs, INFO user-visible assignment notifications, WARN malformed events, and ERROR notification failures; never log comment/reason bodies or credentials.

  **Dependencies:** Tasks 8 and 10-11.

### Phase 5: Cross-Package Verification and Documentation

- [x] **Task 13: Add the complete security, compatibility, concurrency, and UI regression suite**

  **Deliverable:** Prove the issue acceptance criteria across shared, data, API, agent, MCP, and web packages and preserve at least 70% coverage per package.

  **Files:** `packages/shared/src/__tests__/*`, `packages/data/src/__tests__/*`, `packages/api/src/__tests__/*`, `packages/agent/src/__tests__/*`, `packages/mcp/src/__tests__/*`, `packages/web/src/__tests__/*`, a deterministic isolated Participants Mode browser/E2E spec, relevant Vitest/Playwright coverage config.

  **Implementation details:**
  - Add an isolated temp-DB integration harness with deterministic admin bootstrap; never use or mutate the developer database.
  - Cover disabled-mode anonymous compatibility, migration/backfill, login/CSRF/session/WS security, RBAC, admin lifecycle, actor attribution, ownership/assignment/history, every manual transition, all AI exclusion queries/CAS races, handoff while waiting for a permit, runtime-budget non-consumption, MCP transport auth, and UI end-to-end handoff/filter/history flows.
  - Add new components/hooks to honest coverage instrumentation instead of excluding them.
  - Add negative assertions that logs/responses never contain passwords, hashes, raw tokens, cookies, or provider credentials.
  - Run every affected package checklist, lint, unit/integration tests, coverage, and focused browser tests before the final project gate.

  **Tests:** This task owns the cross-package matrix and must leave every touched package at or above 70% measured coverage.

  **Logging:** Capture and assert DEBUG/INFO/WARN/ERROR behavior in tests, including redaction and structured conflict codes; test fixtures must use synthetic secrets and must not print them.

  **Dependencies:** Tasks 1-12.

- [x] **Task 14: Complete the mandatory documentation/configuration checkpoint and final validation**

  **Deliverable:** Document operation, security, API contracts, architecture, deployment, and recovery, then pass the repository validation gate.

  **Files:** `.env.example`, `README.md`, `docs/getting-started.md`, `docs/configuration.md`, `docs/api.md`, `docs/architecture.md`, relevant MCP/provider documentation, `.docker/angie*.conf` and Compose files only if proxy/env verification requires changes, `AGENTS.md` if the project map changes.

  **Implementation details:**
  - Route documentation changes through `$aif-docs` as the mandatory completion checkpoint.
  - Document off-by-default behavior, exact-origin/CORS requirements, cookie/CSRF/session settings, login rate limits, native and Docker first-admin bootstrap, reset/deactivation recovery, role policy, owner-vs-autoMode semantics, stage/handoff matrix, workspace-safety caveat, and credential/logging separation.
  - Document all REST fields/endpoints/error codes, MCP token behavior, WebSocket authentication/events, audit/history semantics, and disabled-mode compatibility.
  - Verify Angie forwards the cookie, `Origin`, host, client address, and HTTPS scheme needed for secure-cookie/origin checks; avoid Dockerfile changes unless a real dependency requires them.
  - Run the root and every affected package `CHECKLIST.md`; note non-applicable items in the handoff.
  - Run `npm run ai:validate` after all implementation, tests, Pencil sync, and docs are complete.

  **Tests:** Validate documented commands against an isolated database, check links/examples/config names, rerun targeted security smoke tests, and require `npm run ai:validate` to pass.

  **Logging:** Documentation must describe verbose but redacted logging and production log-level controls; validation output may include IDs/counts but no real credentials or task content.

  **Dependencies:** Tasks 5-13.

## Acceptance Gates

- Participants Mode is disabled by default and legacy anonymous behavior remains functional.
- First-admin bootstrap, login/logout, participant administration, session invalidation, CSRF, rate limiting, REST auth, WebSocket auth, and MCP HTTP auth are verified.
- Existing tasks migrate to AI ownership; AI-owned tasks keep the existing lifecycle.
- Human tasks never enter coordinator/scheduler/auto-queue/watchdog/runtime-budget paths.
- Multi-assignee Human tasks, repeated AI↔Human handoffs, actor attribution, immutable history/audit, manual transitions, UI ownership, filters, comments, and notifications work end to end.
- New visual components are represented in `aif-handoff-ui-kit.lib.pen`, reuse existing primitives, obey theme pairing, and add no expensive CSS.
- API, WebSocket, MCP, shared contracts, data layer, agent, web UI, configuration, and documentation remain synchronized.
- Every affected package meets the 70% coverage rule and `npm run ai:validate` passes.
