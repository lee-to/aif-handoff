# Plan: Add Runtime and Provider Modularity

**Branch:** `feature/runtime-provider-modularity`
**Created:** 2026-04-03
**Type:** Feature + architectural refactor

## Settings

- **Testing:** Yes
- **Logging:** Verbose (DEBUG-level for all new runtime/profile flows)
- **Docs:** Yes (mandatory docs checkpoint at completion)

## Roadmap Linkage

- **Milestone:** "none"
- **Rationale:** The current roadmap has no open milestone for runtime/provider modularity, so this plan is intentionally scoped as a new architectural track without mutating roadmap artifacts during planning.

## Summary

Replace the current Claude-only execution path with a modular runtime/provider architecture that supports:

1. A shared runtime registry used by both `@aif/agent` and `@aif/api`
2. Persistent runtime profiles with project defaults and task/chat overrides
3. A runtime-independent workflow spec layer between orchestration and adapter execution
4. A compatibility-preserving `ClaudeRuntimeAdapter`
5. A first non-Claude adapter (`CodexRuntimeAdapter`) to validate the abstraction
6. A module contract for adding future runtimes/providers without editing core orchestration code

The key architectural move is to add a new workspace, `packages/runtime` (`@aif/runtime`), instead of hiding adapters inside `packages/agent`. Both `api` and `agent` currently call `@anthropic-ai/claude-agent-sdk` directly, and the modular-monolith dependency rules explicitly forbid `api -> agent` imports.

## Scope Guardrails

- Do not build a marketplace or general plugin UI in the first pass.
- Do not store raw provider secrets in SQLite; store references such as `apiKeyEnvVar` and resolve secrets from env/process context.
- Do not promise feature parity for every runtime; enforce capabilities explicitly and degrade gracefully when a profile cannot support session listing, resume, or subagent-style workflows.
- Keep `packages/api/src/routes/settings.ts` and its global `~/.claude.json` MCP mutation flow unchanged in the first pass. Runtime-agnostic host setup is a follow-up after the core registry/profile architecture is stable.

## Research Context

Current Claude-specific coupling lives in:

- `packages/agent/src/subagentQuery.ts` - direct `query()` usage, Claude hooks, `resume`, `preset: "claude_code"`
- `packages/agent/src/subagents/planner.ts`, `implementer.ts`, `reviewer.ts`, `reviewGate.ts` - stage prompts and Claude-specific execution assumptions
- `packages/api/src/routes/chat.ts` - direct `query`, `listSessions`, `getSessionMessages`, `getSessionInfo`
- `packages/api/src/services/fastFix.ts`, `roadmapGeneration.ts`, `commitGeneration.ts` - one-shot Claude SDK calls
- `packages/shared/src/env.ts` - only `ANTHROPIC_*` runtime envs today
- `packages/shared/src/schema.ts`, `packages/shared/src/types.ts`, `packages/shared/src/index.ts`, `packages/shared/src/browser.ts` - task/chat/project shapes and exports have no runtime/profile abstraction
- `packages/shared/src/db.ts` - SQLite bootstrap and migrations are hand-managed here, not via a separate migrations package
- `packages/web/src/components/task/TaskSettings.tsx`, `packages/web/src/components/kanban/AddTaskForm.tsx`, `packages/web/src/App.tsx` - UI is Claude-oriented and only exposes `useSubagents`
- `packages/api/src/index.ts`, `packages/agent/src/wakeChannel.ts`, `packages/web/src/hooks/useSettings.ts`, `packages/web/src/lib/api.ts` - readiness/settings contracts currently assume Claude auth semantics
- `packages/mcp/src/tools/createTask.ts` and related tools - task contracts mirror the old shape and must stay in sync

Patterns and constraints to preserve:

- DB access continues to flow only through `@aif/data`
- Shared/browser-safe exports must remain browser-safe
- SQLite schema changes require `packages/shared/src/db.ts` migration steps and backfill logic
- Existing Claude behavior must remain fully functional while the new abstraction is introduced

## Tasks

### Progress Checklist

