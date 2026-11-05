# Chat objectives and linked tasks

Source: PR #178, thread workspace contribution by Nader S. (LuciferLuther).

## Scope

Add status, objectives, and same-project task/PR links to the existing chat panel.
Keep Kanban as the default screen. Exclude Kerry pilot, permission defaults, and Docker changes.
Use existing UI primitives and append migration 31 without changing merged migrations.

## Settings

- Tests: data invariants, migration upgrade, API validation/permissions, UI creation, cache refresh.
- Docs: update API reference and architecture chat section.
- No commit or publication requested.

## Tasks

- [x] Adapt schema, data repositories, and API from PR #178 to current main.
- [x] Extend existing chat panel, persist new chats without model calls, and refresh linked task status.
- [x] Cover migration, lifecycle, authorization, error handling, and live refresh regressions.
- [x] Update docs, review package checklists, and run npm run ai:validate.

## Validation and checklist handoff

- `npm run ai:validate`: passed, including all package tests, V8 coverage, build, five browser checks, all three k6 scripts, protocol sync, and checklist gate.
- Coverage statements: shared 80.42%, data 84.90%, API 83.24%, web 90.37%, runtime 86.18%, agent 86.61%, MCP 92.98%; all configured coverage metrics exceed 70%.
- Browser scenario: empty chat creation, objectives, task linking, live task updates, closure guard, and both themes passed with zero model-execution requests.
- Existing migrations 1–30 verified unchanged; v30 upgrade preserves chat history and new links survive restart.
- Reused Input, Select, Checkbox, FormDialog, Button, and Badge inside the existing ChatPanel; no new visual component or Pencil representation required.
- State-machine changes, adapter capability changes, new packages/dependencies, Docker sync, and fenced canonical file writes are not applicable.
- Fixed the existing dashboard perf test to wait for the actual root projects overview or empty state, keeping performance budgets unchanged.
- k6 used a worktree-only fixture containing a paused task and a chat. Codex SDK/CLI 0.162.1 from the lockfile were used for protocol validation; manifests and generated runtime files are unchanged.
- No commit, push, PR publication, or change to the original PR was performed.
