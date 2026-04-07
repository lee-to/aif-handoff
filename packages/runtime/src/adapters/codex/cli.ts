import { spawn, execFileSync } from "node:child_process";
import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
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
  // On Windows with shell: true, stdin piping through cmd.exe is unreliable.
  // Pass the prompt via --prompt arg instead to avoid "Reading prompt from stdin..." hangs.
  if (IS_WINDOWS && input.prompt) {
    args.push("--prompt", input.prompt);
  }
  return args;
}

const ALLOWED_ENV_PREFIXES = [
  "OPENAI_",
  "CODEX_",
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
  "FORCE_COLOR",
  "NO_COLOR",
];

function buildCuratedEnv(apiKeyEnvVar: string): Record<string, string> {
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
  return env;
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
  const metadata = asRecord(input.metadata);
  const value = metadata.timeoutMs;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 120_000;
}

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

function shouldWritePromptToStdin(args: string[]): boolean {
  return !args.some(
    (arg) => arg.includes("{prompt}") || arg === "--prompt" || arg.startsWith("--prompt="),
  );
}

export async function runCodexCli(
  input: RuntimeRunInput,
  logger?: CodexCliLogger,
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input);
  const args = normalizeCliArgs(input);
  const timeoutMs = resolveTimeoutMs(input);
  const options = asRecord(input.options);
  const apiKeyEnvVar =
    typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : "OPENAI_API_KEY";
  const env = buildCuratedEnv(apiKeyEnvVar);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      argCount: args.length,
      timeoutMs,
    },
    "Starting Codex CLI run",
  );

  return new Promise<RuntimeRunResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: input.cwd ?? input.projectRoot,
      env,
      stdio: "pipe",
      shell: IS_WINDOWS,
    });

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
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(classifyCodexRuntimeError(error));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(classifyCodexRuntimeError(`Codex CLI timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const message = `Codex CLI exited with code ${code}: ${stderr || stdout || "unknown error"}`;
        reject(classifyCodexRuntimeError(message));
        return;
      }

      try {
        resolve(parseCliResult(stdout, input.sessionId ?? null));
      } catch (error) {
        reject(classifyCodexRuntimeError(error));
      }
    });

    child.stdin.on("error", () => {
      // Ignore broken-pipe errors — the child may exit before stdin is fully written
    });
    if (shouldWritePromptToStdin(args)) {
      child.stdin.write(input.prompt);
    }
    child.stdin.end();
  });
}
