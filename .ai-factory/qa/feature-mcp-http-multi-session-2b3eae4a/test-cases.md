## Test Cases: Multi-Session MCP HTTP Transport

---

### TC-001: Two concurrent HTTP clients both initialize (core regression)

**Priority:** High
**Type:** Positive

**Precondition:** MCP server running in HTTP mode (`MCP_TRANSPORT=http MCP_PORT=3100`), port `3100` reachable.

**Steps:**

1. Send a JSON-RPC `initialize` POST to `http://localhost:3100/mcp` with headers `Content-Type: application/json` and `Accept: application/json, text/event-stream` (client A).
2. Without any shared session id, send a second, independent `initialize` POST to the same URL (client B).
3. Read both responses.

**Expected result:**

Both requests return HTTP `200` with a valid `initialize` result (server capabilities). Neither response body contains error code `-32600 "Server already initialized"`.

**Test data:**

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"clientA","version":"0"}}}
```

---

### TC-002: Two real Claude Code windows connect simultaneously

**Priority:** High
**Type:** Positive

**Precondition:** `handoff` registered as HTTP MCP (`"url": "http://localhost:<port>/mcp"`); MCP process restarted after the fix.

**Steps:**

1. Open Claude Code window 1 and confirm the `handoff` MCP is connected (tools listed).
2. Open Claude Code window 2 pointed at the same MCP URL.
3. In each window, invoke a tool (e.g. `listTasks`).

**Expected result:**

Both windows show `handoff` connected; the second window does not fail with `-32600`. Tool calls succeed in both.

---

### TC-003: stdio transport still works (regression)

**Priority:** High
**Type:** Positive

**Precondition:** `.mcp.json` uses the stdio entry (`MCP_TRANSPORT=stdio`, `tsx packages/mcp/src/index.ts`).

**Steps:**

1. Start Claude Code with the stdio-configured `handoff` MCP.
2. Confirm the MCP connects (no handshake corruption on stdout).
3. Call `getTask` / `listTasks`.

**Expected result:**

MCP connects; tools respond with valid JSON. No log lines leak onto stdout (logs go to stderr). No JSON-RPC handshake errors.

---

### TC-004: Tool call over HTTP returns a valid result

**Priority:** High
**Type:** Positive

**Precondition:** HTTP MCP running; at least one project/task seeded.

**Steps:**

1. `initialize` over HTTP (headers as in TC-001).
2. Send a `tools/call` for `listTasks` (or `listProjects`).

**Expected result:**

A valid JSON-RPC result is returned with the tool payload; no `-32600` / `-32603`.

---

### TC-005: `/health` endpoint (Docker healthcheck regression)

**Priority:** High
**Type:** Positive

**Precondition:** HTTP MCP running (local or Docker container).

**Steps:**

1. `GET http://localhost:<port>/health`.
2. (Docker) `docker inspect` the `mcp` service health status after startup.

**Expected result:**

`GET /health` → `200` with body `{"status":"ok"}`. Docker healthcheck reports `healthy`.

---

### TC-006: Shared rate limiter still enforced under burst

**Priority:** Medium
**Type:** Positive

**Precondition:** HTTP MCP running with default limits (read burst `10`, `120` rpm).

**Steps:**

1. Fire more than `burst` read-tool calls in quick succession across separate HTTP requests.
2. Observe responses / server logs.

**Expected result:**

After the burst is exhausted, further calls are rate-limited (rate-limit error / `Rate limit hit` log) rather than all succeeding. This proves the limiter is shared across per-request servers, not reset each request.

---

### TC-007: Graceful shutdown frees the port

**Priority:** Medium
**Type:** Positive

**Precondition:** HTTP MCP running in the foreground.

**Steps:**

1. Send `SIGINT` (Ctrl+C) or `SIGTERM` to the process.
2. Immediately restart the server on the same `MCP_PORT`.

**Expected result:**

Process logs "Shutdown signal received — exiting" and exits; the port is released; restart succeeds with no `EADDRINUSE`.

---

### TC-008: Unknown path returns 404

**Priority:** Medium
**Type:** Negative

**Steps:**

1. `GET http://localhost:<port>/unknown`.

**Expected result:**

HTTP `404` with body `Not found`.

---

### TC-009: POST /mcp without required Accept header

**Priority:** Medium
**Type:** Negative

**Steps:**

1. POST a JSON-RPC `initialize` to `/mcp` with `Content-Type: application/json` but **omit** `text/event-stream` from `Accept`.

**Expected result:**

HTTP `406` with JSON-RPC error `-32000 "Not Acceptable: Client must accept both application/json and text/event-stream"`. (Confirms the client-header contract; not a server bug.)

---

### TC-010: Unsupported HTTP method on /mcp

**Priority:** Low
**Type:** Negative

**Steps:**

1. Send `PUT` (or `PATCH`) to `http://localhost:<port>/mcp`.

**Expected result:**

HTTP `405` (method not allowed) from the SDK. `GET`/`DELETE` are handled by the SDK (SSE stream / `200`), only genuinely unsupported methods return `405`.

---

## Test Data (based on test design techniques)

### Positive

* Valid `initialize` with `Accept: application/json, text/event-stream`, `protocolVersion: 2025-06-18`.
* Two independent clients (no shared `mcp-session-id`).
* `MCP_PORT` default `3100` and a custom valid port (`1234`).

### Negative

* `initialize` POST missing `text/event-stream` in `Accept` → `406`.
* `PUT /mcp` → `405`.
* `GET /unknown` → `404`.
