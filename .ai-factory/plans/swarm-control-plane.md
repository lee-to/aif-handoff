# Swarm control plane

Source: `.ai-factory/files/aif-handoff-swarm-concept.md` (H1–H5 MVP).
Docs: yes

Handoff connects to one separately managed Runtime for one configured project.
Runtime owns execution, durable events, policy enforcement and final completion.
No scheduler, leases, runtime database access or remote runner provisioning here.
The neighbouring ai-factory-swarm is being implemented independently; the v1
contract below must be checked against its implementation before live deployment.

- [x] H1: Versioned, validated Runtime contract, compatibility fixtures, server configuration and authenticated client; tests for invalid payloads and secret redaction.
- [x] H1/H3: Project-scoped API, resumable SSE, command idempotency, owner/operator/viewer authorization and durable command audit; route integration tests including denied/failed actions.
- [x] H2/H4: Pencil-synced Runs/Overview, tasks/agents/events/logs, separate hierarchy/dependencies, integration evidence and confirmed controls/approvals; UI and reconnection tests.
- [x] H5: Significant-event notifications and metrics, with stale-state detection and snapshot reconciliation.
- [x] Document configuration/API/contract and update project maps; run package checklists, coverage and `npm run ai:validate`.

Package checklists reviewed: API requests use Zod; DB writes use @aif/data;
Runtime HTTP calls do not invoke provider SDKs. Web composes existing primitives,
keeps fetch in lib/api.ts, and has Pencil dark/light representations saved in the
UI kit. Shared browser exports remain browser-safe. Migrations, adapter changes,
Kanban WebSocket events and GitHub evidence/ownership changes are not applicable.
No packages or inter-package dependencies were added. Angie SSE buffering is off.
The agent Env fixture includes the new default; production agent behavior is unchanged.

Validation: `npm run ai:validate` passed, including all package coverage thresholds,
seven browser/performance scenarios, three k6 scenarios and the protocol check.
Load checks used a seeded isolated temporary database. Docker Compose config passed.

Live compatibility with ai-factory-swarm remains an external deployment check.
Notifications in this MVP require an open run view; the Runtime retains history.

## Publication follow-up

User requested a PR after implementation, then repeated review/fix/push cycles
until automatic approval. After each fixes push, post `/code-review`, wait five
minutes and read the next verdict. Do not merge the PR.

Publish branch `feat/swarm-control-plane` against `main`. Review status is tracked
in the PR rather than in this implementation checklist.
