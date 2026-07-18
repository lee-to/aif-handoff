# Implementation Plan: Multi-Session MCP HTTP Transport

Branch: feature/mcp-http-multi-session
Created: 2026-07-06

## Original Request
multi-session MCP HTTP transport

## Settings
- Testing: yes
- Logging: verbose
- Docs: yes  # mandatory docs checkpoint in /aif-implement

## Roadmap Linkage
Milestone: "none"
Rationale: Bug fix within the already-completed "Bidirectional Handoff ↔ AIF Sync" milestone; not a new milestone.

## Problem Statement

`packages/mcp/src/index.ts` `startHttp()` creates **one** `McpServer` and **one**
`StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })` for the
whole process, and routes every `/mcp` request into that single transport.

`sessionIdGenerator` being a function puts the transport in **stateful mode**, which is
built for a single session. The first Claude Code window sends `initialize` → the transport
sets `_initialized = true`. Any second window's `initialize` into the same transport returns
JSON-RPC `-32600 "Server already initialized"` (SDK `webStandardStreamableHttp.js`). Result:
only one session ever connects; other windows fail.

### Chosen fix: stateless per-request transport

Switch to `sessionIdGenerator: undefined` (**stateless mode**) and create a fresh
`McpServer` + `StreamableHTTPServerTransport` per `/mcp` request, closing both when the
response ends. This is the canonical MCP stateless pattern from the SDK examples and lets
any window connect independently.

This is safe here because server→client events do **not** flow through the MCP transport:
`utils/broadcast.ts:20-21` and `notifier.ts:26` push updates via HTTP `POST` to the API
(`/tasks/:id/broadcast`). No session-scoped SSE streaming is needed, so stateful session
tracking (a `Map<sessionId, transport>`) is unnecessary complexity.

### Key constraint: shared RateLimiter

`createMcpServer()` currently builds a `new RateLimiter(...)` internally (`index.ts:35-38`),
and `RateLimiter` holds a stateful in-memory token-bucket `Map` (`rateLimit.ts:22`). If we
create a new server per request, a new RateLimiter would be created per request and its
buckets would reset every call — silently disabling rate limiting. Therefore the
`RateLimiter`/`ToolContext` MUST be hoisted to startup scope and **shared** across all
per-request servers.

## Tasks

### Phase 1: Refactor for shared context & testability (no behavior change)

- [x] Task 1: Create import-safe `packages/mcp/src/server.ts` and hoist shared `ToolContext`/`RateLimiter`.
  - **Why a new module:** `index.ts` calls `main()` at top level, so it **self-starts the
    server on import**. A test that imports the HTTP handler from `index.ts` would boot the
    process (or `process.exit(1)` on env error). Move the testable factories into a
    side-effect-free `server.ts`; `index.ts` stays the thin runnable entry (Task 2).
  - Add `createToolContext(env)` in `server.ts` that constructs the `RateLimiter` and returns
    the `ToolContext` once.
  - Move `createMcpServer` into `server.ts` and change its signature to accept an injected
    `context: ToolContext` (`createMcpServer(context)`), registering the same 9 tools against
    the shared context instead of building a `RateLimiter` inside.
  - Move `startStdio` into `server.ts`; it builds the context once and passes it in (stdio
    stays single-session; behavior unchanged).
  - LOGGING (verbose): `DEBUG` on `createToolContext` with resolved rate-limit config
    (rpm/burst read+write); keep the `[mcp:...]` prefix and DEBUG/INFO/ERROR levels.
  - Files: `packages/mcp/src/server.ts` (new), `packages/mcp/src/index.ts`

