# Runtime Session Fork Warmup Plan

Created: 2026-04-30
Branch: `feature/runtime-session-fork-warmup`

## Settings

- **Testing:** yes
- **Logging:** verbose
- **Docs:** yes

## Roadmap Linkage

- **Milestone:** none
- **Rationale:** The current roadmap has no open unchecked milestone. This plan is scoped to the requested runtime warmup feature.

## Goal

Add a feature-flagged Warmup flow that creates a reusable, time-limited agent seed session for a project. Future planner-stage task runs can fork that warm session instead of starting from a cold context, reducing startup latency and repeated context tokens.

Warmup must be runtime-aware:

- Claude supports session fork for SDK/CLI transports.
- Codex supports session fork for App Server transport first.
- Other transports and runtimes explicitly advertise no fork support so the product never tries to warm or fork them.

## Key Design Decisions

- Add fork support as a runtime capability, not as UI-only logic.
- Model fork as a combined runtime operation (`forkSession` / fork-and-run) because Claude can fork while resuming with a prompt, while Codex App Server forks a thread first and then starts a turn on the fork.
- Never resume the warmup seed session directly for a task. Always fork it and store the forked child session on the task.
- Default use is planner stage only. Implementation/review stages continue using the existing task session behavior unless a later feature expands the policy.
- Gate the entire product surface behind `AIF_WARMUP_ENABLED=false` by default.
- Even when `AIF_WARMUP_ENABLED=true`, show the Warmup UI only if the project's effective planner runtime/profile supports session fork. Unsupported planner runtimes should behave as if Warmup is unavailable for that project.

## Phase 1 - Runtime Fork Contract

### Task 1 - Extend runtime capabilities and adapter contract

- [x] Add `supportsSessionFork` to `RuntimeCapabilities` in `packages/runtime/src/types.ts`, defaulting to `false`.
- [x] Add a runtime-neutral fork input type, for example `RuntimeSessionForkInput extends RuntimeRunInput` with `sourceSessionId: string`.
- [x] Add optional adapter method `forkSession?(input: RuntimeSessionForkInput): Promise<RuntimeRunResult>`.
- [x] Add `WARMUP` to `UsageSource` so warmup runs are reported separately.
- [x] Update `packages/runtime/src/adapters/TEMPLATE.ts` to document the new capability and optional method.
- [x] Logging: when a caller requests fork support without a method/capability, log the runtime id, transport, source session id presence, and skip reason without logging prompt contents.
- [x] Tests: update runtime type/capability tests and adapter discovery tests so every built-in adapter declares `supportsSessionFork`.

Dependencies: none.

### Task 2 - Implement Claude fork support

- [x] In `packages/runtime/src/adapters/claude/index.ts`, set `supportsSessionFork: true` for SDK and CLI transports, and keep API transport `false`.
- [x] For SDK transport, pass `resume: sourceSessionId` and `forkSession: true` into Agent SDK query options.
- [x] For CLI transport, add `--resume <sourceSessionId>` plus `--fork-session` when using the fork path.
- [x] Keep normal `resume()` behavior unchanged.
- [x] Logging: add debug logs for fork start/success/failure with transport, runtime profile, source session id hash or suffix, and returned child session id; avoid logging prompt text.
- [x] Tests: cover SDK options, CLI argv construction, successful child session id extraction, and failure classification.

Dependencies: Task 1.

### Task 3 - Implement Codex App Server fork support

- [x] In `packages/runtime/src/adapters/codex/index.ts`, set `supportsSessionFork: true` only for `RuntimeTransport.APP_SERVER`.
- [x] Keep Codex CLI, SDK, and API transports `supportsSessionFork: false` until a non-interactive fork path is proven and tested.
- [x] Add `thread/fork` support to `packages/runtime/src/adapters/codex/appServer/protocol.ts` and `client.ts`, using the generated v2 protocol shape where possible.
- [x] Update `packages/runtime/src/adapters/codex/appServer/run.ts` so `forkSession` calls `thread/fork` with the warm source thread and then starts the turn on the forked thread.
- [x] Update the fake app-server fixture/tests if present so protocol coverage includes `thread/fork`.
- [x] Logging: log fork request/result with app-server endpoint, source thread id suffix, forked thread id, and structured error category on failure.
- [x] Tests: cover protocol serialization, client call, run flow ordering (`thread/fork` before `turn/start`), unsupported transport false paths, and usage reporting for warmup/forked planner runs.

Dependencies: Task 1.

### Task 4 - Runtime parity and provider docs

- [x] Audit all adapter directories under `packages/runtime/src/adapters/`.
- [x] Ensure OpenRouter and unsupported Claude/Codex transports explicitly keep `supportsSessionFork: false` and do not expose misleading fork behavior.
- [x] Update `docs/providers.md` supported-runtime tables with fork support notes by runtime/transport.
- [x] Logging: no new runtime logs required beyond Tasks 1-3, but ensure unsupported capability checks produce a clear skip reason.
- [x] Tests: update bootstrap/discovery tests that assert every adapter reports usage and capability metadata.

