import { checkRuntimeCapabilities } from "./capabilities.js";
import { createRuntimeMemoryCache, type RuntimeCache } from "./cache.js";
import { RuntimeValidationError } from "./errors.js";
import type { ResolvedRuntimeProfile } from "./resolution.js";
import { validateResolvedRuntimeProfile } from "./resolution.js";
import type { RuntimeRegistry } from "./registry.js";
import type { RuntimeConnectionValidationResult, RuntimeModel } from "./types.js";

export interface RuntimeModelDiscoveryLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimeModelDiscoveryOptions {
  registry: RuntimeRegistry;
  cache?: RuntimeCache<RuntimeModel[]>;
  validationCache?: RuntimeCache<RuntimeConnectionValidationResult>;
  cacheTtlMs?: number;
  logger?: RuntimeModelDiscoveryLogger;
}

export interface RuntimeModelDiscoveryService {
  listModels(resolved: ResolvedRuntimeProfile, forceRefresh?: boolean): Promise<RuntimeModel[]>;
  validateConnection(
    resolved: ResolvedRuntimeProfile,
    forceRefresh?: boolean,
  ): Promise<RuntimeConnectionValidationResult>;
}

function modelCacheKey(resolved: ResolvedRuntimeProfile): string {
  return [
    resolved.runtimeId,
    resolved.providerId,
    resolved.profileId ?? "none",
    resolved.transport,
    resolved.baseUrl ?? "default",
    resolved.model ?? "none",
  ].join(":");
}

function validationCacheKey(resolved: ResolvedRuntimeProfile): string {
  return `validation:${modelCacheKey(resolved)}`;
}

export function createRuntimeModelDiscoveryService(
  options: RuntimeModelDiscoveryOptions,
): RuntimeModelDiscoveryService {
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? 60_000, 1);
  const modelCache =
    options.cache ?? createRuntimeMemoryCache<RuntimeModel[]>({ defaultTtlMs: cacheTtlMs });
  const validationCache =
    options.validationCache ??
    createRuntimeMemoryCache<RuntimeConnectionValidationResult>({ defaultTtlMs: cacheTtlMs });

  return {
    async listModels(
      resolved: ResolvedRuntimeProfile,
      forceRefresh = false,
    ): Promise<RuntimeModel[]> {
      const cacheKey = modelCacheKey(resolved);
      if (!forceRefresh) {
        const cached = modelCache.get(cacheKey);
        if (cached) {
          options.logger?.debug?.(
            { runtimeId: resolved.runtimeId, profileId: resolved.profileId, cacheHit: true },
            "Returning cached runtime model list",
          );
          return cached;
        }
      }

      const adapter = options.registry.resolveRuntime(resolved.runtimeId);
      const capabilityResult = checkRuntimeCapabilities({
        runtimeId: resolved.runtimeId,
        workflowKind: "model-discovery",
        capabilities: adapter.descriptor.capabilities,
        required: ["supportsModelDiscovery"],
      });
      if (!capabilityResult.ok || !adapter.listModels) {
        throw new RuntimeValidationError(
          `Runtime "${resolved.runtimeId}" does not support model discovery`,
        );
      }

      try {
        const models = await adapter.listModels({
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          projectRoot:
            typeof resolved.options.projectRoot === "string"
              ? resolved.options.projectRoot
              : undefined,
        });
        modelCache.set(cacheKey, models, cacheTtlMs);
        options.logger?.info?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            modelCount: models.length,
          },
          "Runtime model discovery completed",
        );
        return models;
      } catch (error) {
        throw new RuntimeValidationError(
          `Model discovery failed for runtime "${resolved.runtimeId}"`,
          error,
        );
      }
    },

    async validateConnection(
      resolved: ResolvedRuntimeProfile,
      forceRefresh = false,
    ): Promise<RuntimeConnectionValidationResult> {
      const cacheKey = validationCacheKey(resolved);
      if (!forceRefresh) {
        const cached = validationCache.get(cacheKey);
        if (cached) {
          options.logger?.debug?.(
            { runtimeId: resolved.runtimeId, profileId: resolved.profileId, cacheHit: true },
            "Returning cached runtime connection validation result",
          );
          return cached;
        }
      }

      const baseValidation = validateResolvedRuntimeProfile(resolved);
      const adapter = options.registry.resolveRuntime(resolved.runtimeId);

      if (!adapter.validateConnection) {
        const result: RuntimeConnectionValidationResult = baseValidation.ok
          ? { ok: true, message: "Runtime adapter has no explicit connection check" }
          : {
              ok: false,
              message: baseValidation.message,
              details: { warnings: baseValidation.warnings },
            };
        validationCache.set(cacheKey, result, cacheTtlMs);
        return result;
      }

      try {
        const result = await adapter.validateConnection({
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          model: resolved.model ?? undefined,
          transport: resolved.transport,
          options: {
            ...resolved.options,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            apiKeyEnvVar: resolved.apiKeyEnvVar,
            headers: resolved.headers,
          },
        });
        validationCache.set(cacheKey, result, cacheTtlMs);
        options.logger?.info?.(
          {
            runtimeId: resolved.runtimeId,
            profileId: resolved.profileId,
            ok: result.ok,
          },
          "Runtime connection validation completed",
        );
        return result;
      } catch (error) {
        throw new RuntimeValidationError(
          `Connection validation failed for runtime "${resolved.runtimeId}"`,
          error,
        );
      }
    },
  };
}
