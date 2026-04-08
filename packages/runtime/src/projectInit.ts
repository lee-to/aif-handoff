import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { initBaseProjectDirectory, logger } from "@aif/shared";
import type { RuntimeRegistry } from "./registry.js";

const log = logger("runtime-project-init");

export interface InitProjectOptions {
  /** Project root directory path. */
  projectRoot: string;
  /** Runtime registry — runtime IDs are collected for ai-factory init --agents. */
  registry: RuntimeRegistry;
  /** Limit to specific runtime IDs. If omitted, all registered runtimes are used. */
  runtimeIds?: string[];
}

export interface InitProjectResult {
  ok: boolean;
  error?: string;
}

/**
 * Initialize a project directory with all runtime-specific structures.
 *
 * 1. Creates project root + git repo (base scaffold)
 * 2. Runs `ai-factory init --agents claude,codex` if `.ai-factory/` does not exist yet
 *
 * `.ai-factory/` is created exclusively by `ai-factory init`. If the command
 * fails the directory stays missing so subsequent calls will retry.
 *
 * Safe to call multiple times — skips if `.ai-factory/` already exists.
 *
 * @throws Error if `ai-factory init` fails — callers must handle this to
 *   prevent creating projects with broken scaffold.
 */
export function initProject(options: InitProjectOptions): InitProjectResult {
  const { projectRoot, registry, runtimeIds } = options;

  const aiFactoryDir = resolve(projectRoot, ".ai-factory");
  const alreadyInitialized = existsSync(aiFactoryDir);

  // 1. Base scaffold: project root + git (does NOT create .ai-factory/)
  initBaseProjectDirectory(projectRoot);

  // 2. ai-factory init — only for fresh projects
  if (alreadyInitialized) return { ok: true };

  const descriptors = registry.listRuntimes();
  const targets = runtimeIds ? descriptors.filter((d) => runtimeIds.includes(d.id)) : descriptors;

  const agentIds = targets.map((d) => d.id).join(",");
  if (!agentIds) return { ok: true };

  try {
    execFileSync("npx", ["ai-factory", "init", "--agents", agentIds], {
      cwd: projectRoot,
      stdio: "ignore",
      timeout: 60_000,
    });
    log.info({ projectRoot, agents: agentIds }, "ai-factory init completed");
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ai-factory init failed with unknown error";
    log.error(
      { projectRoot, agents: agentIds, err },
      "ai-factory init failed — project scaffold is incomplete",
    );
    return {
      ok: false,
      error: `Project initialization failed: could not run "ai-factory init". ${message}. Make sure ai-factory is available (npx ai-factory --version) and try again.`,
    };
  }
}
