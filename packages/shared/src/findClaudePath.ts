import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Find the Claude CLI executable path from common install locations. */
export function findClaudePath(): string | undefined {
  const candidates = [
    resolve(process.env.HOME ?? "", ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}
