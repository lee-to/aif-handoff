import { spawn, execFileSync } from "node:child_process";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyClaudeRuntimeError } from "./errors.js";

const IS_WINDOWS = process.platform === "win32";

export interface ClaudeCliLogger {
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

const ALLOWED_ENV_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "CLAUDE_",
  "AIF_",
  "HANDOFF_",
  "NODE_",
  "npm_",
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
  "EDITOR",
  "VISUAL",
  "FORCE_COLOR",
  "NO_COLOR",
];

function buildCuratedEnv(
  apiKeyEnvVar: string,
  executionEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (
      key === apiKeyEnvVar ||
      ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, executionEnv ?? {});
  return env;
}

function resolveCliPath(input: RuntimeRunInput, adapterDefault?: string): string {
  const options = asRecord(input.options);
  return (
    readString(options.claudeCliPath) ??
    readString(process.env.CLAUDE_CLI_PATH) ??
    adapterDefault ??
    "claude"
  );
}

/**
 * Probe whether the Claude CLI is actually reachable by running `claude --version`.
 * On Windows bare command names like `"claude"` need `shell: true` to resolve `.cmd`.
 */
export function probeClaudeCli(cliPath: string): { ok: boolean; version?: string; error?: string } {
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

function resolveTimeoutMs(input: RuntimeRunInput): number {
  const exec = input.execution;
  if (
    typeof exec?.runTimeoutMs === "number" &&
    Number.isFinite(exec.runTimeoutMs) &&
    exec.runTimeoutMs > 0
  ) {
    return Math.floor(exec.runTimeoutMs);
  }
  return 300_000;
}

/**
 * Build CLI args for the `claude` binary.
 *
 * Agent mode:  `claude --agent <name> --output-format json -p "<prompt>"`
 * Direct mode: `claude --output-format json -p "<prompt>"`
 *
 * With --yes to accept all permission prompts (non-interactive).
 */
function buildCliArgs(input: RuntimeRunInput): string[] {
  const execution = input.execution;
  const options = asRecord(input.options);
  const args: string[] = [];

  // Agent definition — spawns subagent via --agent flag
  const agentName = execution?.agentDefinitionName ?? readString(options.agentDefinitionName);
  if (agentName) {
    args.push("--agent", agentName);
  }

  // Output format
  args.push("--output-format", "json");

  // Model override
  if (input.model) {
    args.push("--model", input.model);
  }

  // Max turns
  if (execution?.maxTurns) {
    args.push("--max-turns", String(execution.maxTurns));
  }

  // Resume session
  if (input.resume && input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  // System prompt append
  const systemAppend = execution?.systemPromptAppend ?? readString(options.systemPromptAppend);
  if (systemAppend) {
    args.push("--append-system-prompt", systemAppend);
  }

  // Permission mode
  if (execution?.bypassPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "acceptEdits");
  }

  // Prompt
  args.push("-p", input.prompt);

  return args;
}

interface ClaudeJsonOutput {
  result?: string;
  session_id?: string;
  is_error?: boolean;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function parseCliResult(stdout: string, fallbackSessionId: string | null): RuntimeRunResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { outputText: "", sessionId: fallbackSessionId };
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeJsonOutput;

    if (parsed.is_error) {
      throw classifyClaudeRuntimeError(parsed.result ?? "Claude CLI returned an error");
    }

    let usage: RuntimeUsage | null = null;
    if (parsed.usage) {
      const inputTokens =
        (parsed.usage.input_tokens ?? 0) +
        (parsed.usage.cache_creation_input_tokens ?? 0) +
        (parsed.usage.cache_read_input_tokens ?? 0);
      const outputTokens = parsed.usage.output_tokens ?? 0;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: parsed.usage.total_tokens ?? inputTokens + outputTokens,
        costUsd: parsed.cost_usd,
      };
    }

    const events: RuntimeEvent[] = [];
    if (parsed.result) {
      events.push({
        type: "result:success",
        timestamp: new Date().toISOString(),
        level: "info",
        message: "CLI execution completed",
        data: {
          numTurns: parsed.num_turns,
          durationMs: parsed.duration_ms,
        },
      });
    }

    return {
      outputText: parsed.result ?? "",
      sessionId: parsed.session_id ?? fallbackSessionId,
      usage,
      events,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "ClaudeRuntimeAdapterError") throw error;

    // Not valid JSON — treat the whole output as plain text
    return {
      outputText: trimmed,
      sessionId: fallbackSessionId,
      raw: trimmed,
    };
  }
}

function spawnCliProcess(
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

function runCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  args: string[],
  env: Record<string, string>,
  logger?: ClaudeCliLogger,
): Promise<{ result: RuntimeRunResult; startTimedOut: boolean }> {
  const execution = input.execution;
  const child = spawnCliProcess(input, cliPath, args, env);

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
    const text = String(chunk);
    stderr += text;
    execution?.onStderr?.(text);
  });

  // Prompt is passed via -p flag, close stdin immediately to prevent
  // "no stdin data received" warnings from the CLI.
  child.stdin!.end();

  // If abort is requested, kill the child
  if (execution?.abortController) {
    execution.abortController.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM");
      },
      { once: true },
    );
  }

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      timeouts.cleanup();
      reject(classifyClaudeRuntimeError(error));
    });

    child.on("close", async (code) => {
      timeouts.cleanup();

      const startTimedOut = await timeouts.startTimedOut;

      if (startTimedOut) {
        const startMs = execution?.startTimeoutMs ?? 0;
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: startMs },
          "Claude CLI start timeout — process produced no output",
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
        const message = `Claude CLI exited with code ${code}: ${stderr || stdout || "unknown error"}`;
        reject(classifyClaudeRuntimeError(message));
        return;
      }

      try {
        resolve({ result: parseCliResult(stdout, input.sessionId ?? null), startTimedOut: false });
      } catch (error) {
        reject(
          error instanceof Error && error.name === "ClaudeRuntimeAdapterError"
            ? error
            : classifyClaudeRuntimeError(error),
        );
      }
    });
  });
}

export async function runClaudeCli(
  input: RuntimeRunInput,
  logger?: ClaudeCliLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input, adapterDefaults?.pathToClaudeCodeExecutable);
  const args = buildCliArgs(input);
  const execution = input.execution;
  const options = asRecord(input.options);
  const apiKeyEnvVar =
    typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : "ANTHROPIC_API_KEY";
  const env = buildCuratedEnv(apiKeyEnvVar, execution?.environment);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      argCount: args.length,
      startTimeoutMs: execution?.startTimeoutMs ?? null,
      runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
      hasAgent: args.includes("--agent"),
    },
    "Starting Claude CLI run",
  );

  const { result, startTimedOut } = await runCliAttempt(input, cliPath, args, env, logger);

  if (startTimedOut) {
    // Single retry after start timeout
    const retryDelayMs = resolveRetryDelay(execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "Claude CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    const retry = await runCliAttempt(input, cliPath, args, env, logger);
    if (retry.startTimedOut) {
      throw makeProcessStartTimeoutError(execution?.startTimeoutMs ?? 0);
    }
    return retry.result;
  }

  return result;
}
