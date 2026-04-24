import {
  isRuntimeTransport as _isRuntimeTransport,
  RUNTIME_TRANSPORTS as _RUNTIME_TRANSPORTS,
  RuntimeLimitPrecision as _RuntimeLimitPrecision,
  RuntimeLimitScope as _RuntimeLimitScope,
  RuntimeLimitSource as _RuntimeLimitSource,
  RuntimeLimitStatus as _RuntimeLimitStatus,
  RuntimeTransport as _RuntimeTransport,
} from "@aif/shared";
import type {
  RuntimeLimitEventPayload as _RuntimeLimitEventPayload,
  RuntimeLimitSnapshot as _RuntimeLimitSnapshot,
  RuntimeLimitWindow as _RuntimeLimitWindow,
} from "@aif/shared";

// Re-exported from @aif/shared — single source of truth for browser + server
export const RuntimeTransport = _RuntimeTransport;
export type RuntimeTransport = (typeof RuntimeTransport)[keyof typeof RuntimeTransport];
export const RUNTIME_TRANSPORTS = _RUNTIME_TRANSPORTS;
export const isRuntimeTransport = _isRuntimeTransport;
export const RuntimeLimitSource = _RuntimeLimitSource;
export type RuntimeLimitSource = (typeof RuntimeLimitSource)[keyof typeof RuntimeLimitSource];
export const RuntimeLimitStatus = _RuntimeLimitStatus;
export type RuntimeLimitStatus = (typeof RuntimeLimitStatus)[keyof typeof RuntimeLimitStatus];
export const RuntimeLimitPrecision = _RuntimeLimitPrecision;
export type RuntimeLimitPrecision =
  (typeof RuntimeLimitPrecision)[keyof typeof RuntimeLimitPrecision];
export const RuntimeLimitScope = _RuntimeLimitScope;
export type RuntimeLimitScope = (typeof RuntimeLimitScope)[keyof typeof RuntimeLimitScope];
export type RuntimeLimitWindow = _RuntimeLimitWindow;
export type RuntimeLimitSnapshot = _RuntimeLimitSnapshot;
export type RuntimeLimitEventPayload = _RuntimeLimitEventPayload;

/** Canonical runtime event type for provider limit-state updates. */
export const RUNTIME_LIMIT_EVENT_TYPE = "runtime:limit" as const;

/**
 * Usage reporting contract — declares whether an adapter can populate
 * `RuntimeRunResult.usage` after a successful run.
 *
 * - `FULL`    — adapter always returns a non-null `usage` on successful run.
 *               The registry wrapper logs loudly on violation (production) or
 *               fails the contract test (development).
 * - `PARTIAL` — adapter returns `usage` when the provider reports it, but may
 *               return `null` for some transports/streaming paths where the
 *               provider doesn't emit a final token count.
 * - `NONE`    — the transport fundamentally cannot report usage. The wrapper
 *               warns if `usage` is non-null (unexpected) and skips sink.record.
 *
 * Defined as a const object (not a string union or TS enum) to match the
 * `RuntimeTransport` convention in this codebase: callers reference
 * `UsageReporting.FULL` instead of magic strings, the TS compiler catches
 * typos, and adding a new variant requires editing one central file.
 */
export const UsageReporting = {
  FULL: "full",
  PARTIAL: "partial",
  NONE: "none",
} as const;
export type UsageReporting = (typeof UsageReporting)[keyof typeof UsageReporting];

/**
 * Canonical set of usage-context sources. Every call site that invokes a
 * runtime declares which logical flow it belongs to by picking one of these,
 * so dashboards can group traffic and "unknown source" is impossible.
 *
 * Adding a new source is a deliberate one-line edit here — this is the
 * single place the set of sources is defined across the whole monorepo.
 */
