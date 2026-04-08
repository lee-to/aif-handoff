import { spawn, execFileSync } from "node:child_process";
import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyCodexRuntimeError } from "./errors.js";

const IS_WINDOWS = process.platform === "win32";

export interface CodexCliLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.filter((entry): entry is string => typeof entry === "string");
  return parsed.length > 0 ? parsed : null;
}

function normalizeCliArgs(input: RuntimeRunInput): string[] {
  const options = asRecord(input.options);
  const configured = readStringArray(options.codexCliArgs);

  // Custom args — apply template substitutions
  if (configured) {
    return configured.map((arg) => {
      if (arg.includes("{prompt}")) return arg.replaceAll("{prompt}", input.prompt);
      if (arg.includes("{model}")) return arg.replaceAll("{model}", input.model ?? "");
      if (arg.includes("{session_id}"))
        return arg.replaceAll("{session_id}", input.sessionId ?? "");
      return arg;
    });
  }

  // Default args — resume session or fresh exec
  const args: string[] = ["exec"];
  if (input.resume && input.sessionId) {
    args.push("resume", input.sessionId);
  }
  args.push("--json");
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.prompt) {
    args.push(input.prompt);
  }
  return args;
}

const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_",
  "FORCE_COLOR",
  "NO_COLOR",
];

/**
 * Env vars that must NOT be forwarded to the Codex CLI even if they match
 * an allowed prefix.  `OPENAI_BASE_URL` is deprecated by the Codex CLI —
 * it causes a WebSocket endpoint mis-derivation (`wss://.../v1/responses`)
 * and 500 errors.  The CLI reads `openai_base_url` from `config.toml` instead.
 */
const BLOCKED_ENV_KEYS = new Set(["OPENAI_BASE_URL"]);

interface CuratedEnvResult {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  blockedCount: number;
  droppedDisallowedPrefixKeys: string[];
}

function buildCuratedEnv(apiKeyEnvVar: string): CuratedEnvResult {
  const env: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  let blockedCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (BLOCKED_ENV_KEYS.has(key)) {
      blockedCount += 1;
      continue;
    }
    if (
      key === apiKeyEnvVar ||
      ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))
    ) {
      env[key] = value;
      forwardedCount += 1;
    } else {
      filteredCount += 1;
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }
  return {
    env,
    forwardedCount,
    filteredCount,
    blockedCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
}

function resolveCliPath(input: RuntimeRunInput): string {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

/**
 * Probe whether the Codex CLI is actually reachable by running `codex --version`.
 * On Windows bare command names like `"codex"` need `shell: true` to resolve `.cmd`.
 */
export function probeCodexCli(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execFileSync(cliPath, ["--version"], {
      timeout: 5_000,
      shell: IS_WINDOWS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, version: out.toString().trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function resolveTimeoutMs(input: RuntimeRunInput): number {
  const exec = input.execution;
  if (
    typeof exec?.runTimeoutMs === "number" &&
    Number.isFinite(exec.runTimeoutMs) &&
    exec.runTimeoutMs > 0
  ) {
    return Math.floor(exec.runTimeoutMs);
  }
  return 120_000;
}

/* v8 ignore start -- Windows-only spawn logic, untestable in macOS/Linux CI */
function quoteIfNeeded(arg: string): string {
  return arg.includes(" ") || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function spawnCliWindows(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
) {
  const cmd = process.env.ComSpec ?? "cmd.exe";
  const cmdLine = [cliPath, ...args.map(quoteIfNeeded)].join(" ");
  return spawn(cmd, ["/d", "/c", cmdLine], {
    cwd,
    env,
    stdio: "pipe",
    windowsVerbatimArguments: true,
  });
}
/* v8 ignore stop */

/**
 * Parse JSONL output from `codex exec --json`.
 * Each line is a JSON event. We extract the final agent message text,
 * session/thread ID, and usage from relevant events.
 *
 * Falls back to single-JSON parsing for backwards compat with older CLI versions.
 */
function parseCliResult(stdout: string, fallbackSessionId: string | null): RuntimeRunResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { outputText: "", sessionId: fallbackSessionId };
  }

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  const events: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // non-JSON line — skip
    }
  }

  // No parseable events — try single JSON blob (backwards compat)
  if (events.length === 0) {
    return { outputText: trimmed, sessionId: fallbackSessionId, raw: trimmed };
  }

  // Single JSON object (old format) — handle directly
  if (events.length === 1 && (events[0].outputText || events[0].result)) {
    const parsed = events[0];
    const usage = parsed.usage as Record<string, number> | undefined;
    return {
      outputText: String(parsed.outputText ?? parsed.result ?? ""),
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : fallbackSessionId,
      usage: usage
        ? {
            inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
            outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
            totalTokens:
              usage.totalTokens ??
              usage.total_tokens ??
              (usage.inputTokens ?? usage.input_tokens ?? 0) +
                (usage.outputTokens ?? usage.output_tokens ?? 0),
            costUsd: usage.costUsd ?? usage.cost_usd,
          }
        : undefined,
      events: Array.isArray(parsed.events)
        ? (parsed.events as Array<Record<string, unknown>>).map((e) => ({
            type: String(e.type ?? "unknown"),
            timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
            message: typeof e.message === "string" ? e.message : undefined,
            data: e.data as Record<string, unknown> | undefined,
          }))
        : undefined,
      raw: parsed,
    };
  }

  // JSONL events stream — extract output text, session ID, and usage
  let outputText = "";
  let sessionId = fallbackSessionId;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;

  for (const event of events) {
    const type = String(event.type ?? "");

    // Thread/session started
    if (type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }

    // Agent message completed — collect text
    if (type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        if (outputText) outputText += "\n\n";
        outputText += item.text;
      }
    }

    // Turn completed — collect usage
    if (type === "turn.completed") {
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
      }
    }

    // Message event with text (alternative format)
    if (type === "message" && typeof event.text === "string") {
      if (outputText) outputText += "\n\n";
      outputText += event.text;
    }
  }

  const totalTokens = inputTokens + outputTokens;
  return {
    outputText,
    sessionId,
    usage: totalTokens > 0 ? { inputTokens, outputTokens, totalTokens, costUsd } : undefined,
    events: events.map((e) => ({
      type: String(e.type ?? "unknown"),
      timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
      message: typeof e.message === "string" ? e.message : undefined,
      data: e,
    })),
    raw: events,
  };
}

