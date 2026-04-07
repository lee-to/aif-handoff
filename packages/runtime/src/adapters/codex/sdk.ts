import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
  type TurnOptions,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from "@openai/codex-sdk";
import type {
  RuntimeEvent,
  RuntimeExecutionIntent,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeUsage,
} from "../../types.js";
import { classifyCodexRuntimeError } from "./errors.js";

export interface CodexSdkLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

// ---------------------------------------------------------------------------
// SDK option builders
// ---------------------------------------------------------------------------

function buildCodexOptions(input: RuntimeRunInput): CodexOptions {
  const options = asRecord(input.options);
  const execution = input.execution;
  const apiKeyEnvVar =
    typeof options.apiKeyEnvVar === "string" ? options.apiKeyEnvVar : "OPENAI_API_KEY";

  const codexOpts: CodexOptions = {
    env: buildCuratedEnv(apiKeyEnvVar, execution?.environment),
  };

  // API key — only passed if explicitly provided via profile options or env var.
  // Otherwise the SDK delegates auth to the CLI which manages its own credentials
  // via `codex auth login`, same as Claude SDK uses `claude /login`.
  const apiKey = readString(options.apiKey) ?? readString(process.env[apiKeyEnvVar]);
  if (apiKey) {
    codexOpts.apiKey = apiKey;
  }

  // Base URL override
  const baseUrl =
    readString(options.baseUrl) ??
    readString(process.env.OPENAI_BASE_URL) ??
    readString(process.env.CODEX_BASE_URL);
  if (baseUrl) {
    codexOpts.baseUrl = baseUrl;
  }

  // CLI path override
  const codexPath = readString(options.codexCliPath) ?? readString(process.env.CODEX_CLI_PATH);
  if (codexPath) {
    codexOpts.codexPathOverride = codexPath;
  }

  // Codex CLI config overrides — cast to satisfy CodexConfigObject (non-exported recursive type)
  const configOverride = asRecord(options.codexConfig);
  if (Object.keys(configOverride).length > 0) {
    codexOpts.config = configOverride as CodexOptions["config"];
  }

  return codexOpts;
}

function buildThreadOptions(input: RuntimeRunInput): ThreadOptions {
  const cwd = input.cwd ?? input.projectRoot;
  const options = asRecord(input.options);
  const execution = input.execution;
  const hooks = asRecord(execution?.hooks);

  const threadOpts: ThreadOptions = {};

  if (cwd) {
    threadOpts.workingDirectory = cwd;
  }

  // Model from input or profile
  if (input.model) {
    threadOpts.model = input.model;
  }

  const approvalPolicy = readString(options.approvalPolicy) ?? readString(hooks.approvalPolicy);
  if (
    approvalPolicy === "never" ||
    approvalPolicy === "on-request" ||
    approvalPolicy === "on-failure" ||
    approvalPolicy === "untrusted"
  ) {
    threadOpts.approvalPolicy = approvalPolicy;
  }

  // Skip git repo check if explicitly requested
  if (options.skipGitRepoCheck === true || hooks.skipGitRepoCheck === true) {
    threadOpts.skipGitRepoCheck = true;
  }

  // Sandbox mode
  const sandboxMode = readString(options.sandboxMode) ?? readString(hooks.sandboxMode);
  if (
    sandboxMode === "read-only" ||
    sandboxMode === "workspace-write" ||
    sandboxMode === "danger-full-access"
  ) {
    threadOpts.sandboxMode = sandboxMode;
  }

  const networkAccessEnabled =
    typeof options.networkAccessEnabled === "boolean"
      ? options.networkAccessEnabled
      : typeof hooks.networkAccessEnabled === "boolean"
        ? hooks.networkAccessEnabled
        : null;
  if (typeof networkAccessEnabled === "boolean") {
    threadOpts.networkAccessEnabled = networkAccessEnabled;
  }

  // Reasoning effort
  const effort = readString(options.modelReasoningEffort) ?? readString(hooks.modelReasoningEffort);
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    threadOpts.modelReasoningEffort = effort;
  }

  return threadOpts;
}