export const UsageSource = {
  /** User-facing chat route (packages/api/src/routes/chat.ts). */
  CHAT: "chat",
  /** Fire-and-forget /aif-commit runner (services/commitGeneration.ts). */
  COMMIT: "commit",
  /** First roadmap pass that writes ROADMAP.md (services/roadmapGeneration.ts). */
  ROADMAP_GENERATE: "roadmap-generate",
  /** Second roadmap pass that extracts JSON tasks (services/roadmapGeneration.ts). */
  ROADMAP_EXTRACT: "roadmap-extract",
  /** Fast Fix on a task (services/fastFix.ts). */
  FAST_FIX: "fast-fix",
  /** Subagent execution from the agent coordinator (agent/subagentQuery.ts). */
  SUBAGENT: "subagent",
  /** Adapter-internal probe used by listModels() discovery flows. */
  MODEL_DISCOVERY: "model-discovery",
  /** Test fixtures — only valid inside vitest runs. */
  TEST: "test",
} as const;
export type UsageSource = (typeof UsageSource)[keyof typeof UsageSource];

/**
 * Capability flags declared by each adapter.
 * The system checks these before calling optional methods — if a flag is false,
 * the corresponding optional method on RuntimeAdapter will never be called.
 */
export interface RuntimeCapabilities {
  /** Adapter can continue a previous session via resume(). */
  supportsResume: boolean;
  /** Adapter can list/get sessions via listSessions(), getSession(), listSessionEvents(). */
  supportsSessionList: boolean;
  /** Adapter supports .claude/agents/ definitions (agentDefinitionName in execution intent). */
  supportsAgentDefinitions: boolean;
  /** Adapter emits streaming events during run(). */
  supportsStreaming: boolean;
  /** Adapter can enumerate available models via listModels(). */
  supportsModelDiscovery: boolean;
  /** Adapter supports approval workflows (human-in-the-loop). */
  supportsApprovals: boolean;
  /** Adapter supports custom baseUrl / endpoint configuration. */
  supportsCustomEndpoint: boolean;
  /**
   * Adapter can execute subagent workflows via isolated skill-command sessions
   * (without collapsing into a shared single-session fallback prompt).
   */
  supportsIsolatedSubagentWorkflows?: boolean;
  /**
   * Adapter can execute native provider-managed subagent workflows
   * (for example, Codex custom agents + delegation in a single parent run).
   */
  supportsNativeSubagentWorkflows?: boolean;
  /**
   * Adapter's usage-reporting contract. Required so every new adapter makes an
   * explicit decision — the registry wrapper uses this to enforce invariants
   * on `RuntimeRunResult.usage`.
   */
  usageReporting: UsageReporting;
  /**
   * Adapter emits interactive `tool:question` events (e.g. Claude's
   * `AskUserQuestion`). Consumers use this flag to gate provider-specific
   * prompt hints and UI affordances so other runtimes don't inherit noise.
   * Optional — defaults to false for adapters that don't declare it.
   */
  supportsInteractiveQuestions?: boolean;
}

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: false,
  supportsModelDiscovery: false,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
  supportsIsolatedSubagentWorkflows: false,
  supportsNativeSubagentWorkflows: false,
  usageReporting: UsageReporting.NONE,
  supportsInteractiveQuestions: false,
};

export interface RuntimeDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  description?: string;
  version?: string;
  defaultTransport?: RuntimeTransport;
  capabilities: RuntimeCapabilities;
  /** Cheap/fast model for lightweight tasks (review-gate, plan-checking, etc.). null = use default. */
  lightModel?: string | null;
  /** Default API key env var name (e.g. "ANTHROPIC_API_KEY", "OPENAI_API_KEY"). Used for UI hints and inference. */
  defaultApiKeyEnvVar?: string;
  /** Default base URL env var name (e.g. "OPENAI_BASE_URL"). Used for UI placeholder hints. */
  defaultBaseUrlEnvVar?: string;
  /** Placeholder model name for UI (e.g. "claude-sonnet-4-5", "gpt-5.4"). */
  defaultModelPlaceholder?: string;
  /** Transports this adapter supports. Used by UI to filter the transport selector. */
  supportedTransports?: RuntimeTransport[];
  /**
   * Prefix character for skill/slash command invocations.
   * Claude uses "/" (default), Codex uses "$".
   * Used by promptPolicy to transform skill commands before sending to the runtime.
   */
  skillCommandPrefix?: string;
  /**
   * Whether this runtime is supported by `ai-factory init --agents`.
   * Only runtimes with this flag are passed to the init command.
   * API-only runtimes (e.g. OpenRouter) that have no local agent tooling should set this to false or omit it.
   */
  supportsProjectInit?: boolean;
  /**
   * Agent identifier passed to `ai-factory init --agents`.
   * Required for runtimes that set `supportsProjectInit: true`.
   */
  projectInitAgentName?: string;
}

