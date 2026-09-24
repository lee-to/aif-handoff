import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  withProcessTimeouts,
} from "../../timeouts.js";
import { classifyAntigravityRuntimeError, AntigravityRuntimeAdapterError } from "./errors.js";
import { resolveCliPath } from "./findPath.js";
import { assertSafeWindowsShellExecutablePath } from "../../shellSafety.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { DEFAULT_ANTIGRAVITY_MODEL } from "./models.js";
import { PROXY_ENV_VARS } from "../../proxyEnv.js";

const IS_WINDOWS = process.platform === "win32";

function spawnSubprocess(
  cliPath: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string>,
) {
  if (IS_WINDOWS) {
    assertSafeWindowsShellExecutablePath(cliPath, "Antigravity CLI path");
    const lower = cliPath.toLowerCase().trim().replace(/\.+$/, "");
    if (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower === "agy") {
      // Node.js on Windows will auto-resolve 'agy' to 'agy.cmd' if it exists in PATH before 'agy.exe'.
      // To strictly prevent cmd.exe spawning, we require the explicit .exe extension on Windows.
      if (!lower.endsWith(".exe")) {
        throw new AntigravityRuntimeAdapterError(
          `Executing Antigravity via batch script or ambiguous path (${cliPath}) is prohibited to prevent Windows shell injection. Point explicitly to agy.exe.`,
          "ANTIGRAVITY_SECURITY_VIOLATION",
          "permission",
        );
      }
    }
  } else {
    const lower = cliPath.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      throw new AntigravityRuntimeAdapterError(
        `Executing Antigravity via batch script (${cliPath}) is prohibited.`,
        "ANTIGRAVITY_SECURITY_VIOLATION",
        "permission",
      );
    }
  }

  return spawn(cliPath, args, {
    cwd,
    shell: false,
    windowsHide: true,
    env,
    detached: !IS_WINDOWS,
  });
}

export interface AntigravityCliLogger {
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
  "ANTIGRAVITY_",
  "GEMINI_",
  "GOOGLE_",
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
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  ...PROXY_ENV_VARS,
];

export function buildCuratedEnv(
  executionEnv?: Record<string, string>,
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value == null) continue;
    const upperKey = key.toUpperCase();
    if (
      ALLOWED_ENV_PREFIXES.some((prefix) => {
        const upperPrefix = prefix.toUpperCase();
        return upperKey === upperPrefix || upperKey.startsWith(upperPrefix);
      })
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, executionEnv ?? {});
  return env;
}

function resolveTimeoutMs(input: RuntimeRunInput): number {
  return input.execution?.runTimeoutMs ?? 1_800_000; // 30m default
}