Dependencies: Tasks 1-3.

## Phase 2 - Warmup Persistence and API

### Task 5 - Add warmup feature flag and settings exposure

- [x] Add `AIF_WARMUP_ENABLED` to `packages/shared/src/env.ts`, defaulting to `false`.
- [x] Expose `warmupEnabled` from `packages/api/src/routes/settings.ts`.
- [x] Add `warmupEnabled` to `packages/web/src/lib/api.ts` settings response types and add a hook helper if useful.
- [x] Logging: log feature flag state once at API startup or settings construction at debug level.
- [x] Tests: cover env default, env true parsing, and settings response shape.

Dependencies: none.

### Task 6 - Add warmup session data model

- [x] Append a new migration in `packages/shared/src/db.ts`; do not edit or renumber existing migrations.
- [x] Add a `runtime_warmup_sessions` table in `packages/shared/src/schema.ts` with fields for project id, runtime profile id, runtime id/provider id/transport/model, source session id, status, ttl seconds, expires at, summary, error message, created/updated timestamps.
- [x] Add indexes for active lookup by project/runtime profile/runtime/model/expires.
- [x] Add repository functions in `packages/data/src/index.ts`: create, mark ready, mark failed, clear active, expire stale, and find active ready warmup.
- [x] Logging: repository callers log lifecycle events; repository functions should not log prompt/session details beyond ids needed for diagnosis.
- [x] Tests: cover active lookup, expiry behavior, replacing an existing warmup, and failed warmup persistence.

Dependencies: Task 5.

### Task 7 - Add API warmup endpoints

- [x] Add endpoints under the project API surface, for example:
  - `GET /projects/:id/warmup`
  - `POST /projects/:id/warmup`
  - `DELETE /projects/:id/warmup`
- [x] Add Zod schemas in `packages/api/src/schemas.ts`; validate TTL with a bounded range.
- [x] Resolve the effective planner runtime/profile using existing runtime resolution services.
- [x] On create, require `AIF_WARMUP_ENABLED`, `supportsSessionFork`, and an adapter capable of creating the seed session.
- [x] In the `GET /projects/:id/warmup` response, return enough support metadata for the UI to decide whether the project's current planner runtime can use Warmup. If unsupported, the UI should hide the Header entry point rather than show a disabled Warmup button.
- [x] Run the warmup prompt through the selected adapter with `UsageSource.WARMUP`; store the returned seed session id and expiry.
- [x] Return unsupported states cleanly so direct API callers and defensive UI paths can explain why Warmup is unavailable without failing late.
- [x] Logging: log request start, resolved runtime/profile, capability decision, warmup create success/failure, TTL, and expiry timestamp; never log prompt text or secrets.
- [x] Tests: cover disabled flag, unsupported runtime, successful warmup, TTL validation, delete, and project-not-found.

Dependencies: Tasks 1, 5, 6.

### Task 8 - Broadcast and document warmup API state

- [x] If project/task WebSocket events already have a suitable invalidation path, reuse it; otherwise add a narrow warmup update event.
- [x] Update shared event types if a new event is added.
- [x] Update `docs/api.md` with endpoint request/response examples.
- [x] Update `docs/configuration.md` with `AIF_WARMUP_ENABLED` and TTL behavior.
- [x] Logging: log warmup state broadcasts with project id and status only.
- [x] Tests: cover WebSocket event emission if a new event is introduced.

Dependencies: Task 7.

## Phase 3 - Planner Integration

### Task 9 - Use valid warmup sessions for planner-stage task runs

- [x] Update `packages/agent/src/subagentQuery.ts` or the nearest runtime execution boundary to check for active warmup only when:
  - feature flag is enabled,
  - workflow/stage is planner,
  - the task does not already have a persisted session id,
  - the resolved runtime/profile/model matches the warmup record,
  - the adapter supports `supportsSessionFork` and implements `forkSession`,
  - the warmup record is `ready` and not expired.
- [x] When all checks pass, call `adapter.forkSession` with the warmup seed session id and the normal planner prompt.
- [x] Persist the returned child session id on the task using the existing task session mechanism.
- [x] If any check fails, continue the existing cold-start path.
- [x] Logging: add structured skip reasons (`feature_disabled`, `not_planner`, `existing_task_session`, `expired`, `unsupported_runtime`, `missing_adapter_method`, `runtime_mismatch`) and success logs with child session id suffix.
- [x] Tests: cover fork path, every important skip reason, expired warmup, and that implementation/review stages do not use warmup by default.

Dependencies: Tasks 1-7.

