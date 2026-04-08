import {
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
} from "./errors.js";
import { resolveRuntimeModuleRegistrar } from "./module.js";
import { transformSkillCommandPrefix } from "./promptPolicy.js";
import type { RuntimeAdapter, RuntimeDescriptor, RuntimeRunInput } from "./types.js";

export interface RuntimeRegistryLogger {
  debug(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface RegisterRuntimeOptions {
  source?: "builtin" | "module" | "manual";
  replace?: boolean;
}

export interface RuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  builtInAdapters?: RuntimeAdapter[];
}

function createFallbackLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime-registry]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime-module]", message, context);
    },
  };
}

function normalizeRuntimeId(runtimeId: string): string {
  return runtimeId.trim().toLowerCase();
}

/**
 * Wrap an adapter so that `run()` and `resume()` automatically transform
 * skill command prefixes in the prompt before forwarding to the real adapter.
 *
 * This is the single place where cross-cutting prompt transforms are applied,
 * so callers never need to remember to transform manually.
 */
function wrapAdapterWithTransforms(adapter: RuntimeAdapter): RuntimeAdapter {
  const prefix = adapter.descriptor.skillCommandPrefix;
  if (!prefix || prefix === "/") return adapter;

  function transformPrompt(input: RuntimeRunInput): RuntimeRunInput {
    return { ...input, prompt: transformSkillCommandPrefix(input.prompt, prefix!) };
  }

  return {
    ...adapter,
    run(input) {
      return adapter.run(transformPrompt(input));
    },
    resume: adapter.resume
      ? (input) =>
          adapter.resume!(transformPrompt(input) as RuntimeRunInput & { sessionId: string })
      : undefined,
  };
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  private readonly log: RuntimeRegistryLogger;

  constructor(options: RuntimeRegistryOptions = {}) {
    this.log = options.logger ?? createFallbackLogger();

    if (options.builtInAdapters?.length) {
      this.registerBuiltInRuntimes(options.builtInAdapters);
    }
  }

  registerBuiltInRuntime(adapter: RuntimeAdapter): void {
    this.registerRuntime(adapter, { source: "builtin" });
  }

  registerBuiltInRuntimes(adapters: RuntimeAdapter[]): void {
    for (const adapter of adapters) {
      this.registerBuiltInRuntime(adapter);
    }
  }

  registerRuntime(adapter: RuntimeAdapter, options: RegisterRuntimeOptions = {}): void {
    const runtimeId = normalizeRuntimeId(adapter.descriptor.id);
    if (!runtimeId) {
      throw new RuntimeRegistrationError("Runtime adapter descriptor.id cannot be empty");
    }

    const existing = this.adapters.get(runtimeId);
    if (existing && !options.replace) {
      throw new RuntimeRegistrationError(`Runtime "${runtimeId}" is already registered`);
    }

    this.adapters.set(runtimeId, adapter);
    this.log.debug(
      {
        runtimeId,
        providerId: adapter.descriptor.providerId,
        source: options.source ?? "manual",
        replace: Boolean(existing && options.replace),
      },
      "Registered runtime adapter",
    );
  }

  resolveRuntime(runtimeId: string): RuntimeAdapter {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalizedRuntimeId);

    if (!adapter) {
      throw new RuntimeResolutionError(`Runtime "${normalizedRuntimeId}" is not registered`);
    }

    this.log.debug({ runtimeId: normalizedRuntimeId }, "Resolved runtime adapter");
    return wrapAdapterWithTransforms(adapter);
  }

  tryResolveRuntime(runtimeId: string): RuntimeAdapter | null {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalizedRuntimeId) ?? null;

    if (adapter) {
      this.log.debug({ runtimeId: normalizedRuntimeId }, "Resolved runtime adapter");
    }

    return adapter ? wrapAdapterWithTransforms(adapter) : null;
  }

  hasRuntime(runtimeId: string): boolean {
    return this.adapters.has(normalizeRuntimeId(runtimeId));
  }

  listRuntimes(): RuntimeDescriptor[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  removeRuntime(runtimeId: string): boolean {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const removed = this.adapters.delete(normalizedRuntimeId);
    this.log.debug({ runtimeId: normalizedRuntimeId, removed }, "Removed runtime adapter");
    return removed;
  }

  async registerRuntimeModule(moduleSpecifier: string): Promise<void> {
    let moduleExport: unknown;
    try {
      moduleExport = await import(moduleSpecifier);
    } catch (error) {
      this.log.warn({ moduleSpecifier, error }, "Failed to load runtime module");
      throw new RuntimeModuleLoadError(
        `Failed to import runtime module "${moduleSpecifier}"`,
        error,
      );
    }

    await this.applyRuntimeModule(moduleExport, moduleSpecifier);
  }

  async applyRuntimeModule(moduleExport: unknown, moduleId = "runtime-module"): Promise<void> {
    const register = resolveRuntimeModuleRegistrar(moduleExport);
    if (!register) {
      this.log.warn({ moduleId }, "Invalid runtime module export");
      throw new RuntimeModuleValidationError(
        `Module "${moduleId}" does not export registerRuntimeModule(registry)`,
      );
    }

    try {
      await register(this);
      this.log.debug({ moduleId }, "Registered runtime module");
    } catch (error) {
      this.log.warn({ moduleId, error }, "Failed while executing runtime module");
      throw new RuntimeModuleLoadError(
        `Module "${moduleId}" failed during registerRuntimeModule(registry)`,
        error,
      );
    }
  }
}

export function createRuntimeRegistry(options: RuntimeRegistryOptions = {}): RuntimeRegistry {
  return new RuntimeRegistry(options);
}