/** Generic tool-use callback — adapter converts its native format to this. */
export type RuntimeToolUseCallback = (toolName: string, detail: string) => void;

/** Generic subagent-start callback — adapter converts its native format to this. */
export type RuntimeSubagentStartCallback = (name: string, id: string) => void;

/**
 * Adapter-neutral execution options passed via `RuntimeRunInput.execution`.
 *
 * Adapters read the fields they support and ignore the rest.
 * Generic callbacks (`onToolUse`, `onSubagentStart`, `onStderr`, `onEvent`)
 * let the caller receive lifecycle events without knowing adapter internals.
 *
 * The `hooks` bag carries opaque adapter-specific config (e.g. trust tokens,
 * SDK settings). Adapters parse it themselves; the system never inspects it.
 */
export interface RuntimeExecutionIntent {
  maxBudgetUsd?: number | null;
  maxTurns?: number;
  /** Timeout waiting for the first output from the runtime stream (ms). */
  startTimeoutMs?: number;
  /** Delay before one automatic retry after a start timeout (ms). */
  startRetryDelayMs?: number;
  includePartialMessages?: boolean;
  agentDefinitionName?: string;
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  abortController?: AbortController;
  /** Callback for stderr chunks from subprocess-based runtimes. */
  onStderr?: (chunk: string) => void;
  /** Callback for runtime events (streaming text, tool use, etc.). */
  onEvent?: (event: RuntimeEvent) => void;
  /** Generic callback invoked after each tool use — adapter wires this into its native hook system. */
  onToolUse?: RuntimeToolUseCallback;
  /** Generic callback invoked when a subagent starts — adapter wires this into its native hook system. */
  onSubagentStart?: RuntimeSubagentStartCallback;
  /** Hard timeout for the entire run/subprocess (ms). Distinct from `timeoutMs` which is the start-of-stream timeout. */
  runTimeoutMs?: number;
  /** Whether to bypass runtime permission checks (requires trust token in hooks). */
  bypassPermissions?: boolean;
  /** JSON Schema for structured output — adapter passes it to the provider if supported. */
  outputSchema?: Record<string, unknown>;
  /** Opaque adapter-specific hooks — passed through to the adapter without interpretation. */
  hooks?: Record<string, unknown>;
}

/**
 * Scope metadata attached to every run so the registry-level usage sink can
 * record who/what/where consumed tokens. `source` is mandatory — the TypeScript
 * compiler forces every call site to make a conscious decision about tagging.
 *
 * Optional scope fields (`projectId`, `taskId`, `chatSessionId`) let the sink
 * aggregate usage per entity; callers pass whichever ones are known.
 */
export interface RuntimeUsageContext {
  /**
   * Logical source of the run. Must be one of the canonical `UsageSource`
   * values — the enum is the single source of truth for where tokens are
   * coming from, so dashboards can group traffic without freeform tags.
   */
  source: UsageSource;
  projectId?: string | null;
  taskId?: string | null;
  chatSessionId?: string | null;
}

export interface RuntimeRunInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  workflowKind?: string;
  transport?: RuntimeTransport;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  sessionId?: string | null;
  resume?: boolean;
  stream?: boolean;
  projectId?: string;
  projectRoot?: string;
  cwd?: string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  execution?: RuntimeExecutionIntent;
  /**
   * Scope metadata for usage tracking. Required: the registry wrapper reads
   * this to record every successful run to the usage sink. Call sites cannot
   * omit it — new code that forgets scoping fails TypeScript compilation.
   */
  usageContext: RuntimeUsageContext;
}

