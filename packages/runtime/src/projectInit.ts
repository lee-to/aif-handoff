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

/**
 * Initialize a project directory with all runtime-specific structures.
 *
 * 1. Creates .ai-factory/ and git repo (base scaffold)
 * 2. Runs `ai-factory init --agents claude,codex` once if .ai-factory/ was just created
 *
 * Safe to call multiple times — skips ai-factory init if .ai-factory/ already exists.
 */
export function initProject(options: InitProjectOptions): void {
  const { projectRoot, registry, runtimeIds } = options;

  const aiFactoryDir = resolve(projectRoot, ".ai-factory");
  const alreadyInitialized = existsSync(aiFactoryDir);

  // 1. Base scaffold: .ai-factory/ + git
  initBaseProjectDirectory(projectRoot);

  // 2. ai-factory init — only for fresh projects
  if (alreadyInitialized) return;

  const descriptors = registry.listRuntimes();
  const targets = runtimeIds ? descriptors.filter((d) => runtimeIds.includes(d.id)) : descriptors;

  const agentIds = targets.map((d) => d.id).join(",");
  if (!agentIds) return;

  try {
    execFileSync("npx", ["ai-factory", "init", "--agents", agentIds], {
      cwd: projectRoot,
      stdio: "ignore",
      timeout: 60_000,
    });
    log.info({ projectRoot, agents: agentIds }, "ai-factory init completed");
  } catch (err) {
    log.warn({ projectRoot, agents: agentIds, err }, "ai-factory init failed");
  }
}
