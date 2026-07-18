## Test Plan: Multi-Session MCP HTTP Transport

**Date:** 2026-07-06
**Branch / Version:** feature/mcp-http-multi-session
**Environment:** local (stdio + HTTP) and Docker

---

### 1. Testing Goal

Verify that the Handoff MCP server accepts **multiple concurrent HTTP clients** (fixing the `-32600 "Server already initialized"` collision) while the `stdio` transport, `/health` endpoint, rate limiting, and graceful shutdown keep working exactly as before.

---

### 2. Test Scope

**In Scope** — we test:

- HTTP transport: concurrent `initialize` from multiple clients, tool calls, `/health`, `404`, method/`Accept` handling.
- `stdio` transport: local Claude Code connection and a basic tool round-trip.
- Shared rate limiter behavior across requests.
- Graceful shutdown / port release.
- Docker deployment healthcheck.

**Out of Scope** — we don't test:

- The individual MCP tool business logic (unchanged; already covered by `tools.test.ts`).
- The API broadcast / WebSocket push path (unchanged by this transport fix).
- DB schema / migrations (untouched).

---

### 3. Test Types

| Type | Priority | Area |
|------|----------|------|
| Functional | 🔴 High | Concurrent HTTP `initialize`; stdio connect; tool call over HTTP |
| Regression | 🔴 High | stdio transport; `/health`; rate limiting; graceful shutdown |
| Edge cases | 🟡 Medium | Missing `Accept` header (`406`); unsupported method (`405`); unknown path (`404`) |
| Negative | 🟡 Medium | Malformed JSON body; second client while first is mid-request |
| Security | 🟢 Low | DNS-rebinding protection not enabled (pre-existing; localhost/127.0.0.1 binding) |
| Performance | 🟢 Low | Per-request server/transport allocation under a burst |

---

### 4. Test Data

| Category | Data | Purpose |
|----------|------|---------|
| Valid data | JSON-RPC `initialize` with `Accept: application/json, text/event-stream` | Happy path |
| Boundary values | `MCP_PORT=3100` (default) and a custom valid port (e.g. `1234`) | Port config |
| Invalid data | POST `/mcp` without `Accept: text/event-stream`; `PUT /mcp` | Negative (`406` / `405`) |
| Special cases | Two clients initializing at (near) the same time | Core regression |

---

### 5. Preconditions

- [ ] `@aif/mcp` built (`npm run build --workspace=@aif/mcp`) or runnable via tsx.
- [ ] For HTTP: `MCP_TRANSPORT=http` and a free `MCP_PORT`.
- [ ] For Docker: image built, `docker compose up` for the `mcp` service.
- [ ] Two Claude Code windows available for the concurrent-client check.

---

### 6. Acceptance Criteria

- [ ] All 🔴 high-priority test cases pass (concurrent HTTP init; stdio still works; tool call works).
- [ ] `/health` returns `200 {status:"ok"}` (Docker healthcheck green).
- [ ] Rate limiting still triggers under burst (shared limiter, not reset per request).
- [ ] `SIGINT`/`SIGTERM` frees the port; restart succeeds without "address in use".
- [ ] No `-32600` for any client after the first.

---

### 7. Plan Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Uncommitted change — testing on working tree | Medium | Run automated suite (`npm test --workspace=@aif/mcp`) first; then manual two-window check |
| SSE response may keep POST stream open | Low | Automated multi-session test already passes (stream closes after the single response) |
| Full `ai:validate` not run (needs web/api/runtime services) | Low | MCP-scoped gates (format/lint/test/coverage/build) verified separately |

### 8. Checklist

| Check | Priority |
|-------|----------|
| Two HTTP clients `initialize` without `-32600` | High |
| stdio transport connects and a tool responds | High |
| Tool call over HTTP returns a valid result | High |
| `/health` → `200 {status:"ok"}` | High |
| Rate limit triggers under burst (shared limiter) | Medium |
| `SIGINT`/`SIGTERM` frees the port | Medium |
| Unknown path → `404` | Medium |
| POST `/mcp` without `Accept: text/event-stream` → `406` | Medium |
| Unsupported method (`PUT`/`PATCH`) → `405` | Low |
