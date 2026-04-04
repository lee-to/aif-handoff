import { spawn } from "node:child_process";
import type { RuntimeRunInput, RuntimeRunResult } from "../../types.js";
import { classifyCodexRuntimeError } from "./errors.js";

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
  const args = configured ?? ["run", "--json"];

  return args.map((arg) => {
    if (arg.includes("{prompt}")) return arg.replaceAll("{prompt}", input.prompt);
    if (arg.includes("{model}")) return arg.replaceAll("{model}", input.model ?? "");
    if (arg.includes("{session_id}")) return arg.replaceAll("{session_id}", input.sessionId ?? "");
    return arg;
  });
}

function resolveCliPath(input: RuntimeRunInput): string {
  const options = asRecord(input.options);
  return readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH) ?? "codex";
}

function resolveTimeoutMs(input: RuntimeRunInput): number {
  const metadata = asRecord(input.metadata);
  const value = metadata.timeoutMs;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 120_000;
}

function parseCliResult(stdout: string, fallbackSessionId: string | null): RuntimeRunResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      outputText: "",
      sessionId: fallbackSessionId,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      outputText?: string;
      result?: string;
      sessionId?: string | null;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        costUsd?: number;
      };
      events?: Array<{
        type: string;
        timestamp?: string;
        message?: string;
        data?: Record<string, unknown>;
      }>;
    };

    return {
      outputText: parsed.outputText ?? parsed.result ?? "",
      sessionId: parsed.sessionId ?? fallbackSessionId,
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.inputTokens ?? 0,
            outputTokens: parsed.usage.outputTokens ?? 0,
            totalTokens:
              parsed.usage.totalTokens ??
              (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0),
            costUsd: parsed.usage.costUsd,
          }
        : undefined,
      events: parsed.events?.map((event) => ({
        type: event.type,
        timestamp: event.timestamp ?? new Date().toISOString(),
        message: event.message,
        data: event.data,
      })),
      raw: parsed,
    };
  } catch {
    return {
      outputText: trimmed,
      sessionId: fallbackSessionId,
      raw: trimmed,
    };
  }
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
  const env = {
    ...process.env,
    ...(asRecord(input.options).apiKey
      ? {
          OPENAI_API_KEY: String(asRecord(input.options).apiKey),
        }
      : {}),
  };

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

    if (shouldWritePromptToStdin(args)) {
      child.stdin.write(input.prompt);
    }
    child.stdin.end();
  });
}
