import { createHash } from "node:crypto";
import { checkRuntimeCapabilities } from "./capabilities.js";
import { createRuntimeMemoryCache, type RuntimeCache } from "./cache.js";
import { RuntimeValidationError } from "./errors.js";
import type { ResolvedRuntimeProfile } from "./resolution.js";
import { validateResolvedRuntimeProfile } from "./resolution.js";
import type { RuntimeRegistry } from "./registry.js";
import {
  resolveAdapterCapabilities,
  type RuntimeConnectionValidationResult,
  type RuntimeModel,
} from "./types.js";

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

function normalizeCacheValue(value: unknown): unknown {
  if (value == null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCacheValue(entry));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeCacheValue(entry)] as const);
    return Object.fromEntries(entries);
  }

  return String(value);
}

function fingerprintResolvedInputs(resolved: ResolvedRuntimeProfile): string {
  // Model discovery depends on transport/auth/config inputs beyond runtimeId/baseUrl.
  // Keep a stable fingerprint here so profile edits do not incorrectly reuse stale cache entries.
  const normalized = normalizeCacheValue({
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    apiKeyHash: resolved.apiKey
      ? createHash("sha256").update(resolved.apiKey).digest("hex").slice(0, 16)
      : null,
    headers: resolved.headers,
    options: resolved.options,
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

function modelCacheKey(resolved: ResolvedRuntimeProfile): string {
  return [
    resolved.runtimeId,
    resolved.providerId,
    resolved.profileId ?? "none",
    resolved.transport,
    resolved.baseUrl ?? "default",
    resolved.model ?? "none",
    fingerprintResolvedInputs(resolved),
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
      const capabilities = resolveAdapterCapabilities(adapter, resolved.transport);
      const capabilityResult = checkRuntimeCapabilities({
        runtimeId: resolved.runtimeId,
        workflowKind: "model-discovery",
        capabilities,
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
          model: resolved.model ?? undefined,
          transport: resolved.transport,
          projectRoot:
            typeof resolved.options.projectRoot === "string"
              ? resolved.options.projectRoot
              : undefined,
          headers: resolved.headers,
          options: {
            ...resolved.options,
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.apiKeyEnvVar ? { apiKeyEnvVar: resolved.apiKeyEnvVar } : {}),
          },
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          apiKeyEnvVar: resolved.apiKeyEnvVar,
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