function buildTurnOptions(execution?: RuntimeExecutionIntent): TurnOptions {
  const turnOpts: TurnOptions = {};

  if (execution?.outputSchema && typeof execution.outputSchema === "object") {
    turnOpts.outputSchema = execution.outputSchema;
  }

  if (execution?.abortController) {
    turnOpts.signal = execution.abortController.signal;
  }

  return turnOpts;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(usage: Usage | null): RuntimeUsage | null {
  if (!usage) return null;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Item → RuntimeEvent / callback mapping
// ---------------------------------------------------------------------------

function itemToToolUseSummary(item: ThreadItem): { toolName: string; detail: string } | null {
  switch (item.type) {
    case "command_execution":
      return { toolName: "Bash", detail: item.command.slice(0, 200) };
    case "file_change":
      return {
        toolName: "FileChange",
        detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(", "),
      };
    case "mcp_tool_call":
      return { toolName: `MCP:${item.server}/${item.tool}`, detail: String(item.arguments ?? "") };
    case "web_search":
      return { toolName: "WebSearch", detail: item.query };
    default:
      return null;
  }
}

function threadEventToRuntimeEvent(event: ThreadEvent): RuntimeEvent | null {
  const now = new Date().toISOString();

  switch (event.type) {
    case "thread.started":
      return {
        type: "system:init",
        timestamp: now,
        level: "debug",
        message: "Codex thread started",
        data: { threadId: event.thread_id },
      };

    case "turn.started":
      return {
        type: "turn:started",
        timestamp: now,
        level: "debug",
        message: "Turn started",
      };

    case "turn.completed":
      return {
        type: "result:success",
        timestamp: now,
        level: "info",
        message: "Turn completed",
        data: {
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
        },
      };

    case "turn.failed":
      return {
        type: "result:error",
        timestamp: now,
        level: "error",
        message: event.error?.message ?? "Turn failed",
      };

    case "item.completed": {
      const item = event.item;
      if (item.type === "agent_message") {
        return {
          type: "stream:text",
          timestamp: now,
          level: "debug",
          message: item.text,
          data: { text: item.text },
        };
      }
      if (item.type === "reasoning") {
        return {
          type: "reasoning",
          timestamp: now,
          level: "debug",
          message: item.text,
        };
      }
      const summary = itemToToolUseSummary(item);
      if (summary) {
        return {
          type: "tool:summary",
          timestamp: now,
          level: "info",
          message: `${summary.toolName}: ${summary.detail}`,
          data: { toolName: summary.toolName },
        };
      }
      return null;
    }

    case "error":
      return {
        type: "error",
        timestamp: now,
        level: "error",
        message: event.message,
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main SDK execution
// ---------------------------------------------------------------------------

export async function runCodexSdk(
  input: RuntimeRunInput,
  logger?: CodexSdkLogger,
): Promise<RuntimeRunResult> {
  const codexOpts = buildCodexOptions(input);
  const threadOpts = buildThreadOptions(input);
  const turnOpts = buildTurnOptions(input.execution);
  const execution = input.execution;

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "sdk",
      resume: Boolean(input.resume && input.sessionId),
      model: input.model ?? null,
      hasOutputSchema: Boolean(turnOpts.outputSchema),
    },
    "Starting Codex SDK run",
  );

  const codex = new Codex(codexOpts);

  const thread =
    input.resume && input.sessionId
      ? codex.resumeThread(input.sessionId, threadOpts)
      : codex.startThread(threadOpts);

  const { events } = await thread.runStreamed(input.prompt, turnOpts);

  let outputText = "";
  let sessionId: string | null = null;
  let usage: RuntimeUsage | null = null;
  const runtimeEvents: RuntimeEvent[] = [];

  for await (const event of events) {
    // Extract thread ID from the first event
    if (event.type === "thread.started") {
      sessionId = event.thread_id;
    }

    // Extract usage from turn completion
    if (event.type === "turn.completed") {
      usage = normalizeUsage(event.usage);
    }

    // Handle fatal errors
    if (event.type === "turn.failed") {
      throw classifyCodexRuntimeError(event.error?.message ?? "Codex turn failed");
    }

    // Collect output text from completed agent messages
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      if (outputText) outputText += "\n\n";
      outputText += event.item.text;
    }

    // Fire onToolUse callback for tool-like items
    if (event.type === "item.completed") {
      const toolSummary = itemToToolUseSummary(event.item);
      if (toolSummary) {
        execution?.onToolUse?.(toolSummary.toolName, toolSummary.detail);
      }
    }

    // Map to runtime events and notify
    const runtimeEvent = threadEventToRuntimeEvent(event);
    if (runtimeEvent) {
      runtimeEvents.push(runtimeEvent);
      execution?.onEvent?.(runtimeEvent);
    }
  }

  // Fallback: thread.id is populated after the first turn starts
  if (!sessionId) {
    sessionId = thread.id ?? null;
  }

  logger?.info?.(
    {
      runtimeId: input.runtimeId,
      transport: "sdk",
      sessionId,
      outputLength: outputText.length,
      eventCount: runtimeEvents.length,
      hasUsage: Boolean(usage),
    },
    "Codex SDK run completed",
  );

  return {
    outputText,
    sessionId,
    usage,
    events: runtimeEvents,
  };
}
