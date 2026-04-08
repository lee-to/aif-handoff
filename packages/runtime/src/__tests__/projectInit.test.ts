import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRegistry } from "../registry.js";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

const { initProject } = await import("../projectInit.js");

function createMockRegistry(
  runtimeIds: string[] = ["claude", "codex"],
  overrides?: Record<string, { supportsProjectInit?: boolean }>,
): RuntimeRegistry {
  return {
    resolveRuntime: vi.fn(),
    listRuntimes: vi.fn(() =>
      runtimeIds.map((id) => ({
        id,
        providerId: id,
        displayName: id,
        capabilities: {},
        supportsProjectInit: overrides?.[id]?.supportsProjectInit ?? true,
      })),
    ),
    registerRuntimeModule: vi.fn(),
  } as unknown as RuntimeRegistry;
}

describe("initProject (runtime)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "aif-runtime-init-"));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("runs ai-factory init when .ai-factory/ does not exist", () => {
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["ai-factory", "init", "--agents", "claude,codex"],
      expect.objectContaining({ cwd: projectRoot, timeout: 60_000 }),
    );
  });

  it("skips ai-factory init when .ai-factory/ already exists", () => {
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns error when ai-factory init fails", () => {
    const registry = createMockRegistry();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("npx: command not found");
    });

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ai-factory init");
    expect(result.error).toContain("npx: command not found");
    // .ai-factory/ should NOT exist so retry is possible
    expect(existsSync(join(projectRoot, ".ai-factory"))).toBe(false);
  });

  it("filters runtimes by runtimeIds option", () => {
    const registry = createMockRegistry(["claude", "codex", "openrouter"], {
      openrouter: { supportsProjectInit: false },
    });

    initProject({ projectRoot, registry, runtimeIds: ["claude"] });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["ai-factory", "init", "--agents", "claude"],
      expect.any(Object),
    );
  });

  it("excludes runtimes without supportsProjectInit", () => {
    const registry = createMockRegistry(["claude", "codex", "openrouter"], {
      openrouter: { supportsProjectInit: false },
    });

    initProject({ projectRoot, registry });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "npx",
      ["ai-factory", "init", "--agents", "claude,codex"],
      expect.any(Object),
    );
  });

  it("skips ai-factory init when all runtimes lack supportsProjectInit", () => {
    const registry = createMockRegistry(["openrouter"], {
      openrouter: { supportsProjectInit: false },
    });

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("skips ai-factory init when no runtimes match", () => {
    const registry = createMockRegistry([]);

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
