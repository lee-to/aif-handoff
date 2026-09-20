import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnDev } from "./lib/spawn-dev.mjs";
import { assertWorkspacePackagesResolveToSource } from "./lib/workspace-resolution-guard.mjs";

// Minimum Node version required transitively (Vite 8). Keep in sync with
// `engines.node` in the root package.json.
const SUPPORTED_NODE_RANGE = "^20.19.0 || >=22.12.0";

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = (major === 20 && minor >= 19) || major > 22 || (major === 22 && minor >= 12);
  if (!ok) {
    console.error(
      `[dev] Node ${process.versions.node} is not supported. Requires Node ${SUPPORTED_NODE_RANGE} (Vite 8 dependency; Node 21 is not supported).\n` +
        `[dev] Use nvm: \`nvm use\` (see .nvmrc) or install a compatible version.`,
    );
    process.exit(1);
  }
}

// `better-sqlite3` is a native module. After switching the Node version, the
// prebuilt binary may target a different `NODE_MODULE_VERSION`, which makes
// the API crash with ERR_DLOPEN_FAILED. `node --watch` swallows that crash
// and keeps the process alive silently, so the user only sees a "Bad
// Gateway" from the Vite proxy. Run an explicit preflight to turn this
// silent failure into an actionable error before Turbo starts.
function assertNativeModulesUsable() {
  const require = createRequire(import.meta.url);
  try {
    require("better-sqlite3");
  } catch (err) {
    if (err && err.code === "ERR_DLOPEN_FAILED") {
      console.error(
        `[dev] better-sqlite3 native binary is incompatible with the current Node (${process.version}).\n` +
          `[dev] Run: \`npm rebuild better-sqlite3\` and retry \`npm run dev\`.\n` +
          `[dev] Original error: ${err.message}`,
      );
      process.exit(1);
    }
    // Re-throw other errors as-is so Turbo/Node can surface the stack trace.
    throw err;
  }
}

// Minimal root .env loader for local dev scripts. Supports single-line KEY=VALUE pairs only.
// (helpers below: assertNodeVersion / assertNativeModulesUsable run before Turbo to fail fast)
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

// `internalBroadcastAuth` authorizes a caller only with a request token matching
// `INTERNAL_BROADCAST_TOKEN`, or — with no token configured — while
// `NODE_ENV=test`. `npm run dev` is neither, so with the token unset every
// agent/MCP broadcast is answered with 401: the board stops live-updating and
// the coordinator's wake channel never fires on agent-side transitions.
//
// Mint an ephemeral per-run token instead of shipping a shared placeholder in
// `.env.example` — a copied placeholder is a publicly known credential in any
// deployment that follows the documented setup. Nothing is written to disk; the
// value lives for this dev run only.
//
// Processes launched outside this script (an MCP client spawning the stdio
// server itself) do not inherit it and still need an explicit shared token.
function ensureInternalBroadcastToken() {
  if (process.env.INTERNAL_BROADCAST_TOKEN?.trim()) return;

  process.env.INTERNAL_BROADCAST_TOKEN = randomBytes(32).toString("hex");
  console.log(
    "[dev] INTERNAL_BROADCAST_TOKEN is unset — generated an ephemeral token for this run.",
  );
}

// MCP HTTP is optional in the root dev launcher, so invalid values disable the
// extra HTTP process instead of aborting the whole dev stack.
function resolveMcpPort(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const port = Number(trimmed);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : null;
}

loadRootEnv();
ensureInternalBroadcastToken();
assertNodeVersion();
assertNativeModulesUsable();
assertWorkspacePackagesResolveToSource();

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

spawnDev({
  command: "npx",
  args,
  env: process.env,
  label: "dev",
});
