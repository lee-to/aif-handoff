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
  const mod = await import("../findClaudePath.js");
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
    resolve(homeDir, ".local/bin/claude"),
    "/usr/local/bin/claude",
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
    expect(firstCandidate).toBeDefined();
    existsSyncMock.mockImplementation((path) => path === firstCandidate);

    const findClaudePath = await loadFindClaudePath();
    const result = findClaudePath();

    expect(result).toBe(firstCandidate);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("uses USERPROFILE-derived candidate when HOME is missing", async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "/tmp/aif-user";
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    const candidates = getPlatformCandidates(process.env);
    const userProfileCandidate = process.platform === "win32" ? candidates[2] : candidates[0];
    expect(userProfileCandidate).toBeDefined();
    existsSyncMock.mockImplementation((path) => path === userProfileCandidate);

    const findClaudePath = await loadFindClaudePath();
    const result = findClaudePath();

    expect(result).toBe(userProfileCandidate);
  });

  it("uses PATH fallback command and returns discovered path", async () => {
    process.env.HOME = "/tmp/aif-home";
    const discoveredPath = resolve(
      "/tmp/bin",
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    existsSyncMock.mockImplementation((path) => path === discoveredPath);
    execFileSyncMock.mockReturnValue(`"${discoveredPath}"\n`);

    const findClaudePath = await loadFindClaudePath();
    const result = findClaudePath();
    const expectedCommand = process.platform === "win32" ? "where" : "which";

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expectedCommand,
      ["claude"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      }),
    );
    expect(result).toBe(discoveredPath);
  });

  it("returns undefined when fallback output has no existing path", async () => {
    process.env.HOME = "/tmp/aif-home";
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockReturnValue("/missing/claude\n");

    const findClaudePath = await loadFindClaudePath();
    const result = findClaudePath();

    expect(result).toBeUndefined();
  });

  it("returns undefined when fallback command throws", async () => {
    process.env.HOME = "/tmp/aif-home";
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockImplementation(() => {
      throw new Error("which not available");
    });

    const findClaudePath = await loadFindClaudePath();
    const result = findClaudePath();

    expect(result).toBeUndefined();
  });
});
