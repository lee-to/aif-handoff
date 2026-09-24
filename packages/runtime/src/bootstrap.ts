import { getEnv } from "@aif/shared";
import { createClaudeRuntimeAdapter } from "./adapters/claude/index.js";
import { createCodexRuntimeAdapter } from "./adapters/codex/index.js";
import { createOpenCodeRuntimeAdapter } from "./adapters/opencode/index.js";
import { createOpenRouterRuntimeAdapter } from "./adapters/openrouter/index.js";
import { createAntigravityRuntimeAdapter } from "./adapters/antigravity/index.js";
import {
  createRuntimeRegistry,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
} from "./registry.js";
import type { RuntimeAdapter } from "./types.js";
import type { RuntimeUsageSink } from "./usageSink.js";

export interface BootstrapRuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  runtimeModules?: string[];
  /**
   * Sink that receives usage events for every LLM call that flows through the
   * registry. Host processes (api, agent) pass a DB-backed sink from
   * `@aif/data` so every run is persisted to `usage_events`. When omitted,
   * usage is silently dropped — only suitable for tests and CLI tools.
   */
  usageSink?: RuntimeUsageSink;
  modelEffortDiscoveryEnabled?: boolean;
}

/**
 * Create a RuntimeRegistry pre-loaded with built-in adapters (Claude, Codex)
 * and optionally load external runtime modules.
 *
 * Shared bootstrap used by both agent and API processes to avoid duplication.
 */
export async function bootstrapRuntimeRegistry(
  options: BootstrapRuntimeRegistryOptions = {},
): Promise<RuntimeRegistry> {
  const env = getEnv();

  const builtInAdapters: RuntimeAdapter[] = [
    createClaudeRuntimeAdapter(),
    createCodexRuntimeAdapter(),
    createOpenCodeRuntimeAdapter(),
    createOpenRouterRuntimeAdapter(),
  ];

  if (env.AIF_RUNTIME_ANTIGRAVITY_ENABLED) {
    builtInAdapters.push(createAntigravityRuntimeAdapter());
  }

  const registry = createRuntimeRegistry({
    builtInAdapters,
    logger: options.logger,
    usageSink: options.usageSink,
    modelEffortDiscoveryEnabled: options.modelEffortDiscoveryEnabled,
  });

  for (const moduleSpecifier of options.runtimeModules ?? []) {
    try {
      await registry.registerRuntimeModule(moduleSpecifier);
    } catch (error) {
      options.logger?.warn(
        { moduleSpecifier, error },
        "Runtime module failed to load; continuing with built-in adapters",
      );
    }
  }

  return registry;
}
