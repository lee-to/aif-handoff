import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { findMonorepoRootFromUrl } from "./monorepoRoot.js";

const MONOREPO_ROOT = findMonorepoRootFromUrl(import.meta.url);
const ROOT_ENV_PATH = resolve(MONOREPO_ROOT, ".env");
const ROOT_ENV_LOCAL_PATH = resolve(MONOREPO_ROOT, ".env.local");

let envLoaded = false;

/**
 * Load root-level .env files once for all Node packages.
 * .env is loaded first, then .env.local overrides it when present.
 * Explicit process env wins over both files.
 */
export function ensureRootEnvLoaded(): void {
  if (envLoaded) return;

  // Skip loading .env files during test runs - tests control env via vi.stubEnv / process.env
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    envLoaded = true;
    return;
  }

  const resolvedEnv: Record<string, string> = {};

  if (existsSync(ROOT_ENV_PATH)) {
    Object.assign(resolvedEnv, parseDotenv(readFileSync(ROOT_ENV_PATH)));
  }
  if (existsSync(ROOT_ENV_LOCAL_PATH)) {
    Object.assign(resolvedEnv, parseDotenv(readFileSync(ROOT_ENV_LOCAL_PATH)));
  }

  for (const [key, value] of Object.entries(resolvedEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  envLoaded = true;
}

ensureRootEnvLoaded();
