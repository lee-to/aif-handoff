import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal root .env loader for local dev scripts. Supports single-line KEY=VALUE pairs only.
function parseEnvFile(path) {
  const entries = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    if (!key) continue;

    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function loadRootEnv() {
  const resolvedEnv = {};

  for (const filename of [".env", ".env.local"]) {
    const path = resolve(process.cwd(), filename);
    if (!existsSync(path)) continue;
    Object.assign(resolvedEnv, parseEnvFile(path));
  }

  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveMcpPort(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const port = Number(trimmed);
  return Number.isInteger(port) && port > 0 ? String(port) : null;
}

loadRootEnv();

const filters = ["@aif/api", "@aif/web", "@aif/agent"];
const mcpPort = resolveMcpPort(process.env.MCP_PORT);

if (mcpPort) {
  process.env.MCP_PORT = mcpPort;
  filters.push("@aif/mcp");
  console.log(`[dev] MCP enabled on port ${mcpPort}`);
}

const args = [
  "turbo",
  "run",
  "dev",
  ...filters.flatMap((filter) => ["--filter", filter]),
  ...process.argv.slice(2),
];

const child =
  process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", "npx", ...args], {
        stdio: "inherit",
        env: process.env,
      })
    : spawn("npx", args, {
        stdio: "inherit",
        env: process.env,
      });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error("[dev] Failed to start turbo dev", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
