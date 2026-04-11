import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeMcpInput, RuntimeMcpInstallInput, RuntimeMcpStatus } from "../../types.js";

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readConfig(): Promise<ClaudeConfig> {
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: ClaudeConfig): Promise<void> {
  await writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function getClaudeMcpStatus(input: RuntimeMcpInput): Promise<RuntimeMcpStatus> {
  const config = await readConfig();
  const servers = config.mcpServers ?? {};
  const installed = input.serverName in servers;
  return {
    installed,
    serverName: input.serverName,
    config: installed ? (servers[input.serverName] as Record<string, unknown>) : null,
  };
}

export async function installClaudeMcpServer(input: RuntimeMcpInstallInput): Promise<void> {
  const config = await readConfig();
  if (!config.mcpServers) config.mcpServers = {};

  if (input.transport === "streamable_http") {
    config.mcpServers[input.serverName] = {
      type: "http",
      url: input.url,
    };
  } else {
    config.mcpServers[input.serverName] = {
      type: "stdio",
      command: input.command,
      args: input.args ?? [],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.env ? { env: input.env } : {}),
    };
  }
  await writeConfig(config);
}

export async function uninstallClaudeMcpServer(input: RuntimeMcpInput): Promise<void> {
  const config = await readConfig();
  if (config.mcpServers && input.serverName in config.mcpServers) {
    delete config.mcpServers[input.serverName];
    await writeConfig(config);
  }
}