- [x] Task 2: Extract the HTTP request handler seam into `server.ts`; make `index.ts` a thin entry. (depends on 1)
  - Add `createMcpHttpHandler(env, context)` in `server.ts` returning a Node `(req, res)`
    handler that owns the `/health`, `/mcp`, and `404` routing (currently inline in
    `startHttp`). Move `startHttp` into `server.ts`; it builds `context` once via
    `createToolContext(env)`, builds the handler, passes it to `createServer(...)`, and keeps
    `listen()` + the existing graceful-shutdown block.
  - Reduce `index.ts` to `import { main } from "./server.js"; main().catch(...)` plus the
    existing public re-exports (`loadMcpEnv`, `RateLimiter`, error helpers,
    `ToolContext`/`ToolRegistrar` types) — re-export them from `server.ts` so `@aif/mcp`
    consumers are unaffected. `index.ts` must remain the ONLY module with a top-level `main()`.
  - **Import ordering (correctness):** keep `import "./stdioEnv.js"` as the FIRST line of
    `index.ts`, before `import "./server.js"`, and do NOT import it from `server.ts`. It sets
    `LOG_DESTINATION=stderr` before `@aif/shared`'s logger initialises; in stdio mode, logging
    to stdout otherwise corrupts JSON-RPC (`stdioEnv.ts:2`, commit `cdad443`). Tests import
    `server.ts` and must not flip `LOG_DESTINATION`.
  - Keeps the **current** single stateful transport for now — pure restructure, behavior
    unchanged. `createMcpHttpHandler` / `createToolContext` are exported from `server.ts` for tests.
  - LOGGING (verbose): `DEBUG` per `/mcp` dispatch (HTTP method); keep the existing
    `INFO` "listening" log on `listen()`.
  - Files: `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`

### Phase 2: Stateless per-request fix (red → green)

- [x] Task 3: Add integration test `packages/mcp/src/__tests__/httpTransport.test.ts`. (depends on 2)
  - Follow existing test conventions in `__tests__/tools.test.ts` (vitest; mock
    `@aif/shared` `getEnv` and `@aif/shared/server` `getDb` with an in-memory test DB). Import
    the handler from `server.ts` — NOT `index.ts`, which self-runs `main()`.
  - Bind a real server: `http.createServer(createMcpHttpHandler(env, context)).listen(0)`,
    read the ephemeral port, drive it with `fetch`.
  - **Request contract (critical — else the SDK returns 406):** every `/mcp` POST must send
    headers `Content-Type: application/json` AND `Accept: application/json, text/event-stream`
    (SDK `webStandardStreamableHttp.js:377-380`). The `initialize` body is JSON-RPC 2.0:
    `{ jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2025-06-18",
    capabilities:{}, clientInfo:{ name:"test", version:"0" } } }`. The transport replies as
    `text/event-stream` by default — parse the SSE `data:` frame to read the JSON-RPC result.
  - Case A (multi-session, the core regression): send **two** independent `initialize` POSTs
    (no `mcp-session-id` header). Assert both succeed with a valid `initialize` result and that
    **neither** body carries error code `-32600` ("Server already initialized"). RED against
    the current stateful transport.
  - Case B (shared RateLimiter guard): assert the `RateLimiter` is created once and shared —
    e.g. two servers built from the same context reference the same `rateLimiter` instance
    (referential equality). Guards against reintroducing a per-request `RateLimiter`.
  - `/health` smoke assertion (200 `{status:"ok"}`) — locks the routing seam AND guards the
    production Docker healthcheck (`docker-compose.production.yml:185`) that depends on `/health`.
  - Coverage: add a `404` assertion for an unknown path (and exercise the `/mcp` error path) so
    the extracted `createMcpHttpHandler` branches stay within the 70% coverage rule.
  - Test hygiene: close the ephemeral `http.Server` in `afterEach`/`afterAll` (open handles
    hang vitest). Use a supported `protocolVersion` — `SUPPORTED_PROTOCOL_VERSIONS` includes
    `2025-06-18`; or import `LATEST_PROTOCOL_VERSION` from the SDK types.
  - LOGGING: n/a (test); assert on structured JSON-RPC error **codes**, never message
    substrings (project rule + patch `2026-06-30-11.27`).
  - Files: `packages/mcp/src/__tests__/httpTransport.test.ts`

