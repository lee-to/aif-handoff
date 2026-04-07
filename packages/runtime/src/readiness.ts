import type { RuntimeRegistry } from "./registry.js";
import type { RuntimeConnectionValidationResult } from "./types.js";
import { resolveRuntimeProfile, type RuntimeResolutionEnv } from "./resolution.js";

export interface RuntimeReadinessLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface RuntimeReadinessResult {
  ready: boolean;
  runtimeCount: number;
  runtimes: RuntimeReadinessEntry[];
  message: string;
  checkedAt: string;
}

export interface RuntimeReadinessEntry {
  runtimeId: string;
  providerId: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  validation: RuntimeConnectionValidationResult;
}

export interface CheckRuntimeReadinessInput {
  registry: RuntimeRegistry;
  env?: RuntimeResolutionEnv;
  logger?: RuntimeReadinessLogger;
}

/**
 * Check readiness of all registered runtimes via their `validateConnection` method.
 * A system is "ready" if at least one runtime validates successfully.
 */
export async function checkRuntimeReadiness(
  input: CheckRuntimeReadinessInput,
): Promise<RuntimeReadinessResult> {
  const env = input.env ?? (process.env as RuntimeResolutionEnv);
  const descriptors = input.registry.listRuntimes();
  const checkedAt = new Date().toISOString();

  if (descriptors.length === 0) {
    return {
      ready: false,
      runtimeCount: 0,
      runtimes: [],
      message: "No runtimes registered.",
      checkedAt,
    };
  }

  const entries: RuntimeReadinessEntry[] = [];

  for (const descriptor of descriptors) {
    const adapter = input.registry.tryResolveRuntime(descriptor.id);
    if (!adapter) continue;

    let validation: RuntimeConnectionValidationResult;

    if (adapter.validateConnection) {
      try {
        const resolved = resolveRuntimeProfile({
          source: "readiness-check",
          profile: null,
          fallbackRuntimeId: descriptor.id,
          fallbackProviderId: descriptor.providerId,
          env,
        });

        validation = await adapter.validateConnection({
          runtimeId: descriptor.id,
          providerId: descriptor.providerId,
          transport: resolved.transport,
          options: {
            ...resolved.options,
            apiKey: resolved.apiKey,
            apiKeyEnvVar: resolved.apiKeyEnvVar,
            baseUrl: resolved.baseUrl,
          },
        });
      } catch (error) {
        input.logger?.warn?.(
          { runtimeId: descriptor.id, error },
          "Runtime readiness validation threw; marking as not ready",
        );
        validation = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      validation = { ok: true, message: "No explicit validation available" };
    }

    entries.push({
      runtimeId: descriptor.id,
      providerId: descriptor.providerId,
      displayName: descriptor.displayName ?? descriptor.id,
      capabilities: { ...descriptor.capabilities },
      validation,
    });
  }

  const ready = entries.some((e) => e.validation.ok);

  return {
    ready,
    runtimeCount: entries.length,
    runtimes: entries,
    message: ready
      ? "At least one runtime is configured and reachable."
      : "No usable runtime is configured. Add a runtime profile or set provider credentials.",
    checkedAt,
  };
}
