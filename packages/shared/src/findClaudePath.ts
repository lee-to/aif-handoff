import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Find the Claude CLI executable path from common install locations. */
export function findClaudePath(): string | undefined {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates =
    process.platform === "win32"
      ? [
          resolve(process.env.APPDATA ?? "", "npm/claude.cmd"),
          resolve(process.env.LOCALAPPDATA ?? "", "npm/claude.cmd"),
          resolve(homeDir, "scoop/shims/claude.cmd"),
          resolve(homeDir, ".local/bin/claude.cmd"),
        ]
      : [
          resolve(homeDir, ".local/bin/claude"),
          "/usr/local/bin/claude",
          "/opt/homebrew/bin/claude",
          resolve(homeDir, ".npm-global/bin/claude"),
          "/usr/bin/claude",
        ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fallback: ask PATH where claude lives (covers npm/npx global installs, nvm, etc.)
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(command, ["claude"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .find((line) => line.length > 0 && existsSync(line));

    if (result) return result;
  } catch {
    // locator command not available or claude not in PATH
  }

  return undefined;
}
