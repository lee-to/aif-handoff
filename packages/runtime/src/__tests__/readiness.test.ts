import { describe, expect, it, vi } from "vitest";
import { checkRuntimeReadiness } from "../readiness.js";
import { createRuntimeRegistry } from "../registry.js";
import type { RuntimeAdapter } from "../types.js";
import { DEFAULT_RUNTIME_CAPABILITIES } from "../types.js";

function makeAdapter(overrides: Partial<RuntimeAdapter> & { id?: string } = {}): RuntimeAdapter {
  const id = overrides.id ?? "test-runtime";
  return {
    descriptor: {
      id,
      providerId: "test-provider",
      displayName: "Test Runtime",
      capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
    },
    run: vi.fn().mockResolvedValue({ outputText: "ok" }),
    ...overrides,
  } as RuntimeAdapter;
}

describe("checkRuntimeReadiness", () => {
  it("returns not ready when no runtimes registered", async () => {
    const registry = createRuntimeRegistry();
    const result = await checkRuntimeReadiness({ registry });

    expect(result.ready).toBe(false);
    expect(result.runtimeCount).toBe(0);
    expect(result.runtimes).toHaveLength(0);
    expect(result.message).toContain("No runtimes");
  });

  it("returns ready when adapter has no validateConnection (assumes ok)", async () => {
    const registry = createRuntimeRegistry();
    registry.registerRuntime(makeAdapter());

    const result = await checkRuntimeReadiness({ registry });

    expect(result.ready).toBe(true);
    expect(result.runtimeCount).toBe(1);
    expect(result.runtimes[0].validation.ok).toBe(true);
  });

  it("returns ready when validateConnection passes", async () => {
    const registry = createRuntimeRegistry();
    registry.registerRuntime(
      makeAdapter({
        validateConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected" }),
      }),
    );

    const result = await checkRuntimeReadiness({ registry });

    expect(result.ready).toBe(true);
    expect(result.runtimes[0].validation.message).toBe("Connected");
  });

  it("returns not ready when validateConnection fails", async () => {
    const registry = createRuntimeRegistry();
    registry.registerRuntime(
      makeAdapter({
        validateConnection: vi.fn().mockResolvedValue({ ok: false, message: "No API key" }),
      }),
    );

    const result = await checkRuntimeReadiness({ registry });

    expect(result.ready).toBe(false);
    expect(result.runtimes[0].validation.ok).toBe(false);
    expect(result.runtimes[0].validation.message).toBe("No API key");
  });

  it("handles validateConnection throwing", async () => {
    const warn = vi.fn();
    const registry = createRuntimeRegistry();
    registry.registerRuntime(
      makeAdapter({
        validateConnection: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
    );

    const result = await checkRuntimeReadiness({
      registry,
      logger: { warn },
    });

    expect(result.ready).toBe(false);
    expect(result.runtimes[0].validation.ok).toBe(false);
    expect(result.runtimes[0].validation.message).toContain("connection refused");
    expect(warn).toHaveBeenCalled();
  });

  it("is ready if at least one of multiple runtimes passes", async () => {
    const registry = createRuntimeRegistry();
    registry.registerRuntime(
      makeAdapter({
        id: "failing",
        validateConnection: vi.fn().mockResolvedValue({ ok: false, message: "No key" }),
      }),
    );
    registry.registerRuntime(
      makeAdapter({
        id: "passing",
        validateConnection: vi.fn().mockResolvedValue({ ok: true, message: "OK" }),
      }),
    );

    const result = await checkRuntimeReadiness({ registry });

    expect(result.ready).toBe(true);
    expect(result.runtimeCount).toBe(2);
    expect(result.runtimes.find((r) => r.runtimeId === "failing")?.validation.ok).toBe(false);
    expect(result.runtimes.find((r) => r.runtimeId === "passing")?.validation.ok).toBe(true);
  });

  it("includes capabilities and display name in entries", async () => {
    const registry = createRuntimeRegistry();
    registry.registerRuntime(makeAdapter());

    const result = await checkRuntimeReadiness({ registry });

    expect(result.runtimes[0].displayName).toBe("Test Runtime");
    expect(result.runtimes[0].capabilities).toEqual(DEFAULT_RUNTIME_CAPABILITIES);
  });

  it("populates checkedAt timestamp", async () => {
    const registry = createRuntimeRegistry();
    const result = await checkRuntimeReadiness({ registry });

    expect(result.checkedAt).toBeTruthy();
    expect(() => new Date(result.checkedAt)).not.toThrow();
  });
});
