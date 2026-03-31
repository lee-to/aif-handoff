# Project Roadmap

> Autonomous task management platform where AI subagents plan, implement, and review work through a real-time Kanban workflow.

## Milestones

- [x] **Core Monorepo Foundation** — establish Turborepo package boundaries (`shared`, `data`, `api`, `web`, `agent`) with strict DB access rules.
- [x] **Autonomous Agent Pipeline** — implement stage-based orchestration from Backlog to Done with planner, implementer, and reviewer subagents.
- [x] **Real-Time Kanban Experience** — deliver React board UX with WebSocket-driven task updates and detailed task views.
- [x] **Roadmap Import and Generation Flow** — support roadmap import/generation workflows with async API/WebSocket feedback in UI.
- [x] **Task Attachment Support** — persist and display task attachments across API, data layer, and UI.
- [ ] **Safe Parallel Agent Processing** — add lease-based claiming, configurable concurrency, worker-pool execution, and requeue logic for robust parallel processing.
- [x] **AI Chat for Codebase Questions** — add in-app AI chat focused on repository-aware developer assistance.
- [ ] **AI Chat Sessions** — add persistent chat sessions with history, context carry-over, and session management UI.
- [ ] **Documentation Generation Action** — add a dedicated UI button/action to generate project documentation.
- [ ] **Docker Generation Action** — add a dedicated UI button/action to generate Docker configuration.
- [ ] **CI Generation Action** — add a dedicated UI button/action to generate CI configuration.
- [ ] **Automation Generation Action** — add a dedicated UI button/action to generate build/automation configuration.
- [ ] **Bidirectional Handoff ↔ AIF Sync** — implement two-way synchronization between Handoff and AI Factory via MCP server, keeping tasks, plans, and status in sync across both systems. Plans should include task ID annotations for traceability.

## Completed

| Milestone | Date |
|-----------|------|
| Core Monorepo Foundation | 2026-03-29 |
| Autonomous Agent Pipeline | 2026-03-29 |
| Real-Time Kanban Experience | 2026-03-29 |
| Roadmap Import and Generation Flow | 2026-03-29 |
| Task Attachment Support | 2026-03-29 |
| AI Chat for Codebase Questions | 2026-03-31 |