- [x] Task 4: Implement stateless per-request transport (makes Task 3 green). (depends on 3)
  - In the `/mcp` branch of `createMcpHttpHandler`, **per request** create
    `transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` and
    `server = createMcpServer(context)` (shared context), register
    `res.on("close", () => { transport.close(); server.close(); })`, then
    `await server.connect(transport); await transport.handleRequest(req, res)`.
  - **Fresh transport per request is an SDK hard requirement, not a style choice:** a stateless
    transport handles exactly one request — reusing one throws
    (`webStandardStreamableHttp.js:137-139`, `if (!this.sessionIdGenerator && this._hasHandledRequest)`).
    Do NOT hoist the transport out of the per-request path.
  - Method handling: POST carries JSON-RPC. In stateless mode the SDK handles non-POST methods
    on `/mcp` itself — a `GET /mcp` opens a standalone SSE stream and returns `200` (or `406`
    if the `Accept` header omits `text/event-stream`), `DELETE /mcp` returns `200`, and only
    genuinely unsupported methods (PUT/PATCH) hit the `405` `handleUnsupportedRequest` path
    (`webStandardStreamableHttp.js:363`). No standalone SSE wiring is needed — server→client
    events flow through the API broadcast endpoint, not MCP SSE. Optional: since no
    session-scoped SSE is used, the `/mcp` branch may restrict itself to `POST` and return
    `405` for other methods to avoid leaving dangling GET SSE streams open.
  - Make the handler `async`; wrap the `/mcp` body in `try/catch` and return a structured
    JSON-RPC 500 error on failure (don't leave the socket hanging). The current code does
    **not** await `handleRequest` — the new code must await it.
  - Remove the now-unused `import { randomUUID } from "node:crypto"`. Leave `startStdio` untouched.
  - LOGGING (verbose): `DEBUG` on transport create + `res` "close"/teardown; `ERROR` with full
    context in the `catch`.
  - Files: `packages/mcp/src/server.ts`

### Phase 3: Docs, validation & operational verification

- [x] Task 5: Documentation checkpoint (mandatory — Docs: yes).
  - Route through `/aif-docs`. **Primary target:** `docs/mcp-sync.md` → the
    "HTTP — Docker / remote" section (~lines 48-62). Document that the Streamable HTTP transport
    now supports **multiple concurrent clients/sessions** (stateless per-request), so several
    Claude Code windows / remote clients can connect to `http://<host>:<MCP_PORT>/mcp` at once.
    Note server→client events travel via the API broadcast endpoint, not the MCP transport.
  - Mention that the Docker deployment (`docker-compose*.yml`, `MCP_TRANSPORT=http`) and the
    web-UI-installed HTTP URL form (`POST /settings/mcp/install`) benefit directly; **no
    `docker-compose` change is required** (same port/endpoint/transport).
  - Secondary, only if `/aif-docs` finds drift: `docs/api.md`, `docs/configuration.md`.
  - LOGGING: n/a (docs).
  - Files: `docs/mcp-sync.md` (primary; others as `/aif-docs` determines)

- [x] Task 6: Package checklist, validation & restart/verify.
  - Run `packages/mcp/CHECKLIST.md` manually: `npm run lint` and `npm test` for `@aif/mcp`
    (Zod validation + unit tests already covered; new HTTP test added in Task 3). Note
    `ai:checklist` only prints a reminder — it does not run the checklist.
  - Run `npm run ai:validate` (project rule — mandatory after implementation). The steps that
    actually exercise `@aif/mcp` are `format:check`, `lint`, `test`, `coverage`, `build`;
    `ai:perf` (@aif/web), `ai:load` (@aif/api), `ai:protocol` (@aif/runtime codex) are
    unrelated to this change and may need their own running services.
  - Restart the running MCP HTTP process so the fix takes effect: it auto-restarts if launched
    via `npm run dev` (uses `--watch` in `packages/mcp/scripts/dev-http.mjs`); the currently
    running process was started **without** `--watch`, so it needs a manual restart. Ensure the
    registered port (`http://localhost:1234/mcp`) is free before restart.
  - Verify: open two Claude Code windows and confirm the `handoff` MCP connects (initializes)
    in **both** — no `-32600`.
  - LOGGING: n/a (verification).
  - Files: none (operational)

## Commit Plan
- **Commit 1** (after tasks 1-2): `refactor(mcp): extract import-safe server module with shared ToolContext and HTTP handler`
- **Commit 2** (after tasks 3-4): `fix(mcp): stateless per-request HTTP transport for multi-session support`
- **Commit 3** (after tasks 5-6): `docs(mcp): document multi-session HTTP transport`
