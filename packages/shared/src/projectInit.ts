import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { logger } from "./logger.js";

const log = logger("project-init");

/**
 * Initialize the base project directory structure: .ai-factory/ and git repo.
 * Runtime-specific directories (.claude/, .codex/) are handled by adapter.initProject().
 *
 * This is the low-level primitive — callers should use the runtime-aware
 * `initProject()` from `@aif/runtime` which also invokes adapter init hooks.
 */
export function initBaseProjectDirectory(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });

  const targetAiFactory = resolve(projectRoot, ".ai-factory");
  if (!existsSync(targetAiFactory)) {
    mkdirSync(targetAiFactory, { recursive: true });
    log.info({ projectRoot }, "Created .ai-factory directory");
  }

  const gitDir = resolve(projectRoot, ".git");
  if (!existsSync(gitDir)) {
    try {
      execSync("git init", { cwd: projectRoot, stdio: "ignore" });
      execSync("git add -A", { cwd: projectRoot, stdio: "ignore" });
      execSync('git commit -m "init: project scaffold"', {
        cwd: projectRoot,
        stdio: "ignore",
      });
      log.info({ projectRoot }, "Initialized git repo");
    } catch (err) {
      log.warn({ projectRoot, err }, "git init failed");
    }
  }
}

/**
 * @deprecated Use `initBaseProjectDirectory` + adapter init hooks instead.
 * Kept for backwards compat during migration.
 */
export type RuntimeInitHook = (projectRoot: string, monorepoRoot: string) => void;

/** @deprecated Use runtime-aware init from `@aif/runtime` bootstrap. */
export function initProjectDirectory(
  projectRoot: string,
  _runtimeHooks: RuntimeInitHook[] = [],
): void {
  initBaseProjectDirectory(projectRoot);
}
