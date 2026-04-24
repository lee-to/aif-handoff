import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { codexAuthRouter } = await import("../routes/codexAuth.js");

function createApp() {
  const app = new Hono();
  app.route("/codex-auth", codexAuthRouter);
  return app;
}

describe("codexAuthRouter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies login status requests to the broker", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: vi.fn().mockResolvedValue({ connected: true }),
    } as unknown as Response);

    const res = await app.request("/codex-auth/login/status");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(fetchMock).toHaveBeenCalledWith("http://agent:3010/codex/login/status", {
      method: "GET",
      headers: undefined,
      body: undefined,
    });
  });

  it("returns broker_unreachable when login start proxy call fails", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.request("/codex-auth/login/start", { method: "POST" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: "broker_unreachable",
      }),
    );
  });

  it("forwards callback payload to broker and tolerates non-JSON broker body", async () => {
    const app = createApp();
    const fetchMock = vi.mocked(global.fetch);
    const brokerJson = vi.fn().mockRejectedValue(new Error("invalid json"));
    fetchMock.mockResolvedValueOnce({
      status: 504,
      json: brokerJson,
    } as unknown as Response);

    const payload = {
      url: "http://127.0.0.1:1455/?code=abc&state=xyz",
    };
    const res = await app.request("/codex-auth/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({});
    expect(fetchMock).toHaveBeenCalledWith("http://agent:3010/codex/login/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("reports login-proxy capabilities from environment defaults", async () => {
    const app = createApp();

    const res = await app.request("/codex-auth/capabilities");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      loginProxyEnabled: false,
      loopbackPort: 1455,
    });
  });
});
