import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { unlink, writeFile } from "node:fs/promises";
import {
  createCodexRuntimeAdapter,
  createRuntimeRegistry,
  resolveRuntimeModuleRegistrar,
  DEFAULT_RUNTIME_CAPABILITIES,
  type RuntimeRegistry,
} from "../index.js";

describe("runtime module loader", () => {
  it("resolves registrar from default object export", () => {
    const registerRuntimeModule = () => undefined;
    const registrar = resolveRuntimeModuleRegistrar({
      default: {
        registerRuntimeModule,
      },
    });
    expect(registrar).toBe(registerRuntimeModule);
  });

  it("registers runtime through in-memory module contract", async () => {
    const registry = createRuntimeRegistry();
    await registry.applyRuntimeModule(
      {
        registerRuntimeModule(innerRegistry: RuntimeRegistry) {
          innerRegistry.registerRuntime(
            createCodexRuntimeAdapter({
              runtimeId: "codex-module",
              providerId: "openai-compatible",
              displayName: "Codex Module",
            }),
          );
        },
      },
      "memory-module",
    );

    const runtime = registry.resolveRuntime("codex-module");
    expect(runtime.descriptor.id).toBe("codex-module");
    expect(runtime.descriptor.providerId).toBe("openai-compatible");
  });

  it("loads registerRuntimeModule from file module specifier", async () => {
    const registry = createRuntimeRegistry();
    const modulePath = join(
      tmpdir(),
      `runtime-loader-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );

    await writeFile(
      modulePath,
      `
export function registerRuntimeModule(registry) {
  registry.registerRuntime({
    descriptor: {
      id: "custom-third-party",
      providerId: "third-party",
      displayName: "Third Party Runtime",
      capabilities: ${JSON.stringify(DEFAULT_RUNTIME_CAPABILITIES)}
    },
    run: async () => ({ outputText: "ok" })
  });
}
`,
      "utf8",
    );

    try {
      await registry.registerRuntimeModule(pathToFileURL(modulePath).href);
      expect(registry.hasRuntime("custom-third-party")).toBe(true);
    } finally {
      await unlink(modulePath);
    }
  });
});
