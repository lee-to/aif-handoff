import { describe, expect, it, vi } from "vitest";
import { bootstrapRuntimeRegistry } from "../bootstrap.js";

describe("bootstrapRuntimeRegistry", () => {
  it("creates registry with built-in claude and codex adapters", async () => {
    const registry = await bootstrapRuntimeRegistry();
    const runtimes = registry.listRuntimes();

    expect(runtimes.length).toBeGreaterThanOrEqual(2);
    expect(runtimes.find((r) => r.id === "claude")).toBeDefined();
    expect(runtimes.find((r) => r.id === "codex")).toBeDefined();
  });

  it("claude adapter has expected capabilities", async () => {
    const registry = await bootstrapRuntimeRegistry();
    const claude = registry.resolveRuntime("claude");

    expect(claude.descriptor.capabilities.supportsResume).toBe(true);
    expect(claude.descriptor.capabilities.supportsSessionList).toBe(true);
    expect(claude.descriptor.capabilities.supportsAgentDefinitions).toBe(true);
    expect(claude.descriptor.lightModel).toBe("haiku");
  });

  it("codex adapter has expected capabilities", async () => {
    const registry = await bootstrapRuntimeRegistry();
    const codex = registry.resolveRuntime("codex");

    expect(codex.descriptor.capabilities.supportsResume).toBe(false);
    expect(codex.descriptor.capabilities.supportsSessionList).toBe(false);
    expect(codex.descriptor.lightModel).toBeNull();
  });

  it("passes logger to registry", async () => {
    const warn = vi.fn();
    const registry = await bootstrapRuntimeRegistry({
      logger: { debug: vi.fn(), warn },
    });

    expect(registry.listRuntimes().length).toBeGreaterThanOrEqual(2);
  });

  it("continues when a runtime module fails to load", async () => {
    const warn = vi.fn();
    const registry = await bootstrapRuntimeRegistry({
      logger: { debug: vi.fn(), warn },
      runtimeModules: ["nonexistent-module-that-does-not-exist"],
    });

    expect(registry.listRuntimes().length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
  });

  it("returns same adapters on repeated calls (no duplication)", async () => {
    const a = await bootstrapRuntimeRegistry();
    const b = await bootstrapRuntimeRegistry();

    // Each call creates a fresh registry
    expect(a).not.toBe(b);
    expect(a.listRuntimes().length).toBe(b.listRuntimes().length);
  });
});
