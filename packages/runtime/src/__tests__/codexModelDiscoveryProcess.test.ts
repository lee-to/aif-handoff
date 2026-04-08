import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeTransport } from "../types.js";
import {
  buildCodexAppServerDiscoveryEnvWithStats,
  reservePort,
  resolveDiscoveryExecutable,
  terminateProcess,
} from "../adapters/codex/modelDiscovery/process.js";

function createModelDiscoveryInput(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: "codex",
    providerId: "openai",
    profileId: "profile-1",
    options: {},
    ...overrides,
  };
}

describe("codex model discovery process helpers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds curated discovery env, blocks deprecated base-url key, and reports filtered npm_ keys", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_BASE_URL", "https://deprecated.example.com/v1");
    vi.stubEnv("npm_config_registry", "https://registry.npmjs.org");
    vi.stubEnv("UNRELATED_SECRET", "do-not-forward");

    const result = buildCodexAppServerDiscoveryEnvWithStats(
      createModelDiscoveryInput({
        baseUrl: "https://runtime.example.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        apiKey: "sk-input",
      }),
    );

    expect(result.env.OPENAI_API_KEY).toBe("sk-input");
    expect(result.env.CODEX_BASE_URL).toBe("https://runtime.example.com/v1");
    expect(result.env.OPENAI_BASE_URL).toBeUndefined();
    expect(result.env.npm_config_registry).toBeUndefined();
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);
    expect(result.filteredCount).toBeGreaterThanOrEqual(1);
    expect(result.droppedDisallowedPrefixKeys).toContain("npm_config_registry");
  });

  it("resolves discovery executable from options/env/defaults", () => {
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: { codexCliPath: "/custom/codex" },
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("/custom/codex");

    vi.stubEnv("CODEX_CLI_PATH", "/env/codex");
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: {},
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("/env/codex");

    vi.unstubAllEnvs();
    expect(
      resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          options: {},
          transport: RuntimeTransport.CLI,
        }),
      ),
    ).toBe("codex");
  });

  it("attempts bundled binary lookup for sdk transport when no explicit cli path is set", () => {
    let resolved: string | null = null;
    let thrown: unknown = null;

    try {
      resolved = resolveDiscoveryExecutable(
        createModelDiscoveryInput({
          transport: RuntimeTransport.SDK,
          options: {},
        }),
      );
    } catch (error) {
      thrown = error;
    }

    if (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message.length).toBeGreaterThan(0);
    } else {
      expect(resolved).toBeTruthy();
      expect(resolved!.toLowerCase()).toContain("codex");
    }
  });

  it("reserves a loopback port that can be bound immediately afterwards", async () => {
    let port: number;
    try {
      port = await reservePort();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        return;
      }
      throw error;
    }
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        // Some sandboxed CI/dev environments disallow loopback binds.
        // This should not fail helper semantics that only reserve an available port.
        if (error.code === "EPERM" || error.code === "EACCES") {
          resolve();
          return;
        }
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });
  });

  it("only kills live child processes and safely ignores kill errors", () => {
    const alreadyExited = {
      exitCode: 0,
      kill: vi.fn(),
    };
    terminateProcess(alreadyExited as never);
    expect(alreadyExited.kill).not.toHaveBeenCalled();

    const live = {
      exitCode: null,
      kill: vi.fn(() => {
        throw new Error("kill failed");
      }),
    };
    expect(() => terminateProcess(live as never)).not.toThrow();
    expect(live.kill).toHaveBeenCalledTimes(1);
  });
});
