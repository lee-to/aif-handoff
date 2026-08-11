import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClaudeRuntimeAdapterError } from "./errors.js";

/**
 * Minimum supported Claude Code version.
 *
 * Builds below this reject empty `settings.attribution` strings at startup
 * (the spawned `claude` exits with code 1 and no stderr), which surfaces as
 * the opaque `Claude Code process exited with code 1`. Empty attribution
 * strings are the documented Co-Authored-By suppression mechanism and are
 * forwarded verbatim by {@link import("./options.js").buildClaudeQueryOptions},
 * so the adapter refuses to start a run against a binary that cannot accept
 * them instead of failing inside the SDK.
 *
 * 2.1.191 is the first release verified to accept empty attribution strings
 * via the SDK transport. The primary compatibility mechanism is the pinned
 * `@anthropic-ai/claude-agent-sdk`, whose bundled native Claude Code binary
 * (declared in its `manifest.json`, see {@link readBundledClaudeVersion})
 * ships at or above this minimum. This guard is the runtime backstop that
 * verifies the *exact* binary `query()` will launch — the bundled one (read
 * from the manifest) when no executable override is configured, or the
 * explicit `pathToClaudeCodeExecutable` otherwise.
 */
export const CLAUDE_MIN_VERSION = "2.1.191";

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

/** Parse the first `major.minor.patch` triple out of a version string. */
export function parseClaudeVersion(raw: string): ClaudeVersion | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(VERSION_PATTERN);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

const PARSED_MIN_VERSION: ClaudeVersion = (() => {
  const parsed = parseClaudeVersion(CLAUDE_MIN_VERSION);
  // Static guard: CLAUDE_MIN_VERSION is a literal above and must parse.
  if (!parsed) {
    throw new Error(`Unable to parse CLAUDE_MIN_VERSION="${CLAUDE_MIN_VERSION}"`);
  }
  return parsed;
})();

/** True when `version` is strictly below the supported minimum. */
export function isVersionBelowMin(version: ClaudeVersion): boolean {
  const min = PARSED_MIN_VERSION;
  if (version.major !== min.major) return version.major < min.major;
  if (version.minor !== min.minor) return version.minor < min.minor;
  return version.patch < min.patch;
}

export interface ClaudeVersionProbe {
  info: ClaudeVersion | null;
  raw: string | null;
  error: string | null;
}

export interface ProbeClaudeVersionOptions {
  timeoutMs?: number;
}

/**
 * Read the version of the Claude Code binary the Agent SDK launches when
 * `pathToClaudeCodeExecutable` is not specified.
 *
 * The SDK ships a per-platform native binary whose exact version is declared
 * in its `manifest.json` (`version` field). Reading that file yields the
 * precise artifact `query()` will run — no `--version` spawn, no PATH lookup,
 * and no platform/musl resolution ambiguity. This is how the version guard
 * inspects the *same* binary that will execute the run when no override is
 * configured (the invariant the guard exists to preserve).
 *
 * Resolves the package via its main entry and reads `manifest.json` from the
 * same directory (the SDK's `exports` map does not expose `manifest.json`
 * directly). Returns `null` when the package, file, or version cannot be
 * resolved so the caller can degrade (warn + proceed).
 */
