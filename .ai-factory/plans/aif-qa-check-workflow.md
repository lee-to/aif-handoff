# Implementation Plan: AIF QA Check Workflow

Branch: main
Created: 2026-08-24

## Original Request

https://github.com/lee-to/aif-handoff/issues/179 давай реализуем эту задачу, но важно что галочка или кнопка запустить qa check должна также проверять есть ли у текущего рантайма playwright mcp либо если это codex app рантайм, видимо стоит нам сперва продумать как сделать лучше и как интегрировать это в воркфлоу, изучи aif-qa и то как он уже интегрирован и aif-qa-check который проверяет

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes

## Roadmap Linkage

Milestone: "none"
Rationale: The current roadmap has no open QA workflow milestone.

## Tasks

### Phase 1: Persistence

- [x] Task 1: Add a separate `autoQaCheck` opt-in plus persisted QA Check report, lifecycle status, Playwright MCP availability, atomic start claim, and stale-run recovery in `packages/shared` and `packages/data`. Add focused migration and repository tests. Log claim/recovery state changes through the existing configurable Pino logger.

### Phase 2: Runtime workflow

- [x] Task 2: Add `qaCheckRunner.ts`, a manual `POST /tasks/:id/run-qa-check` route, and automatic sequential chaining after successful auto QA. Resolve the effective task runtime, check its configured `playwright` MCP server without treating Codex app-server as a desktop browser, and pass the advisory result into `/aif-qa-check agent`. Browser cases may be blocked when unavailable; all other cases continue. Add structured start, preflight, completion, and error logs plus API tests. (depends on Task 1)

### Phase 3: UI and documentation

- [x] Task 3: Extend the existing QA tab with a Run QA Check button, report viewer, lifecycle badge, and Playwright advisory; rename the existing auto-QA label so it clearly runs plan generation plus QA Check. Reuse current UI primitives and update API, architecture, and configuration docs. Add component coverage. (depends on Task 2)

### Phase 4: Validation

- [x] Task 4: Run affected package tests and coverage, then run `npm run ai:validate`; fix only regressions introduced by this implementation and re-check the final diff. Log validation failures only in command output; add no report artifact. (depends on Tasks 1-3)
