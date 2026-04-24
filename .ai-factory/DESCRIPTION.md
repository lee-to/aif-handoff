# AIF Handoff

## Overview

Autonomous task management system with Kanban board and AI subagents. Tasks flow through stages automatically: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — each stage handled by specialized subagents routed through a pluggable runtime layer, powered by ai-factory infrastructure.

## Core Features

- Kanban board with drag-and-drop task management
- Automated task pipeline via pluggable runtime adapters (Claude, Codex, custom)
- Real-time updates via WebSocket
- Plan generation, implementation, and code review — all autonomous

## Tech Stack

- **Runtime:** Node.js + TypeScript (ES2022, ESNext modules)
- **Monorepo:** Turborepo (npm workspaces)
- **Runtime Modularity:** `@aif/runtime` workspace for runtime/provider contracts and registry
- **Runtime Adapters:** Claude (Agent SDK), Codex (SDK/CLI/API), OpenRouter (API), extensible via AIF_RUNTIME_MODULES
- **Database:** SQLite (better-sqlite3 + drizzle-orm)
- **API:** Hono + @hono/node-server + WebSocket (ws)
- **Validation:** zod + @hono/zod-validator
- **Frontend:** React 19 + Vite + TailwindCSS 4
- **Drag & Drop:** @dnd-kit
- **Server State:** @tanstack/react-query
- **Scheduler:** node-cron
- **Logger:** pino
- **Testing:** Vitest + @testing-library/react

## Architecture

- **shared** (`@aif/shared`) — Types, SQLite schema (drizzle-orm), state machine, constants, env, logger
- **runtime** (`@aif/runtime`) — Runtime/provider adapter contracts, registry, and module-loading extension surface
- **data** (`@aif/data`) — Centralized data-access layer for all DB reads/writes
- **api** (`@aif/api`) — Hono REST + WebSocket server (port 3009)
- **web** (`@aif/web`) — React SPA Kanban UI (port 5180)
- **agent** (`@aif/agent`) — Runtime-neutral coordinator (node-cron polling) + subagent orchestration

Lint guard enforces DB boundaries: `api`, `agent`, and `runtime` can access DB only through `@aif/data`.

## Agent Pipeline

The coordinator polls every 30s and delegates through runtime-resolved agent workflows:
- **Backlog → Planning → Plan Ready:** `plan-coordinator` (iterative plan refinement)
- **Plan Ready → Implementing → Review:** `implement-coordinator` (parallel task execution with workers/sidecars)
- **Review → Done:** `review-sidecar` + `security-sidecar` (code review and security audit)

## Non-Functional Requirements

- Logging: Configurable via LOG_LEVEL (pino)
- Error handling: Structured error responses with zod validation
- Security: Agent SDK uses ~/.claude/ credentials by default
- Real-time: WebSocket for live UI updates

## Architecture

See `.ai-factory/ARCHITECTURE.md` for detailed architecture guidelines.
Pattern: Modular Monolith (Turborepo workspaces)

## Business Context

Commercial product — UI quality and polish are critical.
