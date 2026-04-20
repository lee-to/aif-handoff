import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createBrokerRuntime } from "../loginBroker.js";

/**
 * Lightweight stub for a spawned child process. We only emit the events the
 * broker actually listens for (data on stdout, exit).
 */
function createStubChild(authUrl: string): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
  const stdout = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdout"];
  const stderr = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stderr"];
  (proc as unknown as { stdout: typeof stdout }).stdout = stdout;
  (proc as unknown as { stderr: typeof stderr }).stderr = stderr;
  (proc as unknown as { killed: boolean }).killed = false;
  (proc as unknown as { exitCode: number | null }).exitCode = null;
  (proc as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => {
    (proc as unknown as { killed: boolean }).killed = true;
    return true;
  });

  // Emit the auth URL on next tick so the async listener has time to subscribe.
  queueMicrotask(() => stdout.emit("data", Buffer.from(`Visit ${authUrl}\n`)));

  return proc as ChildProcessWithoutNullStreams;
}

describe("loginBroker callback integration", () => {
  let loopback: Server;
  let loopbackPort = 0;
  let loopbackHits: Array<{ path: string | undefined; query: string | undefined }> = [];

  beforeEach(async () => {
    loopbackHits = [];
    loopback = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      loopbackHits.push({ path: url.pathname, query: url.search });
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
    loopbackPort = (loopback.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
  });

  it("completes the flow: start → callback → child exit → 200", async () => {
    const authUrl = `https://chatgpt.com/auth/authorize?client_id=abc&state=S1`;
    const stub = createStubChild(authUrl);

    const runtime = createBrokerRuntime({
      loopbackHost: "127.0.0.1",
      loopbackPort,
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    const startRes = await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as { sessionId: string; authUrl: string };
    expect(startBody.authUrl).toBe(authUrl);

    // Schedule the child to exit shortly after we fire the callback, simulating
    // the real codex CLI writing ~/.codex/auth.json and then exiting.
    const callbackUrl = `http://127.0.0.1:${loopbackPort}/?code=CODE&state=S1`;
    setTimeout(() => {
      (stub as unknown as { exitCode: number | null }).exitCode = 0;
      stub.emit("exit", 0, null);
    }, 50);

    const cbRes = await runtime.app.request("/codex/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: callbackUrl }),
    });
    expect(cbRes.status).toBe(200);
    const cbBody = (await cbRes.json()) as { ok: boolean };
    expect(cbBody.ok).toBe(true);

    expect(loopbackHits).toHaveLength(1);
    expect(loopbackHits[0]?.query).toContain("code=CODE");
    expect(loopbackHits[0]?.query).toContain("state=S1");

    // Session is cleared after success.
    expect(runtime.getCurrentSession()).toBeNull();
  });

  it("rejects callback with a mismatched state", async () => {
    const authUrl = `https://chatgpt.com/auth/authorize?state=REAL`;
    const stub = createStubChild(authUrl);

    const runtime = createBrokerRuntime({
      loopbackHost: "127.0.0.1",
      loopbackPort,
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });

    const cbRes = await runtime.app.request("/codex/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${loopbackPort}/?code=c&state=WRONG` }),
    });
    expect(cbRes.status).toBe(400);
    const body = (await cbRes.json()) as { reason: string };
    expect(body.reason).toBe("state_mismatch");

    // Session is still active — callback failure shouldn't terminate it.
    expect(runtime.getCurrentSession()).not.toBeNull();
  });

  it("returns 409 when a session is already active", async () => {
    const stub = createStubChild(`https://chatgpt.com/auth/authorize?state=X`);
    const runtime = createBrokerRuntime({
      loopbackHost: "127.0.0.1",
      loopbackPort,
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });
    const second = await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(second.status).toBe(409);
  });

  it("cancel clears the active session", async () => {
    const stub = createStubChild(`https://chatgpt.com/auth/authorize?state=X`);
    const runtime = createBrokerRuntime({
      loopbackHost: "127.0.0.1",
      loopbackPort,
      spawnFn: vi.fn(() => stub) as unknown as typeof import("node:child_process").spawn,
    });

    await runtime.app.request("/codex/login/start", { method: "POST" });
    expect(runtime.getCurrentSession()).not.toBeNull();
    const cancelRes = await runtime.app.request("/codex/login/cancel", { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(runtime.getCurrentSession()).toBeNull();
  });
});
