import { getProjectConfig } from "@aif/shared";
import {
  RuntimeExecutionError,
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
} from "./errors.js";
import { buildLanguageDirective } from "./languagePolicy.js";
import { resolveRuntimeModuleRegistrar } from "./module.js";
import { transformSkillCommandPrefix } from "./promptPolicy.js";
import {
  resolveAdapterCapabilities,
  UsageReporting,
  type RuntimeAdapter,
  type RuntimeDescriptor,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "./types.js";
import { createNoopUsageSink, type RuntimeUsageSink } from "./usageSink.js";

export interface RuntimeRegistryLogger {
  debug(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface RegisterRuntimeOptions {
  source?: "builtin" | "module" | "manual";
  replace?: boolean;
}

export interface RuntimeRegistryOptions {
  logger?: RuntimeRegistryLogger;
  builtInAdapters?: RuntimeAdapter[];
  /**
   * Sink that receives a `RuntimeUsageEvent` for every successful run whose
   * adapter returned a non-null `usage`. Defaults to a no-op sink. The API and
   * agent processes pass a DB-backed sink from `@aif/data` so every LLM call
   * is recorded to `usage_events` and rolled up into task/project aggregates.
   */
  usageSink?: RuntimeUsageSink;
}

function createFallbackLogger(): RuntimeRegistryLogger {
  return {
    debug(context, message) {
      console.debug("DEBUG [runtime-registry]", message, context);
    },
    warn(context, message) {
      console.warn("WARN [runtime-module]", message, context);
    },
    error(context, message) {
      console.error("ERROR [runtime-registry]", message, context);
    },
  };
}

function normalizeRuntimeId(runtimeId: string): string {
  return runtimeId.trim().toLowerCase();
}

/**
 * Wrap an adapter so that `run()` and `resume()` get two cross-cutting concerns
 * applied in the single place every call site flows through:
 *
 * 1. **Prompt transforms** — rewrite skill-command prefixes so callers don't
 *    need to know per-runtime conventions (e.g. `/aif-plan` → `$aif-plan`).
 * 2. **Usage pipeline** — read `result.usage` after every successful run and
 *    forward it to the configured `RuntimeUsageSink`, while asserting the
 *    adapter's declared `usageReporting` contract. This is what makes usage
 *    tracking impossible to forget at the call site: any new caller that
 *    provides a `usageContext` automatically gets its tokens recorded, and
 *    the TypeScript compiler refuses to compile calls without it.
 */
function wrapAdapter(
  adapter: RuntimeAdapter,
  usageSink: RuntimeUsageSink,
  log: RuntimeRegistryLogger,
): RuntimeAdapter {
  const prefix = adapter.descriptor.skillCommandPrefix;
  const needsPromptTransform = Boolean(prefix) && prefix !== "/";

  function transformPrompt(input: RuntimeRunInput): RuntimeRunInput {
    if (!needsPromptTransform) return input;
    return { ...input, prompt: transformSkillCommandPrefix(input.prompt, prefix!) };
  }

  /**
   * Inject a project-language directive into `execution.systemPromptAppend`.
   *
   * Covers every AI-backed call that flows through the registry — subagents,
   * roadmap generation, commit generation, fast fix, chat, reviewGate — so the
   * project's `language.artifacts` setting reaches the model without each call
   * site having to remember to forward it.
   *
   * The directive is appended AFTER any existing `systemPromptAppend` so scope
   * rules (project-scope, review-diff-scope) keep their visual emphasis. When
   * `artifacts` is empty or `en`, the directive is empty and the input is
   * returned unchanged. Failures in reading the config are swallowed (logged
   * as WARN) because a language hint must never break `run()`.
   */
  function applyLanguageDirective(input: RuntimeRunInput): RuntimeRunInput {
    const projectRoot = input.projectRoot;
    if (!projectRoot) return input;

    let directive = "";
    try {
      const cfg = getProjectConfig(projectRoot);
      directive = buildLanguageDirective({
        artifacts: cfg.language.artifacts,
        technicalTerms: cfg.language.technical_terms,
      });
    } catch (error) {
      log.warn(
        {
          runtimeId: adapter.descriptor.id,
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to resolve project language config — skipping language directive injection",
      );
      return input;
    }

    if (!directive) return input;

    const existing = input.execution?.systemPromptAppend ?? "";
    const merged = existing ? `${existing}\n\n${directive}` : directive;

    log.debug(
      {
        runtimeId: adapter.descriptor.id,
        projectRoot,
        artifactsLength: merged.length,
      },
      "Injected project language directive into systemPromptAppend",
    );

    return {
      ...input,
      execution: {
        ...input.execution,
        systemPromptAppend: merged,
      },
    };
  }

  function recordUsage(input: RuntimeRunInput, result: RuntimeRunResult): void {
    // Resolve per-transport capability so multi-transport adapters (e.g. codex
    // with SDK/CLI/API) can declare different usage-reporting contracts per
    // transport. Falls back to descriptor default when transport is unknown.
    const effectiveCaps = resolveAdapterCapabilities(adapter, input.transport);
    const reporting = effectiveCaps.usageReporting;

    // TypeScript enforces `usage: RuntimeUsage | null`, but external/JS
    // adapters may return `undefined` if they forget the field entirely.
    // Treat null and undefined identically for the contract check.
    if (result.usage == null) {
      if (reporting === UsageReporting.FULL) {
        // Level C runtime assert: the adapter promised FULL but returned
        // null/undefined. Throwing here would break the caller mid-run even
        // though the provider actually responded, so we log loudly and move
        // on. A metric/alert on this log is the production-side safety net;
        // dev still catches it via the contract test harness.
        log.error?.(
          {
            runtimeId: adapter.descriptor.id,
            providerId: adapter.descriptor.providerId,
            usageReporting: reporting,
          },
          "adapter declared usageReporting=FULL but returned null/undefined usage — likely bug in adapter",
        );
      }
      return;
    }

    if (reporting === UsageReporting.NONE) {
      log.warn(
        {
          runtimeId: adapter.descriptor.id,
          providerId: adapter.descriptor.providerId,
          usageReporting: reporting,
        },
        "adapter declared usageReporting=NONE but returned non-null usage — descriptor may be stale",
      );
    }

    // Level 3 runtime assert: caller provided usageContext at the type level,
    // but a cast could still wash it out. Guard the sink against garbage.
    const context = input.usageContext;
    if (!context || typeof context.source !== "string" || context.source.length === 0) {
      log.error?.(
        {
          runtimeId: adapter.descriptor.id,
          providerId: adapter.descriptor.providerId,
        },
        "RuntimeRunInput.usageContext.source is required but was missing — usage event dropped",
      );
      return;
    }

    try {
      usageSink.record({
        context,
        runtimeId: adapter.descriptor.id,
        providerId: adapter.descriptor.providerId,
        profileId: input.profileId ?? null,
        transport: input.transport,
        workflowKind: input.workflowKind,
        usageReporting: reporting,
        usage: result.usage,
        recordedAt: new Date(),
      });
    } catch (sinkError) {
      // Sink contract says it must not throw, but defense in depth: an error
      // here must never surface to the caller, which already got its result.
      log.error?.(
        {
          runtimeId: adapter.descriptor.id,
          error: sinkError instanceof Error ? sinkError.message : String(sinkError),
        },
        "usageSink.record threw — dropping event",
      );
    }
  }

  async function wrappedRun(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    const transformed = applyLanguageDirective(transformPrompt(input));
    const result = await adapter.run(transformed);
    recordUsage(transformed, result);
    return result;
  }

  async function wrappedResume(
    input: RuntimeRunInput & { sessionId: string },
  ): Promise<RuntimeRunResult> {
    if (!adapter.resume) {
      throw new RuntimeExecutionError(
        `Runtime "${adapter.descriptor.id}" does not implement resume()`,
      );
    }
    const transformed = applyLanguageDirective(transformPrompt(input)) as RuntimeRunInput & {
      sessionId: string;
    };
    const result = await adapter.resume(transformed);
    recordUsage(transformed, result);
    return result;
  }

  return {
    ...adapter,
    run: wrappedRun,
    resume: adapter.resume ? wrappedResume : undefined,
  };
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();
  private readonly log: RuntimeRegistryLogger;
  private readonly usageSink: RuntimeUsageSink;

  constructor(options: RuntimeRegistryOptions = {}) {
    this.log = options.logger ?? createFallbackLogger();
    this.usageSink = options.usageSink ?? createNoopUsageSink();

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
    return wrapAdapter(adapter, this.usageSink, this.log);
  }

  tryResolveRuntime(runtimeId: string): RuntimeAdapter | null {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const adapter = this.adapters.get(normalizedRuntimeId) ?? null;

    if (adapter) {
      this.log.debug({ runtimeId: normalizedRuntimeId }, "Resolved runtime adapter");
    }

    return adapter ? wrapAdapter(adapter, this.usageSink, this.log) : null;
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