export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
  if (platform === "win32") {
    let succeeded = false;
    try {
      const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      succeeded = !res?.error && res?.status === 0;
    } catch {
      succeeded = false;
    }
    if (!succeeded) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

interface StreamState {
  sessionId: string | null;
  outputText: string;
  usage: RuntimeUsage | null;
  events: RuntimeEvent[];
  plainTextFallback: string;
}

function createStreamState(fallbackSessionId: string | null): StreamState {
  return {
    sessionId: fallbackSessionId,
    outputText: "",
    usage: null,
    events: [],
    plainTextFallback: "",
  };
}

function emitEvent(
  state: StreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
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

function processStreamJsonLine(
  line: string,
  state: StreamState,
  input: RuntimeRunInput,
  _logger?: AntigravityCliLogger,
): void {
  const execution = input.execution;
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as Record<string, unknown>;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  const nowIso = new Date().toISOString();

  // Event 1: init
  if (message.event === "init") {
    if (typeof message.conversation_id === "string" && message.conversation_id.length > 0) {
      state.sessionId = message.conversation_id;
    }
    const initData = asRecord(message.init);
    emitEvent(state, execution, {
      type: "system:init",
      timestamp: nowIso,
      level: "debug",
      message: "Antigravity session initialized",
      data: { sessionId: state.sessionId, model: initData.model },
    });
    return;
  }

  // Event 2: step_update
  if (message.event === "step_update") {
    const su = asRecord(message.step_update);
    if (su.step_type === "agent_response" && typeof su.text_delta === "string") {
      state.outputText += su.text_delta;
      emitEvent(state, execution, {
        type: "stream:text",
        timestamp: nowIso,
        level: "debug",
        message: su.text_delta,
        data: { text: su.text_delta },
      });
    }

    // Check tool calls
    if (
      su.step_type === "tool" ||
      su.step_type === "tool_call" ||
      su.tool_calls ||
      su.tool_name ||
      su.tool_info
    ) {
      // When tool execution completes (state === "DONE"), emit tool:result and do not
      // re-emit tool:use to avoid duplicate tool logging in chat/agent activity streams.
      if (su.state === "DONE" && (su.step_type === "tool" || su.step_type === "tool_call")) {
        const toolInfo = asRecord(su.tool_info);
        const toolName = String(su.tool_name ?? toolInfo.name ?? "unknown_tool");
        const toolUseId =
          typeof su.tool_id === "string"
            ? su.tool_id
            : typeof su.call_id === "string"
              ? su.call_id
              : su.step_index != null
                ? `step-${su.step_index}`
                : null;
        const output = toolInfo.output ?? su.tool_output ?? su.result;
        emitEvent(state, execution, {
          type: "tool:result",
          timestamp: nowIso,
          level: "info",
          message: summarizeToolInput(output),
          data: { name: toolName, id: toolUseId, output },
        });
        return;
      }

      const toolInfo = asRecord(su.tool_info);
      const rawToolCalls = Array.isArray(su.tool_calls) ? su.tool_calls : [];
      const toolCalls =
        rawToolCalls.length > 0
          ? rawToolCalls.map(asRecord)
          : su.tool_name || toolInfo.name
            ? [
                {
                  name: su.tool_name ?? toolInfo.name,
                  id:
                    su.tool_id ??
                    su.call_id ??
                    (su.step_index != null ? `step-${su.step_index}` : null),
                  input: toolInfo.parameters ?? su.tool_input ?? su.arguments,
                },
              ]
            : [];

      for (const tc of toolCalls) {
        const toolName = String(tc.name ?? tc.tool_name ?? "unknown_tool");
        const toolUseId = typeof tc.id === "string" ? tc.id : null;
        const toolInput = tc.input ?? tc.arguments;
        const summary = summarizeToolInput(toolInput);
        const detailSuffix = summary ? ` ${summary}` : "";
        for (const ev of buildToolUseEvents({
          toolName,
          toolUseId,
          input: toolInput,
          timestamp: nowIso,
          detailSuffix,
        })) {
          emitEvent(state, execution, ev);
        }
        execution?.onToolUse?.(toolName, detailSuffix);
      }
    }

    if (su.usage) {
      const u = asRecord(su.usage);
      const inTokens = Number(u.input_tokens) || 0;
      const outTokens = Number(u.output_tokens) || 0;
      const totalTokens = Number(u.total_tokens) || inTokens + outTokens;
      state.usage = {
        inputTokens: inTokens,
        outputTokens: outTokens,
        totalTokens,
      };
    }
    return;
  }

  // Event 3: result
  if (message.event === "result") {
    const res = asRecord(message.result);
    if (typeof res.response === "string" && !state.outputText) {
      state.outputText = res.response;
    }
    if (res.usage) {
      const u = asRecord(res.usage);
      const inTokens = Number(u.input_tokens) || 0;
      const outTokens = Number(u.output_tokens) || 0;
      const totalTokens = Number(u.total_tokens) || inTokens + outTokens;
      state.usage = {
        inputTokens: inTokens,
        outputTokens: outTokens,
        totalTokens,
      };
    }
    return;
  }
}

function composeFullPrompt(input: RuntimeRunInput): string {
  const options = asRecord(input.options);
  const execution = input.execution;
  const systemAppend = execution?.systemPromptAppend ?? readString(options.systemPromptAppend);
  const parts: string[] = [];
  if (input.systemPrompt?.trim()) {
    parts.push(`[SYSTEM PROMPT]:\n${input.systemPrompt.trim()}`);
  }
  if (input.prompt) {
    parts.push(input.prompt);
  }
  if (systemAppend?.trim()) {
    parts.push(`[SYSTEM INSTRUCTIONS]:\n${systemAppend.trim()}`);
  }
  return parts.join("\n\n");
}

function buildCliArgs(input: RuntimeRunInput, tempLogFile: string): string[] {
  const options = asRecord(input.options);
  const execution = input.execution;

  const model = input.model || DEFAULT_ANTIGRAVITY_MODEL;
  const timeoutMs = resolveTimeoutMs(input);
  const printTimeoutMinutes = Math.max(5, Math.ceil(timeoutMs / 60_000));

  const args: string[] = [
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${printTimeoutMinutes}m`,
    "--log-file",
    tempLogFile,
    "--mode",
    "accept-edits",
  ];

  if (typeof options.project === "string" && options.project.trim().length > 0) {
    args.push("--project", options.project.trim());
  }

  if (execution?.bypassPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }

  if (input.cwd) {
    args.push("--add-dir", input.cwd);
  }

  const effort = options.effort;
  if (effort) {
    args.push("--effort", String(effort));
  }

  const sessionId = input.sessionId;
  if (
    sessionId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
  ) {
    args.push("--conversation", sessionId);
  }

  return args;
}

interface CliAttemptResult {
  result: RuntimeRunResult | null;
  startTimedOut: boolean;
}

async function runCliAttempt(
  input: RuntimeRunInput,
  cliPath: string,
  env: Record<string, string>,
  logger?: AntigravityCliLogger,
): Promise<CliAttemptResult> {
  const execution = input.execution;
  const runId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tempLogFile = path.join(os.tmpdir(), `agy-${runId}.log`);
  const fullPrompt = composeFullPrompt(input);
  const args = buildCliArgs(input, tempLogFile);

  const child = spawnSubprocess(cliPath, args, input.cwd, env);

  let killed = false;
  const rawKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (!killed) {
      killed = true;
      if (child.pid && child.pid > 0) killProcessTree(child.pid);
    }
    if (IS_WINDOWS) {
      try {
        rawKill(signal as any);
      } catch {
        // ignore fallback error if already terminated
      }
      return true;
    }
    try {
      return rawKill(signal as any);
    } catch {
      return false;
    }
  }) as any;

  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution?.startTimeoutMs,
    runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
  });

  const state = createStreamState(input.sessionId ?? null);
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  const MAX_STDERR_BUFFER = 65_536;
  let streamProcessingError: unknown = null;

  // Immediate start event to satisfy orchestrator activity watchdog
  try {
    emitEvent(state, execution, {
      type: "system:init",
      timestamp: new Date().toISOString(),
      level: "debug",
      message: "Antigravity process spawned",
      data: { pid: child.pid },
    });
  } catch (err) {
    child.kill("SIGKILL");
    timeouts.cleanup();
    throw err;
  }

  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processStreamJsonLine(line, state, input, logger);
      newlineIdx = stdoutBuffer.indexOf("\n");
    }
  };

  child.stdout!.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
    try {
      flushCompleteLines();
    } catch (err) {
      streamProcessingError = err;
      logger?.error?.(
        { runtimeId: input.runtimeId, err },
        "Antigravity CLI stream-json processing error",
      );
      child.kill("SIGTERM");
    }
  });

  child.stderr!.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
    stderr += text;
    if (stderr.length > MAX_STDERR_BUFFER) {
      stderr = stderr.slice(-MAX_STDERR_BUFFER);
    }
    execution?.onStderr?.(text);
  });

  // Deliver prompt via stdin and close so child process does not wait on interactive console input
  child.stdin!.on("error", () => {
    /* ignore broken-pipe */
  });
  if (fullPrompt) {
    child.stdin!.write(fullPrompt, "utf8");
  }
  child.stdin!.end();

  // Abort handling
  const abortSignal = execution?.abortController?.signal ?? (input as any).abortSignal;
  const onAbort = () => {
    child.kill("SIGTERM");
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      killed = true;
      timeouts.cleanup();
      abortSignal?.removeEventListener("abort", onAbort);
      fs.unlink(tempLogFile, () => {});
      reject(classifyAntigravityRuntimeError(error));
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      killed = true;
      timeouts.cleanup();
      abortSignal?.removeEventListener("abort", onAbort);
      fs.unlink(tempLogFile, () => {});

      const trailingStderr = stderrDecoder.end();
      if (trailingStderr) {
        stderr += trailingStderr;
        execution?.onStderr?.(trailingStderr);
      }

      stdoutBuffer += stdoutDecoder.end();
      try {
        flushCompleteLines();
      } catch (err) {
        if (!streamProcessingError) {
          streamProcessingError = err;
        }
      }

      if (abortSignal?.aborted) {
        reject(
          new AntigravityRuntimeAdapterError(
            "Antigravity execution was aborted",
            "ANTIGRAVITY_ABORTED",
            "unknown",
          ),
        );
        return;
      }

      if (stdoutBuffer.length > 0) {
        try {
          processStreamJsonLine(stdoutBuffer, state, input, logger);
        } catch {
          /* ignore tail errors */
        }
        stdoutBuffer = "";
      }

      const startTimedOut = await timeouts.startTimedOut;

      if (streamProcessingError) {
        reject(classifyAntigravityRuntimeError(streamProcessingError));
        return;
      }

      if (startTimedOut) {
        const startMs = execution?.startTimeoutMs ?? 0;
        logger?.warn?.(
          { runtimeId: input.runtimeId, startTimeoutMs: startMs },
          "Antigravity CLI start timeout — process produced no output",
        );
        resolve({ result: null, startTimedOut: true });
        return;
      }

      if (timeouts.runTimedOut) {
        const runMs = execution?.runTimeoutMs ?? resolveTimeoutMs(input);
        reject(makeProcessRunTimeoutError(runMs));
        return;
      }

      if (code !== 0) {
        const message = `Antigravity CLI exited with code ${code}: ${stderr || state.outputText || state.plainTextFallback || "unknown error"}`;
        reject(classifyAntigravityRuntimeError(message));
        return;
      }

      const finalOutput =
        state.outputText.trim() ||
        state.plainTextFallback.trim() ||
        "Antigravity completed execution.";

      const finalUsage: RuntimeUsage = state.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      resolve({
        result: {
          outputText: finalOutput,
          sessionId: state.sessionId,
          usage: finalUsage,
          events: state.events,
        },
        startTimedOut: false,
      });
    });
  });
}

export async function runAntigravityCli(
  input: RuntimeRunInput,
  logger?: AntigravityCliLogger,
  adapterDefaults?: { pathToAntigravityExecutable?: string },
): Promise<RuntimeRunResult> {
  const cliPath = resolveCliPath(input.options, adapterDefaults?.pathToAntigravityExecutable);
  const execution = input.execution;
  const env = buildCuratedEnv(execution?.environment);

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "cli",
      cliPath,
      model: input.model ?? DEFAULT_ANTIGRAVITY_MODEL,
      startTimeoutMs: execution?.startTimeoutMs ?? null,
      runTimeoutMs: execution?.runTimeoutMs ?? resolveTimeoutMs(input),
    },
    "Starting Antigravity CLI run",
  );

  const { result, startTimedOut } = await runCliAttempt(input, cliPath, env, logger);

  if (startTimedOut || !result) {
    const abortSignal = execution?.abortController?.signal ?? (input as any).abortSignal;
    if (abortSignal?.aborted) {
      throw new AntigravityRuntimeAdapterError(
        "Antigravity execution was aborted",
        "ANTIGRAVITY_ABORTED",
        "unknown",
      );
    }

    const retryDelayMs = resolveRetryDelay(execution ?? {});
    logger?.warn?.(
      { runtimeId: input.runtimeId, retryDelayMs },
      "Antigravity CLI start timeout, retrying once after delay",
    );
    await sleepMs(retryDelayMs);

    if (abortSignal?.aborted) {
      throw new AntigravityRuntimeAdapterError(
        "Antigravity execution was aborted",
        "ANTIGRAVITY_ABORTED",
        "unknown",
      );
    }

    const retry = await runCliAttempt(input, cliPath, env, logger);
    if (retry.startTimedOut || !retry.result) {
      throw makeProcessStartTimeoutError(execution?.startTimeoutMs ?? 0);
    }
    return retry.result;
  }

  return result;
}
