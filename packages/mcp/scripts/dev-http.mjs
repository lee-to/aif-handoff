import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnDev } from "../../../scripts/lib/spawn-dev.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// This script always starts MCP in HTTP mode, so invalid values are fatal here.
// The root dev launcher in scripts/dev.mjs treats MCP HTTP as optional instead.
function resolveMcpPort(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "3100";
  }

  const port = Number(trimmed);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return String(port);
  }

  throw new Error(`Invalid MCP_PORT: ${trimmed}. Must be an integer between 1 and 65535.`);
}

const port = resolveMcpPort(process.env.MCP_PORT);
console.log(`[mcp] Starting HTTP transport on port ${port}`);

spawnDev({
  command: "npx",
  args: ["tsx", "watch", "src/index.ts"],
  cwd: packageRoot,
  env: {
    ...process.env,
    MCP_TRANSPORT: "http",
    MCP_PORT: port,
  },
  label: "mcp",
});