- [x] Task 1: Create the `@aif/runtime` workspace and module contract
- [x] Task 2: Add neutral runtime/provider persistence, exports, and env support
- [x] Task 3: Extend the data layer for runtime profiles and effective profile resolution
- [x] Task 4: Implement runtime profile resolution, validation, and capability gating
- [x] Task 5: Introduce a runtime-independent workflow spec layer
- [x] Task 6: Extract a full-parity `ClaudeRuntimeAdapter`
- [x] Task 7: Refactor the agent pipeline to run through the runtime registry
- [x] Task 8: Refactor chat, one-shot AI services, and readiness contracts to the shared runtime layer
- [x] Task 9: Add runtime profile CRUD, validation, and discovery endpoints
- [x] Task 10: Implement `CodexRuntimeAdapter` and prove the extension path
- [x] Task 11: Add runtime profile management and selection UI
- [x] Task 12: Keep MCP and external task clients in sync with the new contracts
- [x] Task 13: Add regression coverage for migrations, adapters, capability gates, and UI selection
- [x] Task 14: Update architecture/config docs and run full verification
- [x] Task 15: Remove residual Claude SDK imports from `@aif/agent`
- [x] Task 16: Raise `@aif/runtime` coverage to meet the 70% package rule

### Phase 1: Runtime Foundation

#### Task 1: Create the `@aif/runtime` workspace and module contract
**Files:** `packages/runtime/package.json`, `packages/runtime/tsconfig.json`, `packages/runtime/src/index.ts`, `packages/runtime/src/types.ts`, `packages/runtime/src/registry.ts`, `packages/runtime/src/module.ts`, `packages/runtime/src/errors.ts`, `packages/api/package.json`, `packages/agent/package.json`, `package-lock.json`
**Deliverable:** Add a new workspace that becomes the single home for runtime/provider abstractions shared by `api` and `agent`. Define `RuntimeAdapter`, `RuntimeRunInput`, `RuntimeEvent`, `RuntimeSession`, `RuntimeCapabilities`, `RuntimeDescriptor`, and `RuntimeModule` contracts. The registry must support built-in registration and module-based extension via `registerRuntimeModule(registry)`, so future providers/runtimes can be added without editing orchestrator code. Wire the new package into consumer dependencies and package exports so `api` and `agent` can import it without deep paths or ad hoc build steps.
**Logging requirements:** `DEBUG [runtime-registry]` for registration and resolution; `WARN [runtime-module]` for failed module loads or invalid exports; redact auth-related fields and headers.
**Dependency notes:** Foundation task. No blockers.

