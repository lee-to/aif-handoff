import { spawn, execFileSync } from "node:child_process";
import type { RuntimeEvent, RuntimeRunInput, RuntimeRunResult, RuntimeUsage } from "../../types.js";
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

const CODEX_CLI_EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"] as const);

type CodexCliEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeCodexCliEffort(value: unknown): CodexCliEffortLevel | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (CODEX_CLI_EFFORT_LEVELS.has(trimmed as CodexCliEffortLevel)) {
      return trimmed as CodexCliEffortLevel;
    }
  }
  return null;
}

const CODEX_APPROVAL_POLICIES = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const);

type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

function normalizeCodexApprovalPolicy(value: unknown): CodexApprovalPolicy | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODEX_APPROVAL_POLICIES.has(trimmed as CodexApprovalPolicy)
    ? (trimmed as CodexApprovalPolicy)
    : null;
}

const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const);

type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

function normalizeCodexSandboxMode(value: unknown): CodexSandboxMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODEX_SANDBOX_MODES.has(trimmed as CodexSandboxMode)
    ? (trimmed as CodexSandboxMode)
    : null;
}

/**
 * Resolve the effective approval policy and sandbox mode for a Codex CLI run.
 *
 * Three-layer precedence:
 *   1. explicit profile options (`options.approvalPolicy` / `options.sandboxMode`)
 *   2. bypass defaults (when `execution.bypassPermissions=true`)
 *   3. stable non-bypass defaults (`on-request` + `workspace-write`)
 *
 * The non-bypass defaults keep behaviour consistent across hosts regardless
 * of the user's ~/.codex/config.toml — prior to the bypass-permissions
 * refactor these defaults were set by a Codex-specific hook factory in the
 * API layer; the logic now lives inside the adapter so api/agent/runtime all
 * share the same contract.
 *
 * Values are always non-null — the caller always emits the corresponding
 * `-c approval_policy="..."` / `-c sandbox_mode="..."` override. Routing
 * through `-c` rather than `--sandbox` / the atomic
 * `--dangerously-bypass-approvals-and-sandbox` flag is required because the
 * `codex exec resume` subcommand rejects `--sandbox` outright.
 */
function resolveCodexPermissionOverrides(input: RuntimeRunInput): {
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
} {
  const options = asRecord(input.options);
  const explicitApproval = normalizeCodexApprovalPolicy(options.approvalPolicy);
  const explicitSandbox = normalizeCodexSandboxMode(options.sandboxMode);
  const bypass = input.execution?.bypassPermissions === true;

  return {
    approvalPolicy: explicitApproval ?? (bypass ? "never" : "on-request"),
    sandboxMode: explicitSandbox ?? (bypass ? "danger-full-access" : "workspace-write"),
  };
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
  const effort = normalizeCodexCliEffort(options.modelReasoningEffort);
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  // Skip git repo check — opt-in via profile for non-git working directories
  if (options.skipGitRepoCheck === true) {
    args.push("--skip-git-repo-check");
  }

  // Approval policy and sandbox mode. Always emitted so behaviour stays
  // stable across hosts regardless of the user's ~/.codex/config.toml.
  //
  //   bypass=false, no profile override → "on-request" + "workspace-write"
  //   bypass=true,  no profile override → "never"      + "danger-full-access"
  //   explicit `options.approvalPolicy` / `options.sandboxMode` always win
  //
  // Routed via `-c` rather than `--sandbox` or the atomic
  // `--dangerously-bypass-approvals-and-sandbox` flag — `codex exec resume`
  // rejects `--sandbox`, and `-c` overrides work uniformly across both the
  // fresh exec and resume paths.
  const { approvalPolicy, sandboxMode } = resolveCodexPermissionOverrides(input);
  args.push("-c", `approval_policy="${approvalPolicy}"`);
  args.push("-c", `sandbox_mode="${sandboxMode}"`);

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

// ---------------------------------------------------------------------------
// stream-json (JSONL) line processor
// ---------------------------------------------------------------------------

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  [key: string]: unknown;
}

interface CodexStreamMessage {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
  };
  total_cost_usd?: number;
  cost_usd?: number;
  // Legacy single-blob fields used by custom `codexCliArgs` integrations
  outputText?: string;
  result?: string;
  sessionId?: string;
  events?: Array<Record<string, unknown>>;
}