## Phase 4 - Warmup UI

### Task 10 - Add Warmup dialog and client hooks

- [x] Add API client methods in `packages/web/src/lib/api.ts`.
- [x] Add a hook such as `useProjectWarmup(projectId)` with create/delete mutations and query invalidation.
- [x] The hook must expose whether the selected project's effective planner runtime supports Warmup, based on the API support metadata.
- [x] Add `packages/web/src/components/project/WarmupDialog.tsx` as a domain component composed from existing UI primitives (`Dialog`, `Button`, `Input`, `Badge`, status indicators, tooltip primitives).
- [x] Show effective runtime/profile/model, support status, current warmup status, remaining TTL, TTL input, create/regenerate action, and clear action.
- [x] Disable create controls when the feature flag is off or no project is selected.
- [x] Do not render the dialog trigger at all when the selected project's planner runtime does not support session fork.
- [x] Follow `docs/ui-theme-colors.md`; do not use `box-shadow`, `backdrop-filter`, blur, or other expensive CSS properties.
- [x] Sync the new dialog/header state with the Pencil design system before adding custom visual primitives. Prefer no new primitive if existing components are sufficient.
- [x] Logging: frontend should not log secrets or prompts; use mutation error notifications and console debug only if existing conventions use them.
- [x] Tests: cover rendering, hidden trigger for unsupported planner runtimes, TTL validation, create/delete mutation calls, and remaining lifetime display.

Dependencies: Tasks 5, 7, 8.

### Task 11 - Add Header Warmup entry point behind feature flag

- [x] Update `packages/web/src/components/layout/Header.tsx` to show a Warmup icon button only when `warmupEnabled` is true and a project is selected.
- [x] Additionally require the selected project's effective planner runtime to support Warmup before rendering the Warmup button.
- [x] Use a lucide icon such as `Flame` or `Zap`, matching existing header button style.
- [x] Wire the button to the Warmup dialog.
- [x] Add WebSocket invalidation if Task 8 introduced a warmup event.
- [x] Logging: no additional logging required; rely on API/mutation logs.
- [x] Tests: cover hidden-by-default behavior, hidden when the feature flag is enabled but the project's planner runtime is unsupported, visible when flag/project/support are present, and dialog open/close.

Dependencies: Task 10.

## Phase 5 - Checklists, Docs, and Validation

### Task 12 - Update package checklists and docs

- [x] Verify relevant `CHECKLIST.md` files are satisfied for `runtime`, `agent`, `api`, `web`, `shared`, and `data`.
- [x] Update `docs/providers.md`, `docs/api.md`, and `docs/configuration.md`.
- [x] Update README only if the feature needs a user-facing mention beyond configuration docs.
- [x] Logging: include a short implementation note in docs about where to inspect warmup lifecycle logs.
- [x] Tests: documentation changes do not require unit tests, but links and endpoint names must match implementation.

Dependencies: Tasks 1-11.

### Task 13 - Final validation

- [x] Run focused package tests for touched packages.
- [x] Run `npm run ai:validate`.
- [x] Verify the UI with the feature flag off and on:
  - off: no Warmup button,
  - on + unsupported runtime: no Warmup button is rendered,
  - on + supported runtime: create warmup, observe TTL, run a planner task, verify child session id is persisted.
- [x] Logging: inspect logs for warmup create, fork success, and skip reasons; verify no prompt contents or secrets are logged.
- [x] Tests: all focused tests and full validation must pass before merge.

Dependencies: Tasks 1-12.

## Commit Plan

1. Runtime contract and adapter capability metadata.
2. Claude and Codex App Server fork implementations with tests.
3. Warmup schema, data repository, feature flag, and API endpoints.
4. Planner integration using warmup fork sessions.
5. Web Warmup dialog/header entry point and Pencil sync.
6. Documentation, checklist updates, and final validation fixes.

## Risks and Mitigations

- **Codex transport ambiguity:** Codex CLI currently exposes resume but not a confirmed non-interactive fork command. Mitigate by enabling fork only for App Server transport, where generated protocol includes `thread/fork`.
- **Seed session mutation:** Resuming instead of forking would contaminate the warmup context. Mitigate with a separate adapter method and tests that assert fork behavior.
- **Runtime/profile drift:** A warm session created for one runtime/model may be invalid for another. Mitigate by storing and matching runtime id, provider id, transport, model, and runtime profile id.
- **Expired sessions:** TTL must be enforced both in API responses and agent execution. Mitigate with repository active lookup filtering and agent-side expiry checks.
- **Token accounting:** Warmup runs must not be hidden inside normal subagent usage. Mitigate with `UsageSource.WARMUP`.
- **UI availability:** Feature must be invisible by default. Mitigate with `AIF_WARMUP_ENABLED=false` and settings-driven rendering.