function shouldWritePromptToStdin(args: string[], prompt: string): boolean {
  if (prompt && args.includes(prompt)) {
    return false;
  }
  return !args.some(
    (arg) => arg.includes("{prompt}") || arg === "--prompt" || arg.startsWith("--prompt="),
  );
}

function spawnCodexProcess(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
): ReturnType<typeof spawn> {
  /* v8 ignore next 2 -- Windows branch */
  return IS_WINDOWS
    ? spawnCliWindows(cliPath, args, input.cwd ?? input.projectRoot, env)
    : spawn(cliPath, args, { cwd: input.cwd ?? input.projectRoot, env, stdio: "pipe" });
}

function runCodexCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  logger?: CodexCliLogger,
): Promise<{ result: RuntimeRunResult; startTimedOut: boolean }> {
  const execution = input.execution;
  const child = spawnCodexProcess(input, cliPath, args, env);

  // Attach shared timeout utilities
  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution?.startTimeoutMs,
    runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
  });

  let stdout = "";
  let stderr = "";

  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
  });

  child.stderr!.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  child.stdin!.on("error", () => {
    // Ignore broken-pipe errors — the child may exit before stdin is fully written
  });
  if (shouldWritePromptToStdin(args, input.prompt)) {
    child.stdin!.write(input.prompt);
  }
  child.stdin!.end();

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      timeouts.cleanup();
      reject(classifyCodexRuntimeError(error));
    });

    child.on("close", async (code) => {
      timeouts.cleanup();

      const startTimedOut = await timeouts.startTimedOut;

      if (startTimedOut) {
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: execution?.startTimeoutMs },
          "Codex CLI start timeout — process produced no output",
        );
        resolve({ result: null as unknown as RuntimeRunResult, startTimedOut: true });
        return;
      }

      if (timeouts.runTimedOut) {
        const runMs = execution?.runTimeoutMs ?? resolveTimeoutMs(input);
        reject(makeProcessRunTimeoutError(runMs));
        return;
      }

      if (code !== 0) {
        const message = `Codex CLI exited with code ${code}: ${stderr || stdout || "unknown error"}`;
        reject(classifyCodexRuntimeError(message));
        return;
      }

      try {
        resolve({ result: parseCliResult(stdout, input.sessionId ?? null), startTimedOut: false });
      } catch (error) {
        reject(classifyCodexRuntimeError(error));
      }
    });
  });
}

export async function runCodexCli(
  input: RuntimeRunInput,
  logger?: CodexCliLogger,
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input);
  const args = normalizeCliArgs(input);
  const options = asRecord(input.options);
  const apiKeyEnvVar =
    typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : "OPENAI_API_KEY";
  const curatedEnv = buildCuratedEnv(apiKeyEnvVar);
  const env = curatedEnv.env;
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      forwardedEnvCount: curatedEnv.forwardedCount,
      filteredEnvCount: curatedEnv.filteredCount,
      blockedEnvCount: curatedEnv.blockedCount,
      droppedDisallowedPrefixCount: curatedEnv.droppedDisallowedPrefixKeys.length,
    },
    "DEBUG [runtime:codex] Built Codex CLI environment from curated allowlist",
  );
  if (curatedEnv.droppedDisallowedPrefixKeys.length > 0) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        transport: "cli",
        droppedDisallowedPrefixKeys: curatedEnv.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:codex] Dropped disallowed environment prefix keys while building Codex CLI environment",
    );
  }

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      argCount: args.length,
      startTimeoutMs: input.execution?.startTimeoutMs ?? null,
      runTimeoutMs: input.execution?.runTimeoutMs ?? resolveTimeoutMs(input),
    },
    "Starting Codex CLI run",
  );

  const { result, startTimedOut } = await runCodexCliAttempt(input, cliPath, args, env, logger);

  if (startTimedOut) {
    const retryDelayMs = resolveRetryDelay(input.execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "Codex CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    const retry = await runCodexCliAttempt(input, cliPath, args, env, logger);
    if (retry.startTimedOut) {
      throw makeProcessStartTimeoutError(input.execution?.startTimeoutMs ?? 0);
    }
    return retry.result;
  }

  return result;
}
