import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { initBaseProjectDirectory, logger } from "@aif/shared";
import type { RuntimeRegistry } from "./registry.js";

const log = logger("runtime-project-init");
const moduleRequire = createRequire(import.meta.url);
const IS_WINDOWS = process.platform === "win32";

/** Minimum ai-factory version that supports --config flag. */
const CONFIG_FLAG_MIN_VERSION = [2, 9, 3] as const;

function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true; // equal
}

function getAiFactoryVersion(): string | null {
  const execOptions: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] } = {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  };

  // 1. Local install — fastest, no network
  try {
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return execFileSync(process.execPath, [aiFactoryBin, "--version"], execOptions).trim();
  } catch {
    // not installed locally — fall through
  }

  // 2. npx (Windows: cmd /d /c npx) — covers global installs and remote fetching
  try {
    if (IS_WINDOWS) {
      const shell = process.env.ComSpec ?? "cmd.exe";
      return execFileSync(shell, ["/d", "/c", "npx ai-factory --version"], execOptions).trim();
    }
    return execFileSync("npx", ["ai-factory", "--version"], execOptions).trim();
  } catch {
    return null;
  }
}

function supportsConfigFlag(): boolean {
  const raw = getAiFactoryVersion();
  if (!raw) return false;
  const version = parseVersion(raw);
  if (!version) return false;
  return isVersionAtLeast(version, CONFIG_FLAG_MIN_VERSION);
}

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

interface AiFactoryCommand {
  command: string;
  args: string[];
}

function quoteAgentIdsForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveAiFactoryCommand(agentIds: string, useConfig: boolean): AiFactoryCommand {
  const configArgs = useConfig ? ["--config"] : [];

  try {
    const aiFactoryBin = moduleRequire.resolve("ai-factory/bin/ai-factory.js");
    return {
      command: process.execPath,
      args: [aiFactoryBin, "init", "--agents", agentIds, ...configArgs],
    };
  } catch {
    if (IS_WINDOWS) {
      const configSuffix = useConfig ? " --config" : "";
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: [
          "/d",
          "/c",
          `npx ai-factory init --agents ${quoteAgentIdsForCmd(agentIds)}${configSuffix}`,
        ],
      };
    }

    return {
      command: "npx",
      args: ["ai-factory", "init", "--agents", agentIds, ...configArgs],
    };
  }
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
  const initCapable = descriptors.filter((d) => d.supportsProjectInit);
  const targets = runtimeIds ? initCapable.filter((d) => runtimeIds.includes(d.id)) : initCapable;

  const agentIds = [
    ...new Set(
      targets.flatMap((descriptor) => {
        const agentName = descriptor.projectInitAgentName?.trim();
        if (agentName) return [agentName];

        log.warn(
          { projectRoot, runtimeId: descriptor.id },
          "Skipping runtime during ai-factory init because projectInitAgentName is missing",
        );
        return [];
      }),
    ),
  ].join(",");
  if (!agentIds) return { ok: true };

  try {
    const useConfig = supportsConfigFlag();
    const command = resolveAiFactoryCommand(agentIds, useConfig);
    log.debug({ useConfig }, "ai-factory --config flag support");
    execFileSync(command.command, command.args, {
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
