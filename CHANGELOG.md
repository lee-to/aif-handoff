# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Per-project parallel task execution** — coordinator processes multiple tasks concurrently for projects with "Parallel Execution" enabled; non-parallel projects unchanged (1 task at a time)
- Lease-based task claiming with `lockedBy`/`lockedUntil` columns and atomic UPDATE pattern
- Cross-project coordinator lanes with independent project and per-project task caps
- Global concurrency safety cap (`COORDINATOR_MAX_CONCURRENT_TASKS`, default 12) across all project lanes
- Heartbeat-based lock renewal — locks stay alive as long as the agent process is running
- Stale claim recovery — expired TTL or dead heartbeat auto-releases orphaned locks
- Graceful shutdown lock release on SIGINT/SIGTERM
- Per-project stage semaphore with a global total-active limit
- API validation: parallel projects force `plannerMode=full`, reject `fast` with 400
- UI: mode selector and plan path locked in parallel mode (AddTaskForm + TaskSettings)
- Real-time agent activity broadcast via WebSocket
- Auto-commit on task approval (`/aif-commit` integration)
- File attachment support in chat with disk persistence and download
- Open Task button after task creation in chat
- Inline SVG logo supporting dark/light themes
- Highlighted agent activity cards in timeline
- Chat message markdown rendering for user messages
- Dynamic full mode plan path for flexible planning workflows
- YAML-based configuration support
- Telegram notifications on task status changes (best-effort, with stage-aware transitions)
- MCP server for bidirectional AIF <-> Handoff sync
- MCP server service in Docker configurations
- Versioned database migrations and agent session resume
- Import Existing button in roadmap modal
- Docker support with dev and production compose configurations
- Model option helper to skip model param when `ANTHROPIC_BASE_URL` is set
- Chat sessions — persistent multi-turn conversations with session list, rename, delete, and SDK session history
- Skill tool in chat with allowed skills whitelist, error streaming and tool feedback
- Task-aware chat tooling — create tasks and summarize from conversation
- Real-time chat feature with WebSocket support
- URL routing and markdown rendering improvements
- Collapsible TaskPlan section (like Attachments)
- Task settings visible on done status without planner section
- Task pause/resume support for auto mode
- Max review iterations limit for auto mode tasks
- Increased default agent timeout limits for long-running tasks
- Backlog settings panel with `AGENT_USE_SUBAGENTS` env for default task settings

### Fixed

- Sheet portal rendering and dialog overflow on small viewports
- Auto-focus chat input on new session creation
- Hide empty message bubble when response is only an action block
- Per-session streaming state and stricter task creation prompt
- Handoff sync: inline MCP instructions, conflict resolver fallback, terminal status guard
- Bidirectional aif-plan sync problems
- Chat cosmetics and z-index layering
- Web env loading
- Telegram: use `stage.inProgress` as `fromStatus` for post-stage notifications
- Telegram: skip notifications when status doesn't actually change
- MCP: return compact responses from mutation tools to reduce context usage
- Auto-focus confirm button so Enter key works in dialogs
- Skip completed milestones when importing roadmap tasks
- Subagents project scope and sorting
- Isolate agent/chat cwd from monorepo
- Chat usage limit notification readability in light theme
- Chat panel and bubble z-index to appear above TaskDetail
- Stale/blocked tasks now stay in implementing instead of reverting to plan_ready
- Review → implementing rework cycle bugs and env loading priority
- Planner default mode

---

## [0.1.0] — Initial Release

### Added

- Kanban board UI with drag-and-drop (React + @dnd-kit)
- Hono REST API with full CRUD for tasks and projects
- WebSocket real-time updates
- Claude Agent SDK subagent orchestration (plan, implement, review)
- Task state machine with auto-mode pipeline
- SQLite database with Drizzle ORM schema
- Turborepo monorepo setup (shared, api, web, agent)
- Task comments with file attachments
- Project management (multi-project support)
- Agent activity timeline and task plan viewer
- Command palette for quick actions
- Theme support (light/dark)
