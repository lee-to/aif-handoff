import {
  isRuntimeTransport as _isRuntimeTransport,
  RUNTIME_TRANSPORTS as _RUNTIME_TRANSPORTS,
  RuntimeTransport as _RuntimeTransport,
} from "@aif/shared";

// Re-exported from @aif/shared — single source of truth for browser + server
export const RuntimeTransport = _RuntimeTransport;
export type RuntimeTransport = (typeof RuntimeTransport)[keyof typeof RuntimeTransport];
export const RUNTIME_TRANSPORTS = _RUNTIME_TRANSPORTS;
export const isRuntimeTransport = _isRuntimeTransport;

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
}

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  supportsResume: false,
  supportsSessionList: false,
  supportsAgentDefinitions: false,
  supportsStreaming: false,
  supportsModelDiscovery: false,
  supportsApprovals: false,
  supportsCustomEndpoint: false,
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
}

export interface RuntimeEvent {
  type: string;
  timestamp: string;
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  data?: Record<string, unknown>;
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
  usage?: RuntimeUsage | null;
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
