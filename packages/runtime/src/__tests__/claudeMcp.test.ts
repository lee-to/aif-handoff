import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const homedirMock = vi.fn(() => "C:\\Users\\Daniil");

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => homedirMock(),
}));

const { getClaudeMcpStatus, installClaudeMcpServer, uninstallClaudeMcpServer } =
  await import("../adapters/claude/mcp.js");

describe("Claude MCP config", () => {
  beforeEach(() => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    readFileMock.mockRejectedValue(new Error("missing"));
    writeFileMock.mockResolvedValue(undefined);
  });

  it("writes stdio MCP servers to .claude.json", async () => {
    await installClaudeMcpServer({
      serverName: "handoff",
      transport: "stdio",
      command: "npx",
      args: ["tsx", "packages/mcp/src/index.ts"],
      cwd: "C:\\projects\\aifhub\\aif-handoff",
      env: {
        DATABASE_URL: "C:\\projects\\aifhub\\aif-handoff\\data\\aif.sqlite",
      },
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        handoff: {
          type: "stdio",
          command: "npx",
          args: ["tsx", "packages/mcp/src/index.ts"],
          cwd: "C:\\projects\\aifhub\\aif-handoff",
          env: {
            DATABASE_URL: "C:\\projects\\aifhub\\aif-handoff\\data\\aif.sqlite",
          },
        },
      },
    });
  });

  it("writes HTTP MCP servers to .claude.json when url is provided", async () => {
    await installClaudeMcpServer({
      serverName: "handoff",
      transport: "streamable_http",
      url: "http://localhost:3100/mcp",
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        handoff: {
          type: "http",
          url: "http://localhost:3100/mcp",
        },
      },
    });
  });

  it("reads HTTP MCP server entries back from .claude.json", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        mcpServers: {
          handoff: {
            type: "http",
            url: "http://localhost:3100/mcp",
          },
        },
      }),
    );

    const status = await getClaudeMcpStatus({ serverName: "handoff" });

    expect(status.installed).toBe(true);
    expect(status.config).toEqual({
      type: "http",
      url: "http://localhost:3100/mcp",
    });
  });

  it("removes MCP servers from .claude.json", async () => {
    readFileMock.mockResolvedValue(
      JSON.stringify({
        mcpServers: {
          handoff: {
            type: "http",
            url: "http://localhost:3100/mcp",
          },
          other: {
            command: "npx",
          },
        },
      }),
    );

    await uninstallClaudeMcpServer({ serverName: "handoff" });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        other: {
          command: "npx",
        },
      },
    });
  });

  it("does not write unsupported bearer token env vars for Claude HTTP MCP servers", async () => {
    await installClaudeMcpServer({
      serverName: "handoff",
      transport: "streamable_http",
      url: "http://localhost:3100/mcp",
      bearerTokenEnvVar: "AIF_MCP_TOKEN",
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(JSON.parse(content)).toEqual({
      mcpServers: {
        handoff: {
          type: "http",
          url: "http://localhost:3100/mcp",
        },
      },
    });
  });
});
