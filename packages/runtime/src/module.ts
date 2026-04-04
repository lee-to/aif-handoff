import type { RuntimeRegistry } from "./registry.js";

export type RegisterRuntimeModule = (registry: RuntimeRegistry) => void | Promise<void>;

export interface RuntimeModule {
  name?: string;
  version?: string;
  registerRuntimeModule: RegisterRuntimeModule;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRegistrar(value: unknown): value is RegisterRuntimeModule {
  return typeof value === "function";
}

/**
 * Resolve a module export into `registerRuntimeModule(registry)`.
 * Supported export forms:
 * - `export function registerRuntimeModule(...) {}`
 * - `export default function registerRuntimeModule(...) {}`
 * - `export default { registerRuntimeModule(...) {} }`
 */
export function resolveRuntimeModuleRegistrar(moduleExport: unknown): RegisterRuntimeModule | null {
  if (isRegistrar(moduleExport)) {
    return moduleExport;
  }

  if (!isObject(moduleExport)) {
    return null;
  }

  if (isRegistrar(moduleExport.registerRuntimeModule)) {
    return moduleExport.registerRuntimeModule;
  }

  const maybeDefault = moduleExport.default;
  if (isRegistrar(maybeDefault)) {
    return maybeDefault;
  }

  if (isObject(maybeDefault) && isRegistrar(maybeDefault.registerRuntimeModule)) {
    return maybeDefault.registerRuntimeModule;
  }

  return null;
}
