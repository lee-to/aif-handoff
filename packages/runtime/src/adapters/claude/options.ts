import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type {
  RuntimeEvent,
  RuntimeRunInput,
  RuntimeSubagentStartCallback,
  RuntimeToolUseCallback,
} from "../../types.js";
import { isValidTrustToken } from "../../trust.js";
import { buildClaudeHooks } from "./hooks.js";

export interface ClaudeRuntimeExecutionOptions {
  maxBudgetUsd?: number | null;
  agentDefinitionName?: string;
  permissionMode?: "acceptEdits" | "bypassPermissions" | string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
  settingSources?: string[];
  settings?: { attribution?: { commit?: string; pr?: string } };
  systemPromptAppend?: string;
  postToolUseHooks?: HookCallback[];
  subagentStartHooks?: HookCallback[];
  includePartialMessages?: boolean;
  maxTurns?: number;
  queryStartTimeoutMs?: number;
  queryStartRetryDelayMs?: number;
  environment?: Record<string, string>;
  stderr?: (chunk: string) => void;
  onEvent?: (event: RuntimeEvent) => void;
  abortController?: AbortController;
  onToolUse?: RuntimeToolUseCallback;
  onSubagentStart?: RuntimeSubagentStartCallback;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toStringRecord(value: Record<string, unknown> | null): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

/**
 * Parse generic RuntimeExecutionIntent + Claude-specific hooks into ClaudeRuntimeExecutionOptions.
 * Supports legacy `metadata` for backwards compat.
 */
export function parseExecutionOptions(
  input: RuntimeRunInput,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): ClaudeRuntimeExecutionOptions {
  const exec = input.execution;
  const hooks = (exec?.hooks ?? {}) as Record<string, unknown>;
  const meta = input.metadata ?? {};
  const src = { ...meta, ...hooks };

  const maxBudgetUsd =
    exec?.maxBudgetUsd !== undefined
      ? exec.maxBudgetUsd
      : typeof src.maxBudgetUsd === "number"
        ? src.maxBudgetUsd
        : src.maxBudgetUsd === null
          ? null
          : undefined;

  return {
    maxBudgetUsd,
    agentDefinitionName:
      exec?.agentDefinitionName ??
      (typeof src.agentDefinitionName === "string" ? src.agentDefinitionName : undefined),
    permissionMode: exec?.bypassPermissions
      ? "bypassPermissions"
      : typeof src.permissionMode === "string"
        ? src.permissionMode
        : undefined,
    allowDangerouslySkipPermissions:
      (exec?.bypassPermissions ||
        (typeof src.allowDangerouslySkipPermissions === "boolean" &&
          src.allowDangerouslySkipPermissions)) &&
      isValidTrustToken(src._trustToken)
        ? true
        : undefined,
    pathToClaudeCodeExecutable:
      typeof src.pathToClaudeCodeExecutable === "string"
        ? src.pathToClaudeCodeExecutable
        : adapterDefaults?.pathToClaudeCodeExecutable,
    settingSources: Array.isArray(src.settingSources)
      ? src.settingSources.filter((value): value is string => typeof value === "string")
      : undefined,
    settings: toRecord(src.settings) as ClaudeRuntimeExecutionOptions["settings"],
    systemPromptAppend:
      exec?.systemPromptAppend ??
      (typeof src.systemPromptAppend === "string" ? src.systemPromptAppend : undefined),
    postToolUseHooks: Array.isArray(src.postToolUseHooks)
      ? (src.postToolUseHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    subagentStartHooks: Array.isArray(src.subagentStartHooks)
      ? (src.subagentStartHooks.filter(
          (value): value is HookCallback => typeof value === "function",
        ) as HookCallback[])
      : undefined,
    includePartialMessages:
      exec?.includePartialMessages ??
      (typeof src.includePartialMessages === "boolean" ? src.includePartialMessages : undefined),
    maxTurns: exec?.maxTurns ?? (typeof src.maxTurns === "number" ? src.maxTurns : undefined),
    queryStartTimeoutMs:
      exec?.timeoutMs ??
      (typeof src.queryStartTimeoutMs === "number" ? src.queryStartTimeoutMs : undefined),
    queryStartRetryDelayMs:
      exec?.retryDelayMs ??
      (typeof src.queryStartRetryDelayMs === "number" ? src.queryStartRetryDelayMs : undefined),
    environment: {
      ...toStringRecord(toRecord(src.environment)),
      ...exec?.environment,
    },
    stderr:
      exec?.onStderr ??
      (typeof src.stderr === "function" ? (src.stderr as (chunk: string) => void) : undefined),
    onEvent:
      exec?.onEvent ??
      (typeof src.onEvent === "function"
        ? (src.onEvent as (event: RuntimeEvent) => void)
        : undefined),
    abortController:
      exec?.abortController ??
      (src.abortController instanceof AbortController ? src.abortController : undefined),
    onToolUse: exec?.onToolUse,
    onSubagentStart: exec?.onSubagentStart,
  };
}

// ---------------------------------------------------------------------------
// Environment & SDK query options
// ---------------------------------------------------------------------------

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

function isAllowedEnvKey(key: string): boolean {
  return ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

function resolveEnvironment(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && isAllowedEnvKey(key)) {
      base[key] = value;
    }
  }
  Object.assign(base, execution.environment ?? {});

  const optionRecord = toRecord(input.options);
  const apiKeyEnvVar =
    typeof optionRecord?.apiKeyEnvVar === "string" ? optionRecord.apiKeyEnvVar : null;
  const apiKey =
    typeof optionRecord?.apiKey === "string" && optionRecord.apiKey.trim().length > 0
      ? optionRecord.apiKey.trim()
      : null;
  const baseUrl = typeof optionRecord?.baseUrl === "string" ? optionRecord.baseUrl : null;
  const standardApiKeyEnvVar =
    (input.providerId ?? "").toLowerCase() === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";

  if (apiKey) {
    if (apiKeyEnvVar) {
      base[apiKeyEnvVar] = apiKey;
    }
    if (!base[standardApiKeyEnvVar]) {
      base[standardApiKeyEnvVar] = apiKey;
    }
  } else if (apiKeyEnvVar && !base[apiKeyEnvVar] && process.env[apiKeyEnvVar]) {
    base[apiKeyEnvVar] = process.env[apiKeyEnvVar]!;
    if (!base[standardApiKeyEnvVar]) {
      base[standardApiKeyEnvVar] = process.env[apiKeyEnvVar]!;
    }
  }
  if (baseUrl) {
    if ((input.providerId ?? "").toLowerCase() === "anthropic") {
      base.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      base.OPENAI_BASE_URL = baseUrl;
    }
  }

  return base;
}

function mergeSystemPromptAppend(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): string {
  const values = [input.systemPrompt, execution.systemPromptAppend]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return values.join("\n\n");
}

/** Build the options object passed to `query()` from the Claude Agent SDK. */
export function buildClaudeQueryOptions(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): Record<string, unknown> {
  const optionRecord = toRecord(input.options);
  const hooks = buildClaudeHooks({
    postToolUseHooks: execution.postToolUseHooks,
    subagentStartHooks: execution.subagentStartHooks,
    onToolUse: execution.onToolUse,
    onSubagentStart: execution.onSubagentStart,
  });

  const mergedAppend = mergeSystemPromptAppend(input, execution);
  const settings = execution.settings ?? { attribution: { commit: "", pr: "" } };
  const effort =
    typeof optionRecord?.effort === "number"
      ? optionRecord.effort
      : typeof optionRecord?.effort === "string"
        ? optionRecord.effort.trim()
        : null;
  return {
    ...(execution.abortController ? { abortController: execution.abortController } : {}),
    cwd: input.cwd ?? input.projectRoot,
    env: resolveEnvironment(input, execution),
    settings,
    settingSources: execution.settingSources ?? ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(mergedAppend ? { append: mergedAppend } : {}),
    },
    permissionMode: execution.permissionMode ?? "acceptEdits",
    ...(execution.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(execution.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: execution.pathToClaudeCodeExecutable }
      : {}),
    ...(execution.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(execution.maxTurns != null ? { maxTurns: execution.maxTurns } : {}),
    ...(execution.maxBudgetUsd != null ? { maxBudgetUsd: execution.maxBudgetUsd } : {}),
    ...(execution.stderr ? { stderr: execution.stderr } : {}),
    ...(hooks ? { hooks } : {}),
    ...(execution.agentDefinitionName
      ? { extraArgs: { agent: execution.agentDefinitionName } }
      : {}),
    ...(input.resume && input.sessionId ? { resume: input.sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(effort === "low" || effort === "medium" || effort === "high" || effort === "max"
      ? { effort }
      : typeof effort === "number"
        ? { effort }
        : {}),
  };
}
