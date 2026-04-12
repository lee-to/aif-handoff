import { spawn, execFileSync } from "node:child_process";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyClaudeResultSubtype, classifyClaudeRuntimeError } from "./errors.js";
import { normalizeClaudeEffort } from "./options.js";

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
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
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
 * Agent mode:  `claude --agent <name> --output-format stream-json --verbose -p`
 * Direct mode: `claude --output-format stream-json --verbose -p`
 *
 * The prompt itself is NOT passed on the command line — it is written to the
 * child's stdin in `runCliAttempt`. This keeps the prompt off argv so we do
 * not hit ARG_MAX / cmd.exe command-line limits on large prompts (rework
 * headers, full plans, task attachments can easily reach 100+ KB).
 *
 * stream-json is used instead of json so the CLI emits JSONL events as they
 * happen — text chunks, tool_use, session init — giving the runtime a live
 * feed of Agent Activity (onEvent/onToolUse callbacks) rather than a single
 * buffered blob at exit. --verbose is a hard requirement for the CLI to
 * actually stream intermediate events in stream-json mode.
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

  // Streaming JSONL output (required to surface Agent Activity in real time)
  args.push("--output-format", "stream-json", "--verbose");

  // Opt-in token-level deltas (only works with --print + stream-json)
  if (execution?.includePartialMessages) {
    args.push("--include-partial-messages");
  }

  // Model override
  if (input.model) {
    args.push("--model", input.model);
  }

  // Effort level (low, medium, high, max)
  const effort = normalizeClaudeEffort(options.effort);
  if (effort) {
    args.push("--effort", effort);
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

  // Non-interactive print mode — prompt itself is piped through stdin below.
  args.push("-p");

  return args;
}

// ---------------------------------------------------------------------------
// stream-json line processor
// ---------------------------------------------------------------------------

interface StreamJsonContentItem {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

interface StreamJsonMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  message?: {
    content?: StreamJsonContentItem[];
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface ClaudeCliStreamState {
  sessionId: string | null;
  outputText: string;
  assistantText: string;
  usage: RuntimeUsage | null;
  events: RuntimeEvent[];
  terminalErrorSubtype: string | null;
  terminalErrorDetail: string | null;
  plainTextFallback: string;
}

function createCliStreamState(fallbackSessionId: string | null): ClaudeCliStreamState {
  return {
    sessionId: fallbackSessionId,
    outputText: "",
    assistantText: "",
    usage: null,
    events: [],
    terminalErrorSubtype: null,
    terminalErrorDetail: null,
    plainTextFallback: "",
  };
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 80 ? `${input.slice(0, 77)}...` : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json.length <= 100) return json;
    return `${json.slice(0, 97)}...`;
  } catch {
    return "";
  }
}

function normalizeStreamJsonUsage(message: StreamJsonMessage): RuntimeUsage | null {
  const usage = message.usage;
  if (!usage) return null;
  const rawInput = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = rawInput + cacheCreation + cacheRead;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const costUsdRaw = message.total_cost_usd ?? message.cost_usd;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: typeof costUsdRaw === "number" ? costUsdRaw : undefined,
  };
}

function emitEvent(
  state: ClaudeCliStreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
}

