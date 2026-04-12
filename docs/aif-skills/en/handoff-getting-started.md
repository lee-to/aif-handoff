# Handoff — Getting Started

## Requirements

- **Docker** — recommended way to run
- Node.js 22+ and npm 10+ — for running without Docker
- **Claude Code CLI** — if without Docker: `npm i -g @anthropic-ai/claude-code`
- Claude subscription or Anthropic API key

## Running with Docker (recommended)

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
docker compose up --build
```

Launches API (port 3009), Web UI (port 5180), and Agent in a single command.

### Authentication in Docker

**Option A — API key:** create `.env` with `ANTHROPIC_API_KEY=sk-ant-xxxxx` before starting.

**Option B — Claude subscription:**

```bash
docker compose exec agent claude login
docker compose restart
```

> Important: The login URL may wrap across lines — remove line breaks before pasting into the browser.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Only ports 80/443 are exposed. Includes healthchecks, resource limits, and log rotation.

## Running without Docker

```bash
npm i -g @anthropic-ai/claude-code
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install
npm run db:setup
cp .env.example .env
npm run dev
```

## Services

| Service | URL                     | Description           |
| ------- | ----------------------- | --------------------- |
| API     | `http://localhost:3009` | REST + WebSocket      |
| Web UI  | `http://localhost:5180` | Kanban board          |
| Agent   | (background)            | Polls tasks every 30s |

## Verifying it works

1. Open `http://localhost:5180` — the Kanban board should appear
2. Create a project (selector in the top-left)
3. Add a task to the Backlog column
4. If authentication is configured — the task will automatically advance through stages

```bash
# Check agent readiness
curl -s http://localhost:3009/agent/readiness
```

## Core commands

| Command            | Description                  |
| ------------------ | ---------------------------- |
| `npm run dev`      | All services with hot reload |
| `npm run build`    | Build all packages           |
| `npm test`         | Run tests                    |
| `npm run db:setup` | Initialize SQLite            |
| `npm run db:push`  | Apply schema changes         |
