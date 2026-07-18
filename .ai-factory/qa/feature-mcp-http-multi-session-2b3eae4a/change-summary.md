## Change Summary

**Commits:** 0 (uncommitted working-tree changes on `feature/mcp-http-multi-session`)
**Changed files:** 4
**Risk level:** 🟡 Medium

> Note: the change is not yet committed; evidence is taken from the working tree and `git diff` against `main` plus the two new untracked files.

---

### What Changed

Fixed the Handoff MCP HTTP transport so multiple clients (several Claude Code windows, or remote clients) can connect at the same time. Previously the HTTP server built a single shared **stateful** transport for the whole process, so only the first client could `initialize`; every later client received JSON-RPC `-32600 "Server already initialized"`. The MCP entry point was refactored into an import-safe module with a **stateless per-request** transport and a single shared rate limiter. The `stdio` transport (default for local Claude Code) is unchanged in behavior.

---

### Affected Areas

| Component | Change type | Description |
|-----------|-------------|-------------|
| `packages/mcp/src/server.ts` | Added | Pure, import-safe factories `createToolContext` / `createMcpServer(context)` / `createMcpHttpHandler(env, context)`; stateless per-request HTTP transport (`sessionIdGenerator: undefined`). |
| `packages/mcp/src/index.ts` | Changed | Reduced to a thin process entry (`startStdio` / `startHttp` / `main` + graceful shutdown) delegating to `server.ts`; `import "./stdioEnv.js"` kept as the first line. |
| `packages/mcp/src/__tests__/httpTransport.test.ts` | Added | Integration tests: two independent `initialize` calls, `/health`, `404`, shared stateful `RateLimiter`. |
| `docs/mcp-sync.md` | Changed | Documented concurrent multi-client support in the "HTTP — Docker / remote" section. |

---

### Evidence

| Finding | Evidence |
|---------|----------|
| Root cause: one shared stateful transport | Old `startHttp` in `index.ts` (git diff): single `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })`, every `/mcp` request routed into it; SDK returns `-32600` on the 2nd `initialize` (`webStandardStreamableHttp.js:421-427`). |
| Fix: stateless per-request transport | `server.ts` `createMcpHttpHandler` — fresh `createMcpServer(context)` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per `/mcp` request; SDK requires this (`webStandardStreamableHttp.js:138-140`). |
| Shared rate limiter preserved | `createToolContext(env)` built once; `createMcpServer(context)` takes the injected shared context; `RateLimiter` holds an in-memory bucket `Map` (`rateLimit.ts:22`). |
| stdio stdout hygiene | `index.ts:1` `import "./stdioEnv.js"` (sets `LOG_DESTINATION=stderr` before logger init). |
| Green build | `@aif/mcp`: lint clean, `tsc` clean, 85 tests pass, coverage Functions 100% / Lines 94.69%. |

---

### Risks

🔴 **Critical** (must verify):

- **stdio transport regression.** stdio is the default local transport; the refactor changed `createMcpServer` to take an injected context. If `startStdio` wiring is wrong, local Claude Code loses the MCP entirely.
- **HTTP multi-client.** Two or more clients must each `initialize` over HTTP without `-32600`.

🟡 **Medium** (should verify):

- **Docker `/health`.** The production compose healthcheck (`docker-compose.production.yml:185`) depends on `/health` returning `200`.
- **Rate limiting still enforced.** The shared limiter must not reset per request (would silently disable throttling).
- **Graceful shutdown.** `SIGINT`/`SIGTERM` must still free the port (tsx-watch reload / Ctrl+C).

🟢 **Low** (nice to verify):

- `404` for unknown paths; unsupported methods return `405`; missing `Accept` header returns `406`.
- Per-request allocation of a fresh server/transport under load (no HTTP-layer connection cap).

---

### Testing Recommendations

**First priority:**

- [ ] Local `stdio` MCP still connects and tools work (`listTasks` / `getTask` / `createTask`).
- [ ] Two Claude Code windows both connect over HTTP concurrently — no `-32600`.

**Regression:**

- [ ] Docker container healthcheck passes (`/health` → `200 {status:"ok"}`).
- [ ] Rate limiting still triggers under a burst of read/write tool calls.
- [ ] Ctrl+C / signal frees `MCP_PORT` (no "port already in use" on restart).