function processStreamJsonLine(
  line: string,
  state: ClaudeCliStreamState,
  execution: RuntimeRunInput["execution"],
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: StreamJsonMessage;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as StreamJsonMessage;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  const nowIso = new Date().toISOString();

  if (message.type === "system" && message.subtype === "init") {
    if (typeof message.session_id === "string" && message.session_id.length > 0) {
      state.sessionId = message.session_id;
    }
    emitEvent(state, execution, {
      type: "system:init",
      timestamp: nowIso,
      level: "debug",
      message: "Runtime session initialized",
      data: { sessionId: state.sessionId },
    });
    return;
  }

  if (message.type === "assistant") {
    if (typeof message.session_id === "string" && !state.sessionId) {
      state.sessionId = message.session_id;
    }
    const content = message.message?.content;
    // When --include-partial-messages is on, Claude emits BOTH token-level
    // deltas (stream_event.content_block_delta.text_delta) AND the complete
    // assistant content block once it finishes. Emitting stream:text from
    // both sources would deliver the full text twice to callbacks that
    // concatenate (e.g. chat:token → fullAssistantResponse in the chat
    // route), so in partial-messages mode we only accumulate the full text
    // for fallback and rely on deltas for the live event stream.
    const partialMode = Boolean(execution?.includePartialMessages);
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
          state.assistantText += item.text;
          if (!partialMode) {
            emitEvent(state, execution, {
              type: "stream:text",
              timestamp: nowIso,
              level: "debug",
              message: item.text,
              data: { text: item.text },
            });
          }
        } else if (item.type === "tool_use" && typeof item.name === "string") {
          const summary = summarizeToolInput(item.input);
          const detailSuffix = summary ? ` ${summary}` : "";
          emitEvent(state, execution, {
            type: "tool:use",
            timestamp: nowIso,
            level: "info",
            message: `${item.name}${detailSuffix}`,
            data: { name: item.name, input: item.input },
          });
          execution?.onToolUse?.(item.name, detailSuffix);
        }
      }
    }
    return;
  }

  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (
      message.event?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      state.outputText += delta.text;
      emitEvent(state, execution, {
        type: "stream:text",
        timestamp: nowIso,
        level: "debug",
        message: delta.text,
        data: { text: delta.text },
      });
    }
    return;
  }

  if (message.type === "result") {
    state.usage = normalizeStreamJsonUsage(message);
    if (typeof message.session_id === "string") {
      state.sessionId = message.session_id;
    }
    const directResult = typeof message.result === "string" ? message.result : "";
    const subtype = message.subtype ?? "unknown";
    const isError = subtype !== "success" || message.is_error === true;

    if (isError) {
      state.terminalErrorSubtype = subtype;
      state.terminalErrorDetail = directResult || null;
      emitEvent(state, execution, {
        type: `result:${subtype}`,
        timestamp: nowIso,
        level: "error",
        message: `Query ended with subtype ${subtype}`,
        data: { subtype },
      });
      return;
    }

    // Success — finalize outputText. Prefer partial-message deltas, then
    // accumulated assistant text, then the final `result` field.
    if (!state.outputText) {
      state.outputText = state.assistantText || directResult;
    }
    emitEvent(state, execution, {
      type: "result:success",
      timestamp: nowIso,
      level: "info",
      message: "CLI execution completed",
      data: {
        numTurns: message.num_turns,
        durationMs: message.duration_ms,
      },
    });
    return;
  }

  // Other message types (rate_limit_event, etc.) — not surfaced.
}

function finalizeCliResult(
  state: ClaudeCliStreamState,
  fallbackSessionId: string | null,
): RuntimeRunResult {
  const outputText =
    state.outputText || state.assistantText || state.plainTextFallback.trim() || "";
  return {
    outputText,
    sessionId: state.sessionId ?? fallbackSessionId,
    usage: state.usage,
    events: state.events,
  };
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

  const state = createCliStreamState(input.sessionId ?? null);
  let stdoutBuffer = "";
  let stderr = "";

  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processStreamJsonLine(line, state, execution);
      newlineIdx = stdoutBuffer.indexOf("\n");
    }
  };

  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += String(chunk);
    try {
      flushCompleteLines();
    } catch (err) {
      logger?.error?.(
        { runtimeId: input.runtimeId, err },
        "Claude CLI stream-json processing error",
      );
    }
  });

  child.stderr!.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    execution?.onStderr?.(text);
  });

  // Prompt is streamed via stdin so it never lands on argv (ARG_MAX /
  // cmd.exe command-line limits would clip large rework/plan prompts).
  // Swallow EPIPE — the child may exit before the full prompt is flushed.
  child.stdin!.on("error", () => {
    /* ignore broken-pipe */
  });
  child.stdin!.write(input.prompt);
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

      // Flush any trailing buffer content as a final line.
      if (stdoutBuffer.length > 0) {
        try {
          processStreamJsonLine(stdoutBuffer, state, execution);
        } catch {
          /* ignore tail processing errors */
        }
        stdoutBuffer = "";
      }

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
        const message = `Claude CLI exited with code ${code}: ${stderr || state.outputText || state.plainTextFallback || "unknown error"}`;
        reject(classifyClaudeRuntimeError(message));
        return;
      }

      if (state.terminalErrorSubtype) {
        reject(classifyClaudeResultSubtype(state.terminalErrorSubtype, state.terminalErrorDetail));
        return;
      }

      resolve({
        result: finalizeCliResult(state, input.sessionId ?? null),
        startTimedOut: false,
      });
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
