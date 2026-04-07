import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const { existsSyncMock, execFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const originalEnv = { ...process.env };

async function loadFindClaudePath() {
  const mod = await import("../adapters/claude/findPath.js");
  return mod.findClaudePath;
}

function getPlatformCandidates(env: NodeJS.ProcessEnv): string[] {
  const homeDir = env.HOME ?? env.USERPROFILE ?? "";
  if (process.platform === "win32") {
    return [
      resolve(env.APPDATA ?? "", "npm/claude.cmd"),
      resolve(env.LOCALAPPDATA ?? "", "npm/claude.cmd"),
      resolve(homeDir, "scoop/shims/claude.cmd"),
      resolve(homeDir, ".local/bin/claude.cmd"),
    ];
  }
  return [
    "/usr/local/bin/claude",
    resolve(homeDir, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    resolve(homeDir, ".npm-global/bin/claude"),
    "/usr/bin/claude",
  ];
}

describe("findClaudePath", () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    execFileSyncMock.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns first platform candidate when it exists", async () => {
    process.env.HOME = "/tmp/aif-home";
    process.env.USERPROFILE = "/tmp/aif-user";
    process.env.APPDATA = "/tmp/aif-appdata";
    process.env.LOCALAPPDATA = "/tmp/aif-localappdata";
    const [firstCandidate] = getPlatformCandidates(process.env);
    existsSyncMock.mockImplementation((path) => path === firstCandidate);

    const findClaudePath = await loadFindClaudePath();
    expect(findClaudePath()).toBe(firstCandidate);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("uses PATH fallback and returns discovered path", async () => {
    process.env.HOME = "/tmp/aif-home";
    const discovered = resolve("/tmp/bin", process.platform === "win32" ? "claude.cmd" : "claude");
    existsSyncMock.mockImplementation((path) => path === discovered);
    execFileSyncMock.mockReturnValue(`"${discovered}"\n`);

    const findClaudePath = await loadFindClaudePath();
    expect(findClaudePath()).toBe(discovered);
  });

  it("returns undefined when nothing found", async () => {
    process.env.HOME = "/tmp/aif-home";
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const findClaudePath = await loadFindClaudePath();
    expect(findClaudePath()).toBeUndefined();
  });
});