interface CodexCliStreamState {
  sessionId: string | null;
  outputText: string;
  usage: RuntimeUsage | null;
  events: RuntimeEvent[];
  plainTextFallback: string;
  /** Raw parsed JSONL events — preserved in `raw` for compatibility. */
  rawEvents: Array<Record<string, unknown>>;
  /** True once we have seen any JSONL line that was successfully parsed. */
  sawAnyJsonLine: boolean;
}

function createCodexStreamState(fallbackSessionId: string | null): CodexCliStreamState {
  return {
    sessionId: fallbackSessionId,
    outputText: "",
    usage: null,
    events: [],
    plainTextFallback: "",
    rawEvents: [],
    sawAnyJsonLine: false,
  };
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    return input.length > 100 ? `${input.slice(0, 97)}...` : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json.length <= 120) return json;
    return `${json.slice(0, 117)}...`;
  } catch {
    return "";
  }
}

function displayNameForCodexTool(itemType: string): string {
  // Map internal codex item types to friendlier activity names that match
  // the Claude convention where possible, so the UI shows "Bash ls" etc.
  switch (itemType) {
    case "command_execution":
      return "Bash";
    case "file_read":
      return "Read";
    case "file_write":
      return "Write";
    case "file_edit":
      return "Edit";
    default:
      return itemType;
  }
}

function emitCodexEvent(
  state: CodexCliStreamState,
  execution: RuntimeRunInput["execution"],
  event: RuntimeEvent,
): void {
  state.events.push(event);
  execution?.onEvent?.(event);
}

function accumulateCodexUsage(state: CodexCliStreamState, message: CodexStreamMessage): void {
  const usage = message.usage;
  if (!usage) return;
  const rawInput = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const inputTokens = rawInput + cached;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const costRaw = message.total_cost_usd ?? message.cost_usd;
  if (state.usage) {
    state.usage = {
      inputTokens: state.usage.inputTokens + inputTokens,
      outputTokens: state.usage.outputTokens + outputTokens,
      totalTokens: state.usage.totalTokens + totalTokens,
      costUsd:
        typeof costRaw === "number" ? (state.usage.costUsd ?? 0) + costRaw : state.usage.costUsd,
    };
  } else {
    state.usage = {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: typeof costRaw === "number" ? costRaw : undefined,
    };
  }
}

function processCodexJsonLine(
  line: string,
  state: CodexCliStreamState,
  execution: RuntimeRunInput["execution"],
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: CodexStreamMessage;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
      return;
    }
    message = parsed as CodexStreamMessage;
  } catch {
    state.plainTextFallback += (state.plainTextFallback ? "\n" : "") + trimmed;
    return;
  }

  state.sawAnyJsonLine = true;
  state.rawEvents.push(message as unknown as Record<string, unknown>);

  const type = typeof message.type === "string" ? message.type : "";
  const nowIso = new Date().toISOString();

  if (type === "thread.started") {
    if (typeof message.thread_id === "string" && message.thread_id.length > 0) {
      state.sessionId = message.thread_id;
    }
    emitCodexEvent(state, execution, {
      type: "system:init",
      timestamp: nowIso,
      level: "debug",
      message: "Codex thread started",
      data: { sessionId: state.sessionId },
    });
    return;
  }

  if (type === "item.started" && message.item) {
    const item = message.item;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType && itemType !== "agent_message") {
      const displayName = displayNameForCodexTool(itemType);
      // Prefer the `command` field for shell tools, otherwise summarize the
      // whole item object so the activity line carries meaningful context.
      const detailSource: unknown =
        typeof item.command === "string"
          ? item.command
          : { ...item, id: undefined, status: undefined };
      const summary = summarizeToolInput(detailSource);
      const detailSuffix = summary ? ` ${summary}` : "";
      emitCodexEvent(state, execution, {
        type: "tool:use",
        timestamp: nowIso,
        level: "info",
        message: `${displayName}${detailSuffix}`,
        data: { name: displayName, itemType, item },
      });
      execution?.onToolUse?.(displayName, detailSuffix);
    }
    return;
  }

  if (type === "item.completed" && message.item) {
    const item = message.item;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message" && typeof item.text === "string") {
      if (state.outputText) state.outputText += "\n\n";
      state.outputText += item.text;
      emitCodexEvent(state, execution, {
        type: "stream:text",
        timestamp: nowIso,
        level: "debug",
        message: item.text,
        data: { text: item.text },
      });
    }
    // Tool-complete events are intentionally not re-surfaced — the
    // `item.started` already emitted tool:use, and re-emitting on completion
    // would double-log in agent activity.
    return;
  }

  // Legacy "message" event (older codex CLI format)
  if (type === "message" && typeof message.text === "string") {
    if (state.outputText) state.outputText += "\n\n";
    state.outputText += message.text;
    emitCodexEvent(state, execution, {
      type: "stream:text",
      timestamp: nowIso,
      level: "debug",
      message: message.text,
      data: { text: message.text },
    });
    return;
  }

  if (type === "turn.completed") {
    accumulateCodexUsage(state, message);
    emitCodexEvent(state, execution, {
      type: "result:success",
      timestamp: nowIso,
      level: "info",
      message: "Codex turn completed",
      data: { usage: message.usage },
    });
    return;
  }

  // Other event types (turn.started, rate limit, etc.) are ignored.
}

