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
  runTimeoutMs?: number;
  environment?: Record<string, string>;
  stderr?: (chunk: string) => void;
  onEvent?: (event: RuntimeEvent) => void;
  abortController?: AbortController;
  onToolUse?: RuntimeToolUseCallback;
  onSubagentStart?: RuntimeSubagentStartCallback;
}

export interface ClaudeOptionsLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
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
 */
export function parseExecutionOptions(
  input: RuntimeRunInput,
  adapterDefaults?: { pathToClaudeCodeExecutable?: string },
): ClaudeRuntimeExecutionOptions {
  const exec = input.execution;
  const hooks = (exec?.hooks ?? {}) as Record<string, unknown>;
  const src = { ...hooks };

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
      exec?.startTimeoutMs ??
      (typeof src.queryStartTimeoutMs === "number" ? src.queryStartTimeoutMs : undefined),
    queryStartRetryDelayMs:
      exec?.startRetryDelayMs ??
      (typeof src.queryStartRetryDelayMs === "number" ? src.queryStartRetryDelayMs : undefined),
    runTimeoutMs:
      exec?.runTimeoutMs ?? (typeof src.runTimeoutMs === "number" ? src.runTimeoutMs : undefined),
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

function isAllowedEnvKey(key: string): boolean {
  return ALLOWED_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
}

interface ResolvedEnvironment {
  env: Record<string, string>;
  forwardedCount: number;
  filteredCount: number;
  droppedDisallowedPrefixKeys: string[];
}

function resolveEnvironment(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
): ResolvedEnvironment {
  const base: Record<string, string> = {};
  let forwardedCount = 0;
  let filteredCount = 0;
  const droppedDisallowedPrefixKeys = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && isAllowedEnvKey(key)) {
      base[key] = value;
      forwardedCount += 1;
    } else if (value != null) {
      filteredCount += 1;
      if (key.startsWith("npm_")) {
        droppedDisallowedPrefixKeys.add(key);
      }
    }
  }
  for (const [key, value] of Object.entries(execution.environment ?? {})) {
    base[key] = value;
  }

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

  return {
    env: base,
    forwardedCount,
    filteredCount,
    droppedDisallowedPrefixKeys: [...droppedDisallowedPrefixKeys],
  };
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

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
const CLAUDE_NUMERIC_EFFORT_MAP: Record<number, ClaudeEffortLevel> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "max",
};

export function normalizeClaudeEffort(rawEffort: unknown): ClaudeEffortLevel | null {
  if (typeof rawEffort === "string") {
    const normalized = rawEffort.trim().toLowerCase();
    return CLAUDE_EFFORT_LEVELS.includes(normalized as ClaudeEffortLevel)
      ? (normalized as ClaudeEffortLevel)
      : null;
  }
  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    return CLAUDE_NUMERIC_EFFORT_MAP[Math.floor(rawEffort)] ?? null;
  }
  return null;
}

/** Build the options object passed to `query()` from the Claude Agent SDK. */
export function buildClaudeQueryOptions(
  input: RuntimeRunInput,
  execution: ClaudeRuntimeExecutionOptions,
  logger?: ClaudeOptionsLogger,
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
  const resolvedEnvironment = resolveEnvironment(input, execution);
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      forwardedEnvCount: resolvedEnvironment.forwardedCount,
      filteredEnvCount: resolvedEnvironment.filteredCount,
      droppedDisallowedPrefixCount: resolvedEnvironment.droppedDisallowedPrefixKeys.length,
    },
    "DEBUG [runtime:claude] Built Claude runtime environment from curated allowlist",
  );
  if (resolvedEnvironment.droppedDisallowedPrefixKeys.length > 0) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        droppedDisallowedPrefixKeys: resolvedEnvironment.droppedDisallowedPrefixKeys.slice(0, 10),
      },
      "WARN [runtime:claude] Dropped disallowed environment prefix keys while building Claude runtime environment",
    );
  }
  const rawEffort = optionRecord?.effort;
  const normalizedEffort = normalizeClaudeEffort(rawEffort);
  logger?.debug?.(
    {
      runtimeId: input.runtimeId,
      providerId: input.providerId ?? "anthropic",
      incomingEffort: rawEffort ?? null,
      normalizedEffort,
    },
    "DEBUG [runtime:claude] Normalized effort option for Claude query",
  );
  if (rawEffort != null && normalizedEffort == null) {
    logger?.warn?.(
      {
        runtimeId: input.runtimeId,
        providerId: input.providerId ?? "anthropic",
        incomingEffort: rawEffort,
        acceptedEffortLevels: [...CLAUDE_EFFORT_LEVELS],
      },
      "WARN [runtime:claude] Ignoring unsupported Claude effort option",
    );
  }

  return {
    ...(execution.abortController ? { abortController: execution.abortController } : {}),
    cwd: input.cwd ?? input.projectRoot,
    env: resolvedEnvironment.env,
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
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
  };
}
