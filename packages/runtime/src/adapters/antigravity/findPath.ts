import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Find the Google Antigravity CLI executable path from common install locations.
 */
export function findAntigravityPath(): string | undefined {
  if (process.env.ANTIGRAVITY_BIN_PATH && existsSync(process.env.ANTIGRAVITY_BIN_PATH)) {
    return process.env.ANTIGRAVITY_BIN_PATH;
  }

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  const candidates = IS_WINDOWS
    ? [
        resolve(localAppData, "agy/bin/agy.exe"),
        resolve(homeDir, "AppData/Local/agy/bin/agy.exe"),
        resolve(process.env.APPDATA ?? "", "npm/agy.exe"),
        resolve(homeDir, "scoop/shims/agy.exe"),
        resolve(homeDir, ".local/bin/agy.exe"),
      ]
    : [
        "/usr/local/bin/agy",
        resolve(homeDir, ".local/bin/agy"),
        "/opt/homebrew/bin/agy",
        resolve(homeDir, "bin/agy"),
        "/usr/bin/agy",
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: check PATH
  const locator = IS_WINDOWS ? "where" : "which";
  try {
    const result = execFileSync(locator, ["agy"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .find((line) => {
        if (!line || !existsSync(line)) return false;
        const lower = line.toLowerCase();
        if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return false;
        return true;
      });

    if (result) return result;
  } catch {
    // locator command not found or agy not in PATH
  }

  return undefined;
}

/**
 * Probe whether the Antigravity CLI is reachable and return its version.
 */
export function probeAntigravityCli(cliPath: string): {
  ok: boolean;
  version?: string;
  error?: string;
} {
  try {
    const lower = cliPath.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return {
        ok: false,
        error: `Executing Antigravity via batch script (${cliPath}) is prohibited. Point directly to agy.exe.`,
      };
    }
    if (IS_WINDOWS) {
      assertSafeWindowsShellExecutablePath(cliPath, "Antigravity CLI path");
    }
    const out = execFileSync(cliPath, ["--version"], {
      timeout: 5_000,
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, version: out.trim() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Unifies the resolution of the Antigravity CLI executable path across execution,
 * validation, and discovery.
 */
export function resolveCliPath(
  options?: Record<string, unknown>,
  fallbackPath?: string,
  finder: () => string | undefined = findAntigravityPath,
): string {
  if (
    typeof options?.antigravityCliPath === "string" &&
    options.antigravityCliPath.trim().length > 0
  ) {
    return options.antigravityCliPath.trim();
  }
  const defaultBinary = process.platform === "win32" ? "agy.exe" : "agy";
  return fallbackPath ?? finder() ?? defaultBinary;
}
