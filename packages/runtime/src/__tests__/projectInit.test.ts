import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRegistry } from "../registry.js";

const execFileSyncMock = vi.fn();
const aiFactoryResolveMock = vi.fn();
const initBaseProjectDirectoryMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: () => ({
      resolve: (...args: unknown[]) => aiFactoryResolveMock(...args),
    }),
  };
});

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    initBaseProjectDirectory: (...args: unknown[]) => initBaseProjectDirectoryMock(...args),
  };
});

const { initProject } = await import("../projectInit.js");

function createMockRegistry(
  runtimeIds: string[] = ["claude", "codex"],
  overrides?: Record<string, { supportsProjectInit?: boolean; projectInitAgentName?: string }>,
): RuntimeRegistry {
  return {
    resolveRuntime: vi.fn(),
    listRuntimes: vi.fn(() =>
      runtimeIds.map((id) => {
        const override = overrides?.[id];
        const hasAgentNameOverride = Object.prototype.hasOwnProperty.call(
          override ?? {},
          "projectInitAgentName",
        );

        return {
          id,
          providerId: id,
          displayName: id,
          capabilities: {},
          supportsProjectInit: override?.supportsProjectInit ?? true,
          projectInitAgentName: hasAgentNameOverride
            ? override?.projectInitAgentName
            : override?.supportsProjectInit === false
              ? undefined
              : id,
        };
      }),
    ),
    registerRuntimeModule: vi.fn(),
  } as unknown as RuntimeRegistry;
}

describe("initProject (runtime)", () => {
  let projectRoot: string;

  /** Configure execFileSyncMock to return a version string for --version calls. */
  function mockAiFactoryVersion(version: string): void {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("--version")) return version;
      return undefined;
    });
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "aif-runtime-init-"));
    execFileSyncMock.mockReset();
    aiFactoryResolveMock.mockReset();
    initBaseProjectDirectoryMock.mockReset();
    aiFactoryResolveMock.mockReturnValue("C:\\fake\\ai-factory\\bin\\ai-factory.js");
    // Default: version below threshold — no --config
    mockAiFactoryVersion("2.9.2");
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("runs ai-factory init when .ai-factory/ does not exist", () => {
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude,codex"],
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
      throw new Error("ai-factory init exited with code 1");
    });

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ai-factory init");
    expect(result.error).toContain("ai-factory init exited with code 1");
    // .ai-factory/ should NOT exist so retry is possible
    expect(existsSync(join(projectRoot, ".ai-factory"))).toBe(false);
  });

  it("filters runtimes by runtimeIds option", () => {
    const registry = createMockRegistry(["claude", "codex", "openrouter"], {
      openrouter: { supportsProjectInit: false },
    });

    initProject({ projectRoot, registry, runtimeIds: ["claude"] });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude"],
      expect.any(Object),
    );
  });

  it("excludes runtimes without supportsProjectInit", () => {
    const registry = createMockRegistry(["claude", "codex", "openrouter"], {
      openrouter: { supportsProjectInit: false },
    });

    initProject({ projectRoot, registry });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude,codex"],
      expect.any(Object),
    );
  });

  it("skips runtimes without projectInitAgentName even if supportsProjectInit is true", () => {
    const registry = createMockRegistry(["claude", "openrouter"], {
      openrouter: { supportsProjectInit: true, projectInitAgentName: undefined },
    });

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude"],
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

  it("adds --config flag when ai-factory version >= 2.9.3", () => {
    mockAiFactoryVersion("2.9.3");
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude,codex", "--config"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  it("omits --config flag when ai-factory version < 2.9.3", () => {
    mockAiFactoryVersion("2.9.2");
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude,codex"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  it("adds --config flag for higher versions like 3.0.0", () => {
    mockAiFactoryVersion("3.0.0");
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--config"]),
      expect.any(Object),
    );
  });

  it("omits --config flag when version check fails", () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "npx" && args.includes("--version")) throw new Error("not found");
      return undefined;
    });
    const registry = createMockRegistry();

    const result = initProject({ projectRoot, registry });

    expect(result.ok).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.execPath,
      ["C:\\fake\\ai-factory\\bin\\ai-factory.js", "init", "--agents", "claude,codex"],
      expect.objectContaining({ cwd: projectRoot }),
    );
  });
});