export interface RuntimeEvent {
  type: string;
  timestamp: string;
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Runtime-neutral payload for interactive question events (`tool:question`).
 * Adapters that expose a "ask the user something" tool (e.g. Claude's
 * `AskUserQuestion`) parse their native shape into this before emitting, so
 * consumers (chat UI, schedulers) render questions the same way regardless
 * of which runtime produced them.
 */
export interface RuntimeToolQuestionPayload {
  /** Adapter-native tool call id, when available — used to de-duplicate re-emits. */
  toolUseId: string | null;
  /** Original tool name as seen by the adapter (e.g. "AskUserQuestion"). */
  toolName: string;
  /** One or more questions bundled together. Most adapters send exactly one. */
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface RuntimeSession {
  id: string;
  runtimeId: string;
  providerId: string;
  profileId?: string | null;
  model?: string | null;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeRunResult {
  outputText?: string;
  sessionId?: string | null;
  session?: RuntimeSession | null;
  events?: RuntimeEvent[];
  /**
   * Token/cost usage for this run. REQUIRED: adapters must explicitly return
   * either a `RuntimeUsage` object or `null`. `undefined` is not valid — it
   * would silently hide a missing implementation. Adapters whose transport
   * cannot report usage declare `capabilities.usageReporting = "none"` and
   * return `null` here.
   */
  usage: RuntimeUsage | null;
  raw?: unknown;
}

/**
 * Extract the session ID from a run result, respecting runtime capabilities.
 * Returns null if the runtime does not support sessions or the result has no session.
 */
export function getResultSessionId(
  result: RuntimeRunResult,
  capabilities?: RuntimeCapabilities,
): string | null {
  if (capabilities && !capabilities.supportsResume && !capabilities.supportsSessionList) {
    return null;
  }
  return result.sessionId ?? result.session?.id ?? null;
}

export interface RuntimeSessionListInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  limit?: number;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface RuntimeSessionGetInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  sessionId: string;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface RuntimeSessionEventsInput extends RuntimeSessionGetInput {
  limit?: number;
}

export interface RuntimeConnectionValidationInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  model?: string;
  transport?: RuntimeTransport;
  options?: Record<string, unknown>;
}

export interface RuntimeConnectionValidationResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeModel {
  id: string;
  label?: string;
  supportsStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeModelListInput {
  runtimeId: string;
  providerId?: string;
  profileId?: string | null;
  projectRoot?: string;
  model?: string;
  transport?: RuntimeTransport;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  apiKey?: string | null;
}

export interface RuntimeMcpInput {
  serverName: string;
}

export type RuntimeMcpInstallInput =
  | (RuntimeMcpInput & {
      transport?: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      url?: never;
      bearerTokenEnvVar?: never;
    })
  | (RuntimeMcpInput & {
      transport: "streamable_http";
      url: string;
      bearerTokenEnvVar?: string;
      command?: never;
      args?: never;
      cwd?: never;
      env?: never;
    });

export interface RuntimeMcpStatus {
  installed: boolean;
  serverName: string;
  config?: Record<string, unknown> | null;
}

export interface RuntimeDiagnoseErrorInput {
  error: unknown;
  stderrTail?: string;
  projectRoot?: string;
}

/**
 * Runtime adapter interface.
 *
 * ## Required
 * - `descriptor` — static metadata: id, provider, capabilities, lightModel
 * - `run()` — execute a prompt and return the result
 *
 * ## Optional — capabilities-gated
 * Implement these when `descriptor.capabilities` flags are true:
 * - `resume()` — re-enter an existing session (supportsResume)
 * - `listSessions()` / `getSession()` / `listSessionEvents()` — session management (supportsSessionList)
 * - `listModels()` — enumerate available models (supportsModelDiscovery)
 * - `validateConnection()` — health check for readiness endpoint
 *
 * ## Optional — quality-of-life
 * - `diagnoseError()` — human-readable explanation from adapter-specific error + stderr
 * - `sanitizeInput()` — strip runtime-specific internal tags from user messages
 *
 * ## Adapter file structure convention
 * ```
 * adapters/<name>/
 *   index.ts    — factory function: create<Name>RuntimeAdapter(options)
 *   errors.ts   — error classification (extend RuntimeExecutionError)
 *   <transport>.ts — per-transport run logic (e.g. cli.ts, api.ts, stream.ts)
 *   [optional]  — hooks.ts, sessions.ts, diagnostics.ts, options.ts
 * ```
 */
export interface RuntimeAdapter {
  /** Static metadata describing this runtime's identity and capabilities. */
  descriptor: RuntimeDescriptor;