function finalizeCodexResult(
  state: CodexCliStreamState,
  fallbackSessionId: string | null,
): RuntimeRunResult {
  // Backwards-compat: if custom `codexCliArgs` integrations emit a single
  // AIF-specific JSON blob (with outputText/result/sessionId/usage/events),
  // we will have parsed it as a single message in rawEvents but none of the
  // streaming handlers matched. Recover that shape here.
  if (
    state.rawEvents.length === 1 &&
    !state.outputText &&
    (state.rawEvents[0].outputText != null || state.rawEvents[0].result != null)
  ) {
    const parsed = state.rawEvents[0] as CodexStreamMessage & {
      usage?: Record<string, number>;
    };
    const usageRaw = parsed.usage as Record<string, number> | undefined;
    const legacyEvents = Array.isArray((parsed as Record<string, unknown>).events)
      ? ((parsed as Record<string, unknown>).events as Array<Record<string, unknown>>).map((e) => ({
          type: String(e.type ?? "unknown"),
          timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
          message: typeof e.message === "string" ? e.message : undefined,
          data: e.data as Record<string, unknown> | undefined,
        }))
      : undefined;
    return {
      outputText: String(parsed.outputText ?? parsed.result ?? ""),
      sessionId:
        typeof (parsed as Record<string, unknown>).sessionId === "string"
          ? ((parsed as Record<string, unknown>).sessionId as string)
          : fallbackSessionId,
      usage: usageRaw
        ? {
            inputTokens: usageRaw.inputTokens ?? usageRaw.input_tokens ?? 0,
            outputTokens: usageRaw.outputTokens ?? usageRaw.output_tokens ?? 0,
            totalTokens:
              usageRaw.totalTokens ??
              usageRaw.total_tokens ??
              (usageRaw.inputTokens ?? usageRaw.input_tokens ?? 0) +
                (usageRaw.outputTokens ?? usageRaw.output_tokens ?? 0),
            costUsd: usageRaw.costUsd ?? usageRaw.cost_usd,
          }
        : undefined,
      events: legacyEvents,
      raw: parsed,
    };
  }

  // No JSONL events parsed at all — expose raw stdout as plain text.
  if (!state.sawAnyJsonLine) {
    const raw = state.plainTextFallback;
    return {
      outputText: raw,
      sessionId: fallbackSessionId,
      raw,
    };
  }

  return {
    outputText: state.outputText,
    sessionId: state.sessionId ?? fallbackSessionId,
    usage: state.usage ?? undefined,
    events: state.events,
    raw: state.rawEvents,
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

  const state = createCodexStreamState(input.sessionId ?? null);
  let stdoutBuffer = "";
  let stderr = "";

  const flushCompleteLines = (): void => {
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      processCodexJsonLine(line, state, execution);
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
        "Codex CLI stream-json processing error",
      );
    }
  });

  child.stderr!.on("data", (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr += text;
    execution?.onStderr?.(text);
  });

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

      // Flush any trailing buffer content as a final line.
      if (stdoutBuffer.length > 0) {
        try {
          processCodexJsonLine(stdoutBuffer, state, execution);
        } catch {
          /* ignore tail processing errors */
        }
        stdoutBuffer = "";
      }

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
        const tail = state.outputText || state.plainTextFallback || "unknown error";
        const message = `Codex CLI exited with code ${code}: ${stderr || tail}`;
        reject(classifyCodexRuntimeError(message));
        return;
      }

      try {
        resolve({
          result: finalizeCodexResult(state, input.sessionId ?? null),
          startTimedOut: false,
        });
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
