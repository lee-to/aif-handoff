import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock getEnv before importing
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://test:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

const { loadMcpEnv } = await import("../env.js");

describe("loadMcpEnv", () => {
  beforeEach(() => {
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_RATE_LIMIT_READ_RPM;
    delete process.env.MCP_RATE_LIMIT_WRITE_RPM;
    delete process.env.MCP_RATE_LIMIT_READ_BURST;
    delete process.env.MCP_RATE_LIMIT_WRITE_BURST;
  });

  it("returns default rate limit values", () => {
    const env = loadMcpEnv();
    expect(env.rateLimitReadRpm).toBe(120);
    expect(env.rateLimitWriteRpm).toBe(30);
    expect(env.rateLimitReadBurst).toBe(10);
    expect(env.rateLimitWriteBurst).toBe(5);
  });

  it("reads API URL from shared env", () => {
    const env = loadMcpEnv();
    expect(env.apiUrl).toBe("http://test:3009");
  });

  it("uses the default MCP port when MCP_PORT is unset", () => {
    const env = loadMcpEnv();
    expect(env.httpPort).toBe(3100);
  });

  it("trims and parses a valid MCP_PORT override", () => {
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_PORT = " 3200 ";

    const env = loadMcpEnv();
    expect(env.transport).toBe("http");
    expect(env.httpPort).toBe(3200);
  });

  it("reads custom rate limits from env vars", () => {
    process.env.MCP_RATE_LIMIT_READ_RPM = "200";
    process.env.MCP_RATE_LIMIT_WRITE_RPM = "50";
    process.env.MCP_RATE_LIMIT_READ_BURST = "20";
    process.env.MCP_RATE_LIMIT_WRITE_BURST = "8";

    const env = loadMcpEnv();
    expect(env.rateLimitReadRpm).toBe(200);
    expect(env.rateLimitWriteRpm).toBe(50);
    expect(env.rateLimitReadBurst).toBe(20);
    expect(env.rateLimitWriteBurst).toBe(8);
  });

  it.each(["3100abc", "0", "-1", "70000"])(
    "ignores invalid MCP_PORT value %s in stdio mode",
    (value) => {
      process.env.MCP_PORT = value;

      const env = loadMcpEnv();
      expect(env.transport).toBe("stdio");
      expect(env.httpPort).toBe(3100);
    },
  );

  it.each(["3100abc", "0", "-1", "70000"])(
    "throws on invalid MCP_PORT value %s in http mode",
    (value) => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_PORT = value;
      expect(() => loadMcpEnv()).toThrow(
        `Invalid MCP_PORT: ${value}. Must be an integer between 1 and 65535.`,
      );
    },
  );
});