  // --- Core (required) ---

  /** Execute a prompt. This is the only required method. */
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;

  /**
   * Return effective capabilities for a specific transport.
   * Adapters that support multiple transports with differing capabilities
   * implement this to let the system know what's available per transport.
   * Falls back to `descriptor.capabilities` when not implemented.
   */
  getEffectiveCapabilities?(transport: RuntimeTransport): RuntimeCapabilities;

  // --- Session management (optional, capabilities-gated) ---

  /** Resume an existing session. Gate: supportsResume. */
  resume?(input: RuntimeRunInput & { sessionId: string }): Promise<RuntimeRunResult>;
  /** List recent sessions. Gate: supportsSessionList. */
  listSessions?(input: RuntimeSessionListInput): Promise<RuntimeSession[]>;
  /** Get a single session by ID. Gate: supportsSessionList. */
  getSession?(input: RuntimeSessionGetInput): Promise<RuntimeSession | null>;
  /** List messages/events within a session. Gate: supportsSessionList. */
  listSessionEvents?(input: RuntimeSessionEventsInput): Promise<RuntimeEvent[]>;

  // --- Discovery & validation (optional) ---

  /** Check whether the runtime is reachable and configured. */
  validateConnection?(
    input: RuntimeConnectionValidationInput,
  ): Promise<RuntimeConnectionValidationResult>;
  /** Enumerate available models. Gate: supportsModelDiscovery. */
  listModels?(input: RuntimeModelListInput): Promise<RuntimeModel[]>;

  // --- Quality-of-life (optional) ---

  /** Adapter-specific error diagnosis — returns a human-readable explanation from error + stderr. */
  diagnoseError?(input: RuntimeDiagnoseErrorInput): Promise<string>;
  /** Strip runtime-specific internal tags/markup from user input before storing. */
  sanitizeInput?(text: string): string;

  // --- MCP integration (optional) ---

  /** Initialize runtime-specific project directory structure via ai-factory init. */
  initProject?(projectRoot: string): void;

  /** Get current MCP server installation status for this runtime. */
  getMcpStatus?(input: RuntimeMcpInput): Promise<RuntimeMcpStatus>;
  /** Install an MCP server into this runtime's config. */
  installMcpServer?(input: RuntimeMcpInstallInput): Promise<void>;
  /** Remove an MCP server from this runtime's config. */
  uninstallMcpServer?(input: RuntimeMcpInput): Promise<void>;
}

/**
 * Get effective capabilities for an adapter, optionally for a specific transport.
 *
 * Adapters that support multiple transports with different capability sets
 * implement `getEffectiveCapabilities(transport)`. When transport is provided
 * and the adapter implements the method, it returns transport-specific capabilities.
 * Otherwise falls back to the static `descriptor.capabilities`.
 */
export function resolveAdapterCapabilities(
  adapter: RuntimeAdapter,
  transport?: RuntimeTransport,
): RuntimeCapabilities {
  if (transport && adapter.getEffectiveCapabilities) {
    return adapter.getEffectiveCapabilities(transport);
  }
  return adapter.descriptor.capabilities;
}
