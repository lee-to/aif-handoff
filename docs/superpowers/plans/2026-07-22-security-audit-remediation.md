# Security Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all production vulnerabilities reported by `npm audit` without downgrading MCP or Claude SDK packages.

**Architecture:** Upgrade the direct Hono Node adapter to its patched v2 release and replace the obsolete `@hono/node-ws` bridge with the WebSocket support built into `@hono/node-server`. Use root npm overrides for vulnerable transitive packages whose parents have not yet published refreshed constraints, then synchronize npm and Bun lock files.

**Tech Stack:** npm workspaces, Bun lockfile, TypeScript, Hono, ws, Vitest, GitHub Actions

## Global Constraints

- Keep `@modelcontextprotocol/sdk` at `1.29.0` and `@anthropic-ai/claude-agent-sdk` at `0.2.90`; do not use the breaking downgrades proposed by `npm audit fix --force`.
- Require `@hono/node-server` `2.0.11`, `body-parser` `2.3.0`, `fast-uri` `3.1.4`, and `qs` `6.15.3` or newer compatible patched releases.
- Synchronize both `package-lock.json` and `bun.lock`.
- Preserve the existing WebSocket route and graceful-shutdown behavior.
- Run `npm run ai:validate` after implementation.

---

### Task 1: Prove the WebSocket bootstrap migration

**Files:**

- Modify: `packages/api/src/__tests__/serverBootstrap.test.ts`
- Test: `packages/api/src/__tests__/serverBootstrap.test.ts`

**Interfaces:**

- Consumes: `startServer(options)` from `packages/api/src/serverBootstrap.ts`
- Produces: a failing expectation that the supplied `WebSocketServer` is passed to `createAdaptorServer`

- [x] **Step 1: Replace the injection expectation with the v2 adapter contract**

```ts
const webSocketServer = { options: { noServer: true } };

startServer({
  fetch: vi.fn(),
  port: 3009,
  webSocketServer,
  onStarted,
  logger,
});

expect(createAdaptorServerMock).toHaveBeenCalledWith({
  fetch: expect.any(Function),
  hostname: undefined,
  websocket: { server: webSocketServer },
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npm test --workspace=@aif/api -- src/__tests__/serverBootstrap.test.ts`

Expected: FAIL because the current implementation ignores `webSocketServer` and still accepts `injectWebSocket`.

### Task 2: Migrate to the patched Hono Node adapter

**Files:**

- Modify: `packages/api/src/ws.ts`
- Modify: `packages/api/src/serverBootstrap.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/__tests__/serverBootstrap.test.ts`
- Modify: `packages/api/package.json`
- Modify: `packages/agent/package.json`

**Interfaces:**

- Consumes: `upgradeWebSocket` and `createAdaptorServer` from `@hono/node-server`
- Produces: `setupWebSocket(app)` returning a no-server `WebSocketServer`, and `startServer` passing it as `websocket.server`

- [x] **Step 1: Replace `@hono/node-ws` with built-in Hono v2 WebSocket support**

```ts
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";

export function setupWebSocket(app: Hono) {
  const webSocketServer = new WebSocketServer({ noServer: true });
  return { webSocketServer, upgradeWebSocket };
}
```

Keep the existing `/ws` handlers unchanged and register them with the imported `upgradeWebSocket` function.

- [x] **Step 2: Pass the WebSocket server through adapter options**

```ts
const server = createAdaptorServer({
  fetch,
  hostname,
  ...(webSocketServer ? { websocket: { server: webSocketServer } } : {}),
});
```

- [x] **Step 3: Upgrade direct package constraints**

Set `@hono/node-server` to `2.0.11` in API and agent manifests and remove `@hono/node-ws` from the API manifest.

- [x] **Step 4: Run the targeted API tests and verify GREEN**

Run: `npm test --workspace=@aif/api -- src/__tests__/serverBootstrap.test.ts`

Expected: PASS.

### Task 3: Pin safe transitive dependencies and synchronize locks

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `bun.lock`

**Interfaces:**

- Consumes: npm override resolution
- Produces: a dependency tree with no versions affected by the reported advisories

- [x] **Step 1: Add root overrides**

```json
"overrides": {
  "@hono/node-server": "2.0.11",
  "body-parser": "2.3.0",
  "fast-uri": "3.1.4",
  "qs": "6.15.3"
}
```

- [x] **Step 2: Regenerate the npm lock and install tree**

Run: `npm install`

Expected: install succeeds without peer-dependency errors.

- [x] **Step 3: Regenerate the Bun lock**

Run: `bun install --lockfile-only --ignore-scripts`

Expected: `bun.lock` resolves the same safe versions.

- [x] **Step 4: Verify the resolved tree**

Run: `npm ls @hono/node-server @hono/node-ws body-parser fast-uri qs --all`

Expected: no `@hono/node-ws`; all listed packages resolve to patched versions.

### Task 4: Validate the security fix and repository

**Files:**

- Verify: `CHECKLIST.md`
- Verify: `packages/api/CHECKLIST.md`
- Verify: `packages/agent/CHECKLIST.md`
- Verify: `packages/mcp/CHECKLIST.md`
- Verify: `packages/runtime/CHECKLIST.md`

**Interfaces:**

- Consumes: the final manifests, lockfiles, and WebSocket bootstrap
- Produces: evidence that CI's audit command and repository validation pass

- [x] **Step 1: Re-run the blocking audit command**

Run: `npm audit --omit=dev --audit-level=high`

Expected: exit code 0 and zero production vulnerabilities.

- [x] **Step 2: Run API tests**

Run: `npm test --workspace=@aif/api`

Expected: PASS.

- [x] **Step 3: Run full validation**

Run: `npm run ai:validate`

Expected: PASS, or report an environment-only gate separately with its exact output.

- [x] **Step 4: Review the diff and checklists**

Run: `git diff --check`

Expected: no output and exit code 0.
