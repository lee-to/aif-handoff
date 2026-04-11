import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { RuntimeMcpInput, RuntimeMcpInstallInput, RuntimeMcpStatus } from "../../types.js";

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

interface CodexMcpServerEntry extends Record<string, unknown> {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  bearer_token_env_var?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<
    string,
    string
  >;
}

function normalizeServerEntry(value: unknown): CodexMcpServerEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const entry: CodexMcpServerEntry = {};

  if (typeof value.url === "string") {
    entry.url = value.url;
  }

  if (typeof value.command === "string") {
    entry.command = value.command;
    entry.args = normalizeStringArray(value.args);
  }

  if (!entry.url && !entry.command) {
    return null;
  }

  if (typeof value.cwd === "string") {
    entry.cwd = value.cwd;
  }

  const env = normalizeEnv(value.env);
  if (env) {
    entry.env = env;
  }

  if (typeof value.bearer_token_env_var === "string") {
    entry.bearer_token_env_var = value.bearer_token_env_var;
  }

  return entry;
}

function parseMcpServers(toml: string): Record<string, CodexMcpServerEntry> {
  if (!toml.trim()) {
    return {};
  }

  try {
    const parsed = parseToml(toml) as { mcp_servers?: unknown };
    if (!isRecord(parsed.mcp_servers)) {
      return {};
    }

    const servers: Record<string, CodexMcpServerEntry> = {};
    for (const [name, value] of Object.entries(parsed.mcp_servers)) {
      const entry = normalizeServerEntry(value);
      if (entry) {
        servers[name] = entry;
      }
    }

    return servers;
  } catch {
    return {};
  }
}

function serializeMcpSection(name: string, entry: CodexMcpServerEntry): string {
  const serverConfig: Record<string, unknown> = {};
  if (entry.url) {
    serverConfig.url = entry.url;
  }
  if (entry.command) {
    serverConfig.command = entry.command;
  }
  if (entry.args && entry.args.length > 0) {
    serverConfig.args = entry.args;
  }
  if (entry.cwd) {
    serverConfig.cwd = entry.cwd;
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    serverConfig.env = Object.fromEntries(
      Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (entry.bearer_token_env_var) {
    serverConfig.bearer_token_env_var = entry.bearer_token_env_var;
  }

  return stringifyToml({
    mcp_servers: {
      [name]: serverConfig,
    },
  }).trim();
}

function removeServerSections(toml: string, serverName: string): string {
  const mainSectionHeader = `[mcp_servers.${serverName}]`;
  const envSectionHeader = `[mcp_servers.${serverName}.env]`;
  const sectionHeaderRegex = /^\[[^\]]+]\s*$/;
  const keptLines: string[] = [];
  let skipping = false;

  for (const line of toml.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === mainSectionHeader || trimmed === envSectionHeader) {
      skipping = true;
      continue;
    }

    if (skipping && sectionHeaderRegex.test(trimmed)) {
      skipping = false;
    }

    if (!skipping) {
      keptLines.push(line);
    }
  }

  return keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  toml = removeServerSections(toml, input.serverName);

  const entry: CodexMcpServerEntry =
    input.transport === "streamable_http"
      ? {
          url: input.url,
          bearer_token_env_var: input.bearerTokenEnvVar,
        }
      : {
          command: input.command,
          args: input.args ?? [],
          cwd: input.cwd,
          env: input.env,
        };

  const section = serializeMcpSection(input.serverName, entry);

  toml = toml ? `${toml}\n\n${section}\n` : `${section}\n`;
  await writeToml(toml);
}

export async function uninstallCodexMcpServer(input: RuntimeMcpInput): Promise<void> {
  const toml = removeServerSections(await readToml(), input.serverName);
  await writeToml(toml ? `${toml}\n` : "");
}
