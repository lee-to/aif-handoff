import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, win32 as pathWin32 } from "node:path";

function normalizePathValue(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.trim().replace(/^"(.*)"$/, "$1");
  return normalized.length > 0 ? normalized : undefined;
}

function isWindowsClaudeWrapperBasename(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "claude" ||
    normalized === "claude.cmd" ||
    normalized === "claude.ps1" ||
    normalized === "claude.bat"
  );
}

export function resolveClaudeSdkExecutablePath(
  path: string | null | undefined,
  platform = process.platform,
): string | undefined {
  const normalizedPath = normalizePathValue(path);
  if (!normalizedPath) return undefined;
  if (platform !== "win32") {
    return normalizedPath;
  }

  const fileName = pathWin32.basename(normalizedPath).toLowerCase();
  if (fileName === "claude.exe") {
    return normalizedPath;
  }
  if (!isWindowsClaudeWrapperBasename(fileName)) {
    return normalizedPath;
  }

  const nativeExecutablePath = pathWin32.resolve(
    pathWin32.dirname(normalizedPath),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return existsSync(nativeExecutablePath) ? nativeExecutablePath : undefined;
}

/** Find the Claude CLI executable path from common install locations. */
export function findClaudePath(): string | undefined {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates =
    /* v8 ignore next */
    process.platform === "win32"
      ? [
          // Prefer .exe (real binary) over .cmd (npm wrapper that requires shell)
          resolve(process.env.APPDATA ?? "", "npm/claude.exe"),
          resolve(process.env.LOCALAPPDATA ?? "", "npm/claude.exe"),
          resolve(homeDir, "scoop/shims/claude.exe"),
          resolve(homeDir, ".local/bin/claude.exe"),
          // Fall back to .cmd wrappers — CLI transport handles these via shell: true,
          // SDK transport will omit .cmd paths and let the SDK do its own lookup.
          resolve(process.env.APPDATA ?? "", "npm/claude.cmd"),
          resolve(process.env.LOCALAPPDATA ?? "", "npm/claude.cmd"),
          resolve(homeDir, "scoop/shims/claude.cmd"),
          resolve(homeDir, ".local/bin/claude.cmd"),
        ]
      : [
          "/usr/local/bin/claude",
          resolve(homeDir, ".local/bin/claude"),
          "/opt/homebrew/bin/claude",
          resolve(homeDir, ".npm-global/bin/claude"),
          "/usr/bin/claude",
        ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fallback: check npm global prefix (covers Docker and custom npm prefix setups)
  try {
    const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (npmPrefix) {
      const npmCandidate = join(npmPrefix, "bin", "claude");
      if (existsSync(npmCandidate)) return npmCandidate;
    }
  } catch {
    // npm not available or timed out
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