#### Task 2: Add neutral runtime/provider persistence, exports, and env support
**Files:** `packages/shared/src/schema.ts`, `packages/shared/src/types.ts`, `packages/shared/src/browser.ts`, `packages/shared/src/index.ts`, `packages/shared/src/env.ts`, `packages/shared/src/db.ts`
**Deliverable:** Introduce neutral runtime/provider domain types and SQLite persistence. Add a `runtime_profiles` table with `projectId` nullable (`null` means global profile) plus non-secret configuration such as `name`, `runtimeId`, `providerId`, `transport`, `baseUrl`, `apiKeyEnvVar`, `defaultModel`, `headersJson`, `optionsJson`, and `enabled`. Extend `projects` with `defaultTaskRuntimeProfileId` and `defaultChatRuntimeProfileId`. Extend `tasks` with `runtimeProfileId`, `modelOverride`, and `runtimeOptionsJson`, while explicitly reusing the existing `tasks.sessionId` column as the neutral runtime session identifier. Extend `chat_sessions` with `runtimeProfileId` and `runtimeSessionId`; backfill `runtimeSessionId` from legacy `agent_session_id`, keep legacy read compatibility during migration, and only remove Claude-specific naming after all runtime-aware callers are switched. Export the new runtime profile and effective-selection types through both Node and browser-safe shared entry points. Add env parsing for generic defaults and module loading, such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_CLI_PATH`, `AGENTAPI_BASE_URL`, and `AIF_RUNTIME_MODULES`. Implement idempotent SQLite migration/backfill steps in `packages/shared/src/db.ts`, including explicit backfill counts and rollback-safe ordering.
**Logging requirements:** `INFO [db]` for migration application and backfill counts; `WARN [env]` when runtime defaults are incomplete or invalid; never log secret values, raw API keys, or unredacted headers.
**Dependency notes:** Depends on Task 1 because the persisted types should match the runtime contracts.

#### Task 3: Extend the data layer for runtime profiles and effective profile resolution
**Files:** `packages/data/src/index.ts`, `packages/data/src/__tests__/runtimeProfiles.test.ts` (new or updated)
**Deliverable:** Add repository functions for CRUD over runtime profiles, project defaults, task overrides, and chat session runtime fields. Update `createTask`, `updateTask`, `createProject`, `updateProject`, `createChatSession`, `updateChatSession`, and all response mappers so runtime metadata flows through the domain cleanly. Add a repository helper that resolves the effective runtime profile using the fallback order `task override -> project default -> explicit system default`.
**Logging requirements:** `DEBUG [data]` for runtime profile CRUD and task/project runtime updates; `INFO [data]` when effective profile resolution falls back from override to project default or system default.
**Dependency notes:** Depends on Task 2.

### Phase 2: Core Runtime Services

#### Task 4: Implement runtime profile resolution, validation, and capability gating
**Files:** `packages/runtime/src/resolution.ts`, `packages/runtime/src/capabilities.ts`, `packages/runtime/src/modelDiscovery.ts`, `packages/runtime/src/cache.ts`, `packages/runtime/src/index.ts`
**Deliverable:** Build the shared services that merge persisted profile data with environment-resolved auth, request overrides, and runtime-specific defaults. Add capability checks for `supportsResume`, `supportsSessionList`, `supportsAgentDefinitions`, `supportsStreaming`, `supportsModelDiscovery`, `supportsApprovals`, and `supportsCustomEndpoint`. Add model discovery and connection-test primitives that can be reused by API routes and UI. All validation failures must produce normalized, user-visible errors instead of leaking runtime-specific stack traces.
**Logging requirements:** `DEBUG [runtime-resolution]` for profile merge and fallback chain; `INFO [runtime-validation]` for successful validation/model discovery; `WARN [runtime-capabilities]` for unsupported feature combinations.
**Dependency notes:** Depends on Tasks 1-3.

#### Task 5: Introduce a runtime-independent workflow spec layer
**Files:** `packages/runtime/src/workflowSpec.ts`, `packages/runtime/src/promptPolicy.ts`, `packages/agent/src/subagents/planner.ts`, `packages/agent/src/subagents/implementer.ts`, `packages/agent/src/subagents/reviewer.ts`, `packages/agent/src/reviewGate.ts`
**Deliverable:** Add a normalized `RuntimeWorkflowSpec` layer between orchestration and adapter execution. The spec must capture `workflowKind`, prompt-building inputs, required capabilities, optional `agentDefinitionName`, skill/slash fallback strategy, system prompt append rules, and session reuse policy. This task should extract workflow intent from Claude-only branching so later adapters receive a normalized request instead of raw Claude assumptions. The goal is to keep orchestration semantics stable while making adapters responsible only for execution, session APIs, and provider-specific features.
**Logging requirements:** `DEBUG [runtime-workflow]` for workflow spec construction and fallback policy; `WARN [runtime-workflow]` when a workflow requests capabilities unsupported by the selected runtime profile.
**Dependency notes:** Depends on Tasks 1-4. This task blocks the Claude adapter extraction and the agent pipeline refactor.

#### Task 6: Extract a full-parity `ClaudeRuntimeAdapter`
**Files:** `packages/runtime/src/adapters/claude/index.ts`, `packages/runtime/src/adapters/claude/run.ts`, `packages/runtime/src/adapters/claude/sessions.ts`, `packages/runtime/src/adapters/claude/errors.ts`, `packages/runtime/src/adapters/claude/hooks.ts`, `packages/runtime/src/__tests__/claudeAdapter.test.ts`
**Deliverable:** Move all Claude SDK execution concerns behind a dedicated adapter. This adapter must own `query`, `resume`, session listing, session info, session message reads, Claude-specific hook wiring, token usage normalization, failure classification, and `preset: "claude_code"` / `.claude/agents` behavior. The adapter must consume the normalized workflow spec from Task 5 rather than reconstructing Claude-only intent internally. The goal is zero Claude SDK imports in `api` and `agent` after the refactor, while preserving current runtime behavior.
**Logging requirements:** `INFO [runtime:claude]` for run start/complete; `DEBUG [runtime:claude]` for session init/resume and normalized event emission; `ERROR [runtime:claude]` for classified SDK or CLI failures.
**Dependency notes:** Depends on Task 5.

### Phase 3: Orchestrator and API Integration

#### Task 7: Refactor the agent pipeline to run through the runtime registry
**Files:** `packages/agent/src/subagentQuery.ts`, `packages/agent/src/subagents/planner.ts`, `packages/agent/src/subagents/implementer.ts`, `packages/agent/src/subagents/reviewer.ts`, `packages/agent/src/reviewGate.ts`, `packages/agent/src/index.ts`, `packages/agent/src/__tests__/planner.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`, `packages/agent/src/__tests__/subagentQuery.test.ts`
**Deliverable:** Update the planner/implementer/reviewer pipeline to resolve an effective runtime profile before execution and call the shared runtime registry instead of importing Claude SDK helpers. Consume the normalized workflow spec from Task 5 so the stage handlers work with runtime-agnostic inputs such as `workflowKind = "planner" | "implementer" | "reviewer"`. Persist neutral runtime session IDs on tasks, annotate activity logs with runtime/profile/model metadata, and block or requeue tasks when the selected profile lacks required capabilities.
**Logging requirements:** `INFO [agent]` for chosen runtime/profile/model per stage; `DEBUG [agent]` for prompt strategy and session reuse; `WARN [agent]` when falling back to a default profile; `ERROR [agent]` when capability checks block a task.
**Dependency notes:** Depends on Tasks 3-6.

#### Task 8: Refactor chat, one-shot AI services, and readiness contracts to the shared runtime layer
**Files:** `packages/api/src/routes/chat.ts`, `packages/api/src/services/fastFix.ts`, `packages/api/src/services/roadmapGeneration.ts`, `packages/api/src/services/commitGeneration.ts`, `packages/api/src/index.ts`, `packages/api/src/services/sessionCache.ts`, `packages/api/src/__tests__/chatSessions.test.ts`, `packages/api/src/__tests__/settings.test.ts`, `packages/agent/src/wakeChannel.ts`, `packages/web/src/hooks/useSettings.ts`, `packages/web/src/lib/api.ts`, `packages/web/src/App.tsx`, `packages/web/src/__tests__/useSettings.test.tsx`
**Deliverable:** Replace direct Claude SDK usage in chat and one-shot API services with calls into `@aif/runtime`. Chat must use adapter-owned run/resume/session APIs and degrade gracefully when the selected runtime lacks external session discovery. `fastFix`, roadmap generation, and commit generation must resolve a runtime profile explicitly instead of assuming Claude. Update `/agent/readiness` and the top-level `/settings` payload so they describe runtime/profile readiness and defaults rather than only Claude auth. Adjust the agent wake channel and existing web hooks/UI consumers to use the new generic readiness contract and remove Claude-only banner copy. Keep `packages/api/src/routes/settings.ts` and its `/settings/mcp` flow unchanged in this iteration.
**Logging requirements:** `INFO [api-runtime]` for selected runtime/profile per request; `DEBUG [chat-route]` for DB-vs-runtime session discovery source; `WARN [chat-route]` when capability limits force a feature fallback.
**Dependency notes:** Depends on Tasks 3-6.

### Phase 4: Runtime/Profile APIs

#### Task 9: Add runtime profile CRUD, validation, and discovery endpoints
**Files:** `packages/api/src/routes/runtimeProfiles.ts` (new), `packages/api/src/routes/tasks.ts`, `packages/api/src/routes/projects.ts`, `packages/api/src/schemas.ts`, `packages/api/src/index.ts`, `packages/api/src/__tests__/runtimeProfiles.test.ts`
**Deliverable:** Add REST endpoints for runtime profile CRUD plus `validate` and `list models` actions. Extend task and project create/update schemas so clients can set default task/chat profiles, task overrides, and model overrides. Response payloads should include effective runtime metadata needed by the UI. Validation routes must use the shared runtime services rather than ad hoc checks.
**Logging requirements:** `DEBUG [runtime-profile-route]` for CRUD requests; `INFO [runtime-profile-route]` for validation/model discovery success; `WARN [runtime-profile-route]` for rejected or insecure configs.
**Dependency notes:** Depends on Tasks 3-4 and should land before the UI work.

### Phase 5: First Non-Claude Provider Path

#### Task 10: Implement `CodexRuntimeAdapter` and prove the extension path
**Files:** `packages/runtime/src/adapters/codex/index.ts`, `packages/runtime/src/adapters/codex/cli.ts`, `packages/runtime/src/adapters/codex/agentapi.ts`, `packages/runtime/src/adapters/codex/errors.ts`, `packages/runtime/src/__tests__/codexAdapter.test.ts`, `packages/runtime/src/__tests__/moduleLoader.test.ts`
**Deliverable:** Add the first non-Claude adapter to validate the abstraction. Support a CLI-first transport and keep an AgentAPI transport hook behind the same adapter so the system can choose transport without changing the orchestrator. The profile model must allow custom `baseUrl`, `apiKeyEnvVar`, headers, and provider options so OpenAI-compatible backends can be routed without core changes. Add a minimal sample module/export path that proves a third-party runtime/provider can register itself through `registerRuntimeModule(registry)`.
**Logging requirements:** `INFO [runtime:codex]` for chosen transport (`cli` or `agentapi`); `DEBUG [runtime:codex]` for model discovery and session normalization; `WARN [runtime:codex]` when a requested Claude-only feature is unsupported.
**Dependency notes:** Depends on Tasks 4, 6, and 9. Claude parity and runtime profile APIs must be stable first so regressions are easy to detect.

### Phase 6: UI and External Clients

#### Task 11: Add runtime profile management and selection UI
**Files:** `packages/web/src/lib/api.ts`, `packages/web/src/hooks/useRuntimeProfiles.ts` (new), `packages/web/src/components/project/ProjectRuntimeSettings.tsx` (new), `packages/web/src/components/settings/RuntimeProfileForm.tsx` (new), `packages/web/src/components/task/TaskSettings.tsx`, `packages/web/src/components/kanban/AddTaskForm.tsx`, `packages/web/src/components/chat/ChatPanel.tsx`, `packages/web/src/App.tsx`, `packages/web/src/__tests__/TaskSettings.test.tsx`, `packages/web/src/__tests__/AddTaskForm.test.tsx`
**Deliverable:** Add UI for creating, editing, and deleting runtime profiles; selecting project-level defaults for task execution and chat; selecting task-level runtime overrides and model overrides; and showing capability warnings before a user saves an unsupported combination. Replace Claude-only UX copy and empty-state banners with generic runtime/provider guidance. The UI must never persist raw provider secrets; it may store only non-secret fields such as `apiKeyEnvVar`, `baseUrl`, headers metadata, and runtime options. If the user enters a temporary credential for validation, send it only to the validation flow and discard it immediately after the response.
**Logging requirements:** `console.debug` for profile fetch/save/select flows during development only; do not log secrets, headers, or resolved auth values in the browser.
**Dependency notes:** Depends on Tasks 8-10.

#### Task 12: Keep MCP and external task clients in sync with the new contracts
**Files:** `packages/mcp/src/tools/createTask.ts`, `packages/mcp/src/tools/updateTask.ts`, `packages/mcp/src/tools/getTask.ts`, `packages/mcp/src/__tests__/*` (new or updated)
**Deliverable:** Extend MCP task creation/update tools so external clients can specify `runtimeProfileId`, `modelOverride`, and see effective runtime metadata in responses. Validate that a selected runtime profile belongs to the same project or is explicitly global. Keep the MCP contract aligned with the API and shared types to avoid drift.
**Logging requirements:** `DEBUG [mcp:tool:*]` for runtime-related inputs and compact responses; `WARN [mcp:tool:*]` when rejecting cross-project or disabled profiles.
**Dependency notes:** Depends on Tasks 3 and 9.

### Phase 7: Verification and Documentation

#### Task 13: Add regression coverage for migrations, adapters, capability gates, and UI selection
**Files:** `packages/runtime/src/__tests__/registry.test.ts`, `packages/runtime/src/__tests__/moduleLoader.test.ts`, `packages/shared/src/__tests__/env.test.ts`, `packages/shared/src/__tests__/db.test.ts` (new or updated), `packages/data/src/__tests__/runtimeProfiles.test.ts`, `packages/api/src/__tests__/runtimeProfiles.test.ts`, `packages/agent/src/__tests__/planner.test.ts`, `packages/agent/src/__tests__/implementer.test.ts`, `packages/web/src/__tests__/useRuntimeProfiles.test.tsx`, `packages/mcp/src/__tests__/*`
**Deliverable:** Add comprehensive regression coverage for SQLite migrations/backfills, runtime registry resolution, capability gating, Claude parity, Codex adapter behavior, API validation routes, task/profile UI selection, and MCP contract alignment. Tests must assert that sensitive config values are redacted from logs and error payloads.
**Logging requirements:** No new production logging, but tests must assert that runtime IDs and capability warnings appear where expected and that secrets never appear.
**Dependency notes:** Depends on Tasks 7-12.

#### Task 14: Update architecture/config docs and run full verification
**Files:** `README.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/providers.md` (new), optional updates to package READMEs if needed
**Deliverable:** Document the runtime registry architecture, profile model, supported adapters, env/auth setup, capability differences, and the module contract for custom runtimes/providers. Include concrete examples for Claude and Codex profiles. Finish by running `npm run lint`, `npm test`, and `npm run build`, then fix any fallout before considering the feature complete.
**Logging requirements:** No additional runtime logging. Verification commands should be documented in the commit/PR narrative, not as a separate report task.
**Dependency notes:** Depends on Task 13.

### Phase 8: Post-Verification Fixups

#### Task 15: Remove residual Claude SDK imports from `@aif/agent`
**Files:** `packages/agent/src/hooks.ts`, `packages/agent/src/subagentQuery.ts`, related agent tests if typings need updates
**Deliverable:** Complete the Task 6 decoupling goal by removing remaining direct `@anthropic-ai/claude-agent-sdk` imports from `@aif/agent` (including type-only imports). Keep hook wiring behavior unchanged by using runtime-neutral hook callback typing at the agent boundary.
**Logging requirements:** No new runtime logging required.
**Dependency notes:** Follow-up fix after Tasks 6-7 verification.

#### Task 16: Raise `@aif/runtime` coverage to meet the 70% package rule
**Files:** `packages/runtime/src/__tests__/codexAdapter.test.ts`, `packages/runtime/src/__tests__/codexCli.test.ts` (new), `packages/runtime/src/__tests__/codexAgentApi.test.ts` (new), optional targeted test updates in runtime adapter tests
**Deliverable:** Add regression tests for Codex CLI and AgentAPI execution/validation/model-discovery paths so `@aif/runtime` package coverage (at minimum statements/lines) is >= 70%, in line with `.ai-factory/RULES.md`.
**Logging requirements:** Test-only assertions; no additional production logging.
**Dependency notes:** Follow-up fix after Task 13 verification.

## Commit Plan

### Commit 1 (after Tasks 1-3): runtime domain foundation
```text
feat(runtime,shared,data): add runtime profile foundation

Create the runtime workspace, add runtime/provider profile schema and
env support, and extend the data layer with effective profile resolution.
```

### Commit 2 (after Tasks 4-7): shared runtime execution path
```text
refactor(agent,runtime): route task execution through runtime registry

Add runtime validation/capability services, introduce the workflow-spec
layer, extract the Claude adapter, and refactor the
planner/implementer/reviewer pipeline to use the shared runtime
registry.
```

### Commit 3 (after Tasks 8-11): provider APIs, Codex support, and UI
```text
feat(api,web,runtime): add runtime management and codex adapter

Refactor chat, readiness, and one-shot services to the runtime layer,
add runtime profile CRUD and validation endpoints, implement the first
Codex adapter, and expose runtime selection in the UI.
```

### Commit 4 (after Tasks 12-14): contract parity, docs, and verification
```text
test(docs,mcp): cover runtime modularity and document provider setup

Sync MCP contracts with runtime profile support, add regression
coverage across packages, update architecture/configuration docs,
and complete lint/test/build verification.
```