export function readBundledClaudeVersion(): ClaudeVersion | null {
  try {
    const moduleRequire = createRequire(import.meta.url);
    const mainPath = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const manifestPath = join(dirname(mainPath), "manifest.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return parseClaudeVersion(typeof manifest.version === "string" ? manifest.version : "");
  } catch {
    return null;
  }
}

/**
 * Spawn `<executable> --version` (or `claude --version` on PATH when no path is
 * configured) and parse the reported version. Never rejects: an unparseable or
 * missing binary resolves to `{ info: null }` so the caller can decide whether
 * to enforce or degrade.
 */
export function probeClaudeVersion(
  executablePath: string | undefined,
  options: ProbeClaudeVersionOptions = {},
): Promise<ClaudeVersionProbe> {
  const command = executablePath ?? "claude";
  const timeoutMs = options.timeoutMs ?? 4_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ClaudeVersionProbe) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile(command, ["--version"], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        info: null,
        raw: null,
        error:
          err.code === "ENOENT"
            ? `Claude executable not found: ${command}`
            : `Failed to probe Claude executable: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      const parsed = parseClaudeVersion(combined);
      if (parsed) {
        finish({ info: parsed, raw: combined, error: null });
        return;
      }
      finish({
        info: null,
        raw: combined || null,
        error:
          combined.length > 0
            ? `Unable to parse Claude version from output: ${combined}`
            : `Claude --version exited with code ${code} and no output`,
      });
    });
  });
}

interface RuntimeGlobalWithQueryMock {
  __AIF_CLAUDE_QUERY_MOCK__?: unknown;
}

/** Unit tests install a query mock via this global; the guard is irrelevant then. */
function isClaudeQueryMocked(): boolean {
  return Boolean((globalThis as RuntimeGlobalWithQueryMock).__AIF_CLAUDE_QUERY_MOCK__);
}

export interface ClaudeVersionGuardLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface AssertClaudeVersionDeps {
  /** Test hook: inject a fake probe instead of spawning `claude`. */
  probeClaudeVersion?: (
    executablePath: string | undefined,
    options?: ProbeClaudeVersionOptions,
  ) => Promise<ClaudeVersionProbe>;
  /** Test hook: inject a fake bundled-version reader instead of reading manifest.json. */
  readBundledClaudeVersion?: () => ClaudeVersion | null;
}

interface CachedProbe {
  probe: ClaudeVersionProbe;
}

/** Process-lifetime cache keyed by executable path (versions do not change mid-process). */
const probeCache = new Map<string, CachedProbe>();

/**
 * Upgrade guidance for the below-minimum error. For an explicit executable
 * override the user controls that binary (`npm i -g`); for the SDK-bundled
 * binary the version is coupled to `@anthropic-ai/claude-agent-sdk`, so the
 * fix is to bump that dependency.
 */
function formatUpgradeHint(
  source: "explicit" | "bundled",
  executablePath: string | undefined,
): string {
  return source === "bundled"
    ? "Upgrade @anthropic-ai/claude-agent-sdk in this project to a release whose bundled Claude Code is at or above the minimum"
    : executablePath
      ? `Upgrade the binary at ${executablePath}: npm i -g @anthropic-ai/claude-code@latest`
      : "Install/upgrade Claude Code: npm i -g @anthropic-ai/claude-code@latest";
}

interface ResolvedVersion {
  info: ClaudeVersion | null;
  raw: string | null;
  error: string | null;
  source: "explicit" | "bundled";
}

/**
 * Resolve the version of the exact Claude Code binary `query()` will launch:
 *
 * - `executablePath` set → spawn `<path> --version`. `buildClaudeQueryOptions`
 *   forwards the same path to `query()`, so the probed artifact is the launched
 *   artifact.
 * - `executablePath` unset → the Agent SDK runs its bundled native binary; read
 *   that version from `manifest.json` via {@link readBundledClaudeVersion}. No
 *   PATH lookup, so the guard never inspects a different `claude` than the one
 *   the SDK starts.
 *
 * Results are cached per key for the process lifetime (skipped when dependency
 * injection is used, so unit tests stay hermetic).
 */
async function resolveEffectiveVersion(
  executablePath: string | undefined,
  probeFn: NonNullable<AssertClaudeVersionDeps["probeClaudeVersion"]>,
  readBundledFn: NonNullable<AssertClaudeVersionDeps["readBundledClaudeVersion"]>,
  deps: AssertClaudeVersionDeps | undefined,
): Promise<ResolvedVersion> {
  if (executablePath) {
    const cacheKey = executablePath;
    let probe = deps ? undefined : probeCache.get(cacheKey)?.probe;
    if (!probe) {
      probe = await probeFn(executablePath);
      if (!deps) probeCache.set(cacheKey, { probe });
    }
    return { ...probe, source: "explicit" };
  }

  const cacheKey = "<bundled>";
  let probe = deps ? undefined : probeCache.get(cacheKey)?.probe;
  if (!probe) {
    const info = readBundledFn();
    probe = info
      ? { info, raw: info.raw, error: null }
      : {
          info: null,
          raw: null,
          error:
            "Unable to read the bundled Claude Code version from @anthropic-ai/claude-agent-sdk manifest.json",
        };
    if (!deps) probeCache.set(cacheKey, { probe });
  }
  return { ...probe, source: "bundled" };
}

/**
 * Enforce the minimum Claude Code version before a run starts.
 *
 * - Below minimum → throws {@link ClaudeRuntimeAdapterError} (code
 *   `CLAUDE_VERSION_UNSUPPORTED`, category `transport`) with an actionable
 *   message, instead of the opaque `Claude Code process exited with code 1`.
 * - Version undeterminable (binary missing / unparseable output / manifest
 *   unreadable) → logs a warning and proceeds; the run itself surfaces real
 *   failures via {@link import("./diagnostics.js").diagnoseClaudeError}.
 *   Enforcing on uncertainty would block valid setups.
 * - At/above minimum → logs the effective version at debug.
 *
 * The inspected binary is always the one `query()` will launch: the explicit
 * `pathToClaudeCodeExecutable` when one is configured, otherwise the Agent
 * SDK's bundled binary (version read from `manifest.json`). The guard never
 * probes an unrelated `claude` on PATH.
 *
 * Skipped entirely in unit tests (the `VITEST` env var or `NODE_ENV === "test"`,
 * without the integration flag), when the SDK query is mocked, or when
 * `AIF_CLAUDE_SKIP_VERSION_CHECK=1` is set. The integration smoke test forces
 * the check on via `AIF_CLAUDE_INTEGRATION=1`.
 */
export async function assertClaudeExecutableCompatible(
  executablePath: string | undefined,
  logger?: ClaudeVersionGuardLogger,
  context: Record<string, unknown> = {},
  deps?: AssertClaudeVersionDeps,
): Promise<void> {
  const isIntegration = process.env.AIF_CLAUDE_INTEGRATION === "1";
  if (
    process.env.AIF_CLAUDE_SKIP_VERSION_CHECK === "1" ||
    isClaudeQueryMocked() ||
    ((Boolean(process.env.VITEST) || process.env.NODE_ENV === "test") && !isIntegration)
  ) {
    return;
  }
  const probeFn = deps?.probeClaudeVersion ?? probeClaudeVersion;
  const readBundledFn = deps?.readBundledClaudeVersion ?? readBundledClaudeVersion;

  const { info, raw, error, source } = await resolveEffectiveVersion(
    executablePath,
    probeFn,
    readBundledFn,
    deps,
  );

  if (!info) {
    logger?.warn?.(
      {
        ...context,
        executablePath: executablePath ?? null,
        versionSource: source,
        probeError: error,
        probeOutput: raw,
        minVersion: CLAUDE_MIN_VERSION,
      },
      "WARN [runtime:claude] Could not determine Claude Code version; skipping compatibility check (run may fail if the binary is outdated)",
    );
    return;
  }

  const location =
    source === "bundled"
      ? "bundled with @anthropic-ai/claude-agent-sdk"
      : (executablePath ?? "PATH");

  if (isVersionBelowMin(info)) {
    throw new ClaudeRuntimeAdapterError(
      `Claude Code ${info.raw} at ${location} is below the supported minimum ` +
        `${CLAUDE_MIN_VERSION}: older builds reject the empty attribution strings used to suppress ` +
        `Co-Authored-By trailers and exit with code 1. ${formatUpgradeHint(source, executablePath)}`,
      "CLAUDE_VERSION_UNSUPPORTED",
      "transport",
    );
  }

  logger?.debug?.(
    {
      ...context,
      executablePath: executablePath ?? null,
      versionSource: source,
      claudeVersion: info.raw,
      minVersion: CLAUDE_MIN_VERSION,
    },
    "[runtime:claude] Claude Code version compatibility check passed",
  );
}
