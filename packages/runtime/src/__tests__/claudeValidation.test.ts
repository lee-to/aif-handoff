import { describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../types.js";

// Mock the CLI probe so tests don't depend on `claude` being installed
vi.mock("../adapters/claude/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/claude/cli.js")>();
  return {
    ...actual,
    probeClaudeCli: vi.fn(() => ({ ok: true, version: "1.0.0-mock" })),
  };
});

const { createClaudeRuntimeAdapter } = await import("../adapters/claude/index.js");

describe("Claude adapter validateConnection", () => {
  const adapter = createClaudeRuntimeAdapter();
  const validate = adapter.validateConnection!;

  const base = { runtimeId: "claude", providerId: "anthropic" };

  it("SDK transport passes without API key (session auth)", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.SDK,
      options: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("session auth");
  });

  it("SDK transport passes with API key", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.SDK,
      options: { apiKey: "sk-test" },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("API key");
  });

  it("SDK transport is the default when transport is omitted", async () => {
    const result = await validate({ ...base, options: {} });
    expect(result.ok).toBe(true);
  });

  it("CLI transport passes when probe succeeds", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.CLI,
      options: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("CLI");
  });

  it("CLI transport reports version from probe", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.CLI,
      options: {},
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1.0.0-mock");
  });

  it("CLI transport fails when binary is not reachable", async () => {
    const { probeClaudeCli } = await import("../adapters/claude/cli.js");
    (probeClaudeCli as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ok: false,
      error: "spawn __bad__ ENOENT",
    });

    const result = await validate({
      ...base,
      transport: RuntimeTransport.CLI,
      options: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not reachable");
  });

  it("API transport fails without API key", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.API,
      options: { baseUrl: "https://proxy.example.com" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing API key");
  });

  it("API transport fails without base URL", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.API,
      options: { apiKey: "sk-test" },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing base URL");
  });

  it("API transport fails with both missing", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.API,
      options: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing API key");
    expect(result.message).toContain("Missing base URL");
  });

  it("API transport passes with key + base URL", async () => {
    const result = await validate({
      ...base,
      transport: RuntimeTransport.API,
      options: { apiKey: "sk-test", baseUrl: "https://proxy.example.com" },
    });
    expect(result.ok).toBe(true);
  });
});
