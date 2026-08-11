import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_MIN_VERSION,
  assertClaudeExecutableCompatible,
  isVersionBelowMin,
  parseClaudeVersion,
  probeClaudeVersion,
  readBundledClaudeVersion,
  type ClaudeVersionProbe,
} from "../adapters/claude/version.js";
import { ClaudeRuntimeAdapterError } from "../adapters/claude/errors.js";

describe("parseClaudeVersion", () => {
  it("parses a plain semver triple", () => {
    expect(parseClaudeVersion("2.1.191")).toEqual({
      major: 2,
      minor: 1,
      patch: 191,
      raw: "2.1.191",
    });
  });

  it("parses the first triple out of cli output with prefix and suffix", () => {
    expect(parseClaudeVersion("claude 2.1.220 (commit abcdef)")).toEqual({
      major: 2,
      minor: 1,
      patch: 220,
      raw: "2.1.220",
    });
  });

  it("returns null when no triple is present", () => {
    expect(parseClaudeVersion("garbage")).toBeNull();
    expect(parseClaudeVersion("2.1")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
    expect(parseClaudeVersion(undefined as unknown as string)).toBeNull();
  });
});

describe("isVersionBelowMin", () => {
  const at = (v: string) => parseClaudeVersion(v)!;

  it(`treats ${CLAUDE_MIN_VERSION} as the boundary`, () => {
    expect(isVersionBelowMin(at("2.1.191"))).toBe(false);
    expect(isVersionBelowMin(at("2.1.190"))).toBe(true);
  });

  it("passes versions above the minimum across all components", () => {
    expect(isVersionBelowMin(at("2.1.220"))).toBe(false);
    expect(isVersionBelowMin(at("2.2.0"))).toBe(false);
    expect(isVersionBelowMin(at("3.0.0"))).toBe(false);
  });

  it("rejects older versions across all components", () => {
    expect(isVersionBelowMin(at("2.1.0"))).toBe(true);
    expect(isVersionBelowMin(at("2.0.999"))).toBe(true);
    expect(isVersionBelowMin(at("1.9.999"))).toBe(true);
  });
});

describe("readBundledClaudeVersion", () => {
  it("reads the version of the Claude Code binary bundled with the installed Agent SDK", () => {
    // Real call against the installed @anthropic-ai/claude-agent-sdk manifest.
    // Guards the manifest-resolution path (exports-restricted subpath resolved
    // via the main entry) and asserts the dependency we pin actually bundles a
    // Claude Code at/above the supported minimum.
    const version = readBundledClaudeVersion();
    expect(version, "expected a parseable bundled version from the SDK manifest").not.toBeNull();
    expect(isVersionBelowMin(version!)).toBe(false);
  });
});

describe("probeClaudeVersion", () => {
  it("returns { info: null } for a missing executable instead of rejecting", async () => {
    const result = await probeClaudeVersion("/nonexistent/claude-path-that-does-not-exist");
    expect(result.info).toBeNull();
    expect(result.error).toMatch(/not found|Failed to probe/i);
  });
});

const probe = (info: ClaudeVersionProbe["info"], raw = "", error: string | null = null) =>
  vi.fn().mockResolvedValue({ info, raw, error } as ClaudeVersionProbe);

const bundled = (info: ClaudeVersionProbe["info"]) => vi.fn(() => info);

const recordingLogger = () => {
  const calls = { debug: [] as unknown[], warn: [] as unknown[] };
  return {
    calls,
    logger: {
      debug: vi.fn((...args: unknown[]) => void calls.debug.push(args)),
      warn: vi.fn((...args: unknown[]) => void calls.warn.push(args)),
    },
  };
};

describe("assertClaudeExecutableCompatible", () => {
  beforeEach(() => {
    // Default to a non-test env so the DI-driven cases exercise the probe path;
    // individual skip tests override this. VITEST must be cleared too — vitest 4
    // marks the process with VITEST (not NODE_ENV=test), which the guard treats
    // as a unit-test context.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: unknown }).__AIF_CLAUDE_QUERY_MOCK__;
  });

  it("throws a classified error when the binary is below the minimum", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.90"), "2.1.90");
    const { logger } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible("/bin/claude", logger, {}, { probeClaudeVersion: probeFn }),
    ).rejects.toMatchObject({
      name: "ClaudeRuntimeAdapterError",
      adapterCode: "CLAUDE_VERSION_UNSUPPORTED",
      category: "transport",
    });
    expect(probeFn).toHaveBeenCalledWith("/bin/claude");
  });

  it("includes the upgrade hint in the message", async () => {
    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probe(parseClaudeVersion("2.1.90")) },
      ),
    ).rejects.toThrow(/npm i -g @anthropic-ai\/claude-code@latest/);
  });

  it("does not throw and warns when the bundled version cannot be determined", async () => {
    // No explicit path → guard reads the SDK-bundled version, not PATH.
    const probeFn = probe(parseClaudeVersion("2.1.220"));
    const bundledFn = bundled(null);
    const { logger, calls } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(
        undefined,
        logger,
        {},
        { probeClaudeVersion: probeFn, readBundledClaudeVersion: bundledFn },
      ),
    ).resolves.toBeUndefined();
    expect(bundledFn).toHaveBeenCalled();
    expect(probeFn).not.toHaveBeenCalled();
    expect(calls.warn).toHaveLength(1);
    expect(calls.debug).toHaveLength(0);
  });

  it("does not throw and logs the bundled version when at/above the minimum", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.90"));
    const bundledFn = bundled(parseClaudeVersion("2.1.220"));
    const { logger, calls } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(
        undefined,
        logger,
        {},
        { probeClaudeVersion: probeFn, readBundledClaudeVersion: bundledFn },
      ),
    ).resolves.toBeUndefined();
    expect(bundledFn).toHaveBeenCalled();
    // The bundled version is used; the (lower) PATH probe is never consulted.
    expect(probeFn).not.toHaveBeenCalled();
    expect(calls.debug).toHaveLength(1);
    expect(calls.warn).toHaveLength(0);
    expect((calls.debug[0] as unknown[])[0]).toMatchObject({
      versionSource: "bundled",
      claudeVersion: "2.1.220",
    });
  });

  it("throws when the bundled version is below the minimum and points at the SDK", async () => {
    const bundledFn = bundled(parseClaudeVersion("2.1.90"));
    const { logger } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(
        undefined,
        logger,
        {},
        { readBundledClaudeVersion: bundledFn },
      ),
    ).rejects.toMatchObject({
      name: "ClaudeRuntimeAdapterError",
      adapterCode: "CLAUDE_VERSION_UNSUPPORTED",
      category: "transport",
    });
  });

  it("throws a bundled error that names the SDK dependency, not a global install", async () => {
    const bundledFn = bundled(parseClaudeVersion("2.1.90"));
    await expect(
      assertClaudeExecutableCompatible(
        undefined,
        undefined,
        {},
        { readBundledClaudeVersion: bundledFn },
      ),
    ).rejects.toThrow(/bundled with @anthropic-ai\/claude-agent-sdk/);
    await expect(
      assertClaudeExecutableCompatible(
        undefined,
        undefined,
        {},
        { readBundledClaudeVersion: bundledFn },
      ),
    ).rejects.toThrow(/Upgrade @anthropic-ai\/claude-agent-sdk/);
  });

  it("probes the explicit path and does not read the bundled version", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.220"), "2.1.220");
    const bundledFn = bundled(parseClaudeVersion("2.1.90"));
    const { logger, calls } = recordingLogger();

    await expect(
      assertClaudeExecutableCompatible(
        "/usr/local/bin/claude",
        logger,
        {},
        { probeClaudeVersion: probeFn, readBundledClaudeVersion: bundledFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).toHaveBeenCalledWith("/usr/local/bin/claude");
    expect(bundledFn).not.toHaveBeenCalled();
    expect((calls.debug[0] as unknown[])[0]).toMatchObject({
      versionSource: "explicit",
      claudeVersion: "2.1.220",
    });
  });

  it("is a no-op when AIF_CLAUDE_SKIP_VERSION_CHECK=1", async () => {
    vi.stubEnv("AIF_CLAUDE_SKIP_VERSION_CHECK", "1");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("is a no-op in unit tests (NODE_ENV=test without the integration flag)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("is a no-op under vitest (VITEST env set, no integration flag)", async () => {
    // vitest 4 marks the process with VITEST rather than NODE_ENV=test; the
    // guard treats either as a unit-test context so it never spawns a real
    // binary during the test suite.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("runs even under NODE_ENV=test when AIF_CLAUDE_INTEGRATION=1 (integration smoke)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AIF_CLAUDE_INTEGRATION", "1");
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).rejects.toThrow(/below the supported minimum/);
    expect(probeFn).toHaveBeenCalled();
  });

  it("is a no-op when the SDK query is mocked (unit tests)", async () => {
    (globalThis as { __AIF_CLAUDE_QUERY_MOCK__?: unknown }).__AIF_CLAUDE_QUERY_MOCK__ = () => {};
    const probeFn = probe(parseClaudeVersion("2.1.90"));

    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).resolves.toBeUndefined();
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("rejects a thrown error that is an instanceof ClaudeRuntimeAdapterError", async () => {
    const probeFn = probe(parseClaudeVersion("2.1.190"));
    await expect(
      assertClaudeExecutableCompatible(
        "/bin/claude",
        undefined,
        {},
        { probeClaudeVersion: probeFn },
      ),
    ).rejects.toBeInstanceOf(ClaudeRuntimeAdapterError);
  });
});
