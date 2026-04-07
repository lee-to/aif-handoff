import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { RuntimeMcpInput, RuntimeMcpInstallInput, RuntimeMcpStatus } from "../../types.js";

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

/**
 * Minimal TOML parser/writer for Codex MCP config.
 * Only handles the [mcp_servers.<name>] section format.
 * Does not depend on a full TOML library.
 */

function parseMcpServers(toml: string): Record<string, { command: string; args: string[] }> {
  const servers: Record<string, { command: string; args: string[] }> = {};
  const sectionRegex = /^\[mcp_servers\.([^\]]+)\]\s*$/;
  let currentName: string | null = null;
  let currentCommand = "";
  let currentArgs: string[] = [];

  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    const sectionMatch = sectionRegex.exec(trimmed);
    if (sectionMatch) {
      if (currentName) {
        servers[currentName] = { command: currentCommand, args: currentArgs };
      }
      currentName = sectionMatch[1];
      currentCommand = "";
      currentArgs = [];
      continue;
    }
    if (!currentName) continue;
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, key, rawValue] = kvMatch;
    if (key === "command") {
      currentCommand = rawValue.replace(/^"(.*)"$/, "$1");
    } else if (key === "args") {
      try {
        currentArgs = JSON.parse(rawValue.replace(/'/g, '"'));
      } catch {
        currentArgs = [];
      }
    }
  }
  if (currentName) {
    servers[currentName] = { command: currentCommand, args: currentArgs };
  }
  return servers;
}

function serializeMcpSection(name: string, entry: { command: string; args?: string[] }): string {
  const lines = [`[mcp_servers.${name}]`];
  lines.push(`command = "${entry.command}"`);
  if (entry.args && entry.args.length > 0) {
    const argsStr = entry.args.map((a) => `"${a}"`).join(", ");
    lines.push(`args = [ ${argsStr} ]`);
  }
  return lines.join("\n");
}

async function readToml(): Promise<string> {
  try {
    return await readFile(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    return "";
  }
}

async function writeToml(content: string): Promise<void> {
  const dir = dirname(CODEX_CONFIG_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(CODEX_CONFIG_PATH, content, "utf-8");
}

export async function getCodexMcpStatus(input: RuntimeMcpInput): Promise<RuntimeMcpStatus> {
  const toml = await readToml();
  const servers = parseMcpServers(toml);
  const installed = input.serverName in servers;
  return {
    installed,
    serverName: input.serverName,
    config: installed ? servers[input.serverName] : null,
  };
}

export async function installCodexMcpServer(input: RuntimeMcpInstallInput): Promise<void> {
  let toml = await readToml();
  const servers = parseMcpServers(toml);

  // Remove existing section if present
  if (input.serverName in servers) {
    const sectionRegex = new RegExp(`\\[mcp_servers\\.${input.serverName}\\][^\\[]*`, "g");
    toml = toml.replace(sectionRegex, "").trim();
  }

  const section = serializeMcpSection(input.serverName, {
    command: input.command,
    args: input.args,
  });

  toml = toml ? `${toml}\n\n${section}\n` : `${section}\n`;
  await writeToml(toml);
}

export async function uninstallCodexMcpServer(input: RuntimeMcpInput): Promise<void> {
  let toml = await readToml();
  const sectionRegex = new RegExp(`\\[mcp_servers\\.${input.serverName}\\][^\\[]*`, "g");
  toml = toml.replace(sectionRegex, "").trim();
  await writeToml(toml ? `${toml}\n` : "");
}
