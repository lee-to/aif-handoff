import { createClaudeRuntimeAdapter } from "./adapters/claude/index.js";
import { createCodexRuntimeAdapter } from "./adapters/codex/index.js";
import {
  createRuntimeRegistry,
  type RuntimeRegistry,
  type RuntimeRegistryLogger,
} from "./registry.js";

export interface BootstrapRuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  runtimeModules?: string[];
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
  const registry = createRuntimeRegistry({
    builtInAdapters: [createClaudeRuntimeAdapter(), createCodexRuntimeAdapter()],
    logger: options.logger,
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
