import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const mkdirMock = vi.fn();
const existsSyncMock = vi.fn();
const homedirMock = vi.fn(() => "C:\\Users\\Daniil");

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => homedirMock(),
}));

const { getCodexMcpStatus, installCodexMcpServer, uninstallCodexMcpServer } =
  await import("../adapters/codex/mcp.js");

describe("Codex MCP config", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
    existsSyncMock.mockReset();
    readFileMock.mockRejectedValue(new Error("missing"));
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    existsSyncMock.mockReturnValue(true);
  });

  it("escapes Windows paths in args when writing TOML", async () => {
    await installCodexMcpServer({
      serverName: "handoff",
      command: "npx",
      args: [
        "tsx",
        "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff\\packages\\mcp\\src\\index.ts",
      ],
      cwd: "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff",
      env: {
        DATABASE_URL: "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff\\data\\aif.sqlite",
        GREETING: "Привет 👋",
        LOG_DESTINATION: "stderr",
      },
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(content).toContain(
      'args = [ "tsx", "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff\\\\packages\\\\mcp\\\\src\\\\index.ts" ]',
    );
    expect(content).toContain('cwd = "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff"');
    expect(content).toContain("[mcp_servers.handoff.env]");
    expect(content).toContain(
      'DATABASE_URL = "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff\\\\data\\\\aif.sqlite"',
    );
    expect(content).toContain('GREETING = "Привет 👋"');
    expect(content).toContain('LOG_DESTINATION = "stderr"');
  });

  it("reads escaped Windows paths back from TOML", async () => {
    readFileMock.mockResolvedValue(`[mcp_servers.handoff]
command = "npx"
args = [ "tsx", "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff\\\\packages\\\\mcp\\\\src\\\\index.ts" ]
cwd = "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff"

[mcp_servers.handoff.env]
DATABASE_URL = "E:\\\\Users\\\\Daniil\\\\PhpstormProjects\\\\aif-handoff\\\\data\\\\aif.sqlite"
GREETING = "Привет 👋"
LOG_DESTINATION = "stderr"
`);

    const status = await getCodexMcpStatus({ serverName: "handoff" });

    expect(status.installed).toBe(true);
    expect(status.config).toEqual({
      command: "npx",
      args: [
        "tsx",
        "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff\\packages\\mcp\\src\\index.ts",
      ],
      cwd: "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff",
      env: {
        DATABASE_URL: "E:\\Users\\Daniil\\PhpstormProjects\\aif-handoff\\data\\aif.sqlite",
        GREETING: "Привет 👋",
        LOG_DESTINATION: "stderr",
      },
    });
  });

  it("reads multiline args arrays back from TOML", async () => {
    readFileMock.mockResolvedValue(`[mcp_servers.handoff]
command = "npx"
args = [
  "tsx",
  "C:\\\\projects\\\\aifhub\\\\aif-handoff\\\\packages\\\\mcp\\\\src\\\\index.ts",
]
cwd = "C:\\\\projects\\\\aifhub\\\\aif-handoff"
`);

    const status = await getCodexMcpStatus({ serverName: "handoff" });

    expect(status.installed).toBe(true);
    expect(status.config).toEqual({
      command: "npx",
      args: ["tsx", "C:\\projects\\aifhub\\aif-handoff\\packages\\mcp\\src\\index.ts"],
      cwd: "C:\\projects\\aifhub\\aif-handoff",
    });
  });

  it("ignores env subsections whose server names do not match the main section syntax", async () => {
    readFileMock.mockResolvedValue(`[mcp_servers.foo.bar.env]
TOKEN = "secret"
`);

    const status = await getCodexMcpStatus({ serverName: "foo.bar" });

    expect(status.installed).toBe(false);
    expect(status.config).toBeNull();
  });

  it("removes the full server block without leaving args array fragments", async () => {
    readFileMock.mockResolvedValue(`[mcp_servers.yougile]
command = "node"
args = [ "C:\\\\projects\\\\yougile-mcp\\\\yougile.cjs" ]

[mcp_servers.handoff]
command = "npx"
args = [ "tsx", "C:\\\\projects\\\\aifhub\\\\aif-handoff\\\\packages\\\\mcp\\\\src\\\\index.ts" ]
cwd = "C:\\\\projects\\\\aifhub\\\\aif-handoff"

[mcp_servers.handoff.env]
DATABASE_URL = "C:\\\\projects\\\\aifhub\\\\aif-handoff\\\\data\\\\aif.sqlite"
LOG_DESTINATION = "stderr"

[plugins."github@openai-curated"]
enabled = true
`);

    await uninstallCodexMcpServer({ serverName: "handoff" });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(content).toContain("[mcp_servers.yougile]");
    expect(content).toContain('[plugins."github@openai-curated"]');
    expect(content).not.toContain("[mcp_servers.handoff]");
    expect(content).not.toContain("[mcp_servers.handoff.env]");
    expect(content).not.toContain('args = [ "tsx"');
    expect(content).not.toContain('cwd = "C:\\\\projects\\\\aifhub\\\\aif-handoff"');
    expect(content).not.toContain("\n\n\n");
  });
});
