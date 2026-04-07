import { spawn, execFileSync } from "node:child_process";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
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
    typeof exec?.timeoutMs === "number" &&
    Number.isFinite(exec.timeoutMs) &&
    exec.timeoutMs > 0
  ) {
    return Math.floor(exec.timeoutMs);
  }
  const metadata = asRecord(input.metadata);
  if (
    typeof metadata.timeoutMs === "number" &&
    Number.isFinite(metadata.timeoutMs) &&
    (metadata.timeoutMs as number) > 0
  ) {
    return Math.floor(metadata.timeoutMs as number);
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

export async function runClaudeCli(
  input: RuntimeRunInput,
  logger?: ClaudeCliLogger,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input, adapterDefaults?.pathToClaudeCodeExecutable);
  const args = buildCliArgs(input);
  const timeoutMs = resolveTimeoutMs(input);
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
      timeoutMs,
      hasAgent: args.includes("--agent"),
    },
    "Starting Claude CLI run",
  );

  return new Promise<RuntimeRunResult>((resolve, reject) => {
    /* v8 ignore next 2 -- Windows branch */
    const child = IS_WINDOWS
      ? spawnCliWindows(cliPath, args, input.cwd ?? input.projectRoot, env)
      : spawn(cliPath, args, { cwd: input.cwd ?? input.projectRoot, env, stdio: "pipe" });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      execution?.onStderr?.(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(classifyClaudeRuntimeError(error));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(classifyClaudeRuntimeError(`Claude CLI timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const message = `Claude CLI exited with code ${code}: ${stderr || stdout || "unknown error"}`;
        reject(classifyClaudeRuntimeError(message));
        return;
      }

      try {
        resolve(parseCliResult(stdout, input.sessionId ?? null));
      } catch (error) {
        reject(
          error instanceof Error && error.name === "ClaudeRuntimeAdapterError"
            ? error
            : classifyClaudeRuntimeError(error),
        );
      }
    });

    // Prompt is passed via -p flag, close stdin immediately to prevent
    // "no stdin data received" warnings from the CLI.
    child.stdin.end();

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
  });
}
