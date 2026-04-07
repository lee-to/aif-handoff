/**
 * ============================================================================
 * Runtime Adapter Template
 * ============================================================================
 *
 * Copy this file to create a new runtime adapter. Each adapter connects the
 * system to a different AI provider or execution backend.
 *
 * ## Quick start
 *
 * 1. Create `adapters/<name>/index.ts` — copy this file, implement `run()`
 * 2. Create `adapters/<name>/errors.ts` — extend RuntimeExecutionError
 * 3. Register in `bootstrap.ts`:
 *    ```ts
 *    builtInAdapters: [
 *      createClaudeRuntimeAdapter(),
 *      createCodexRuntimeAdapter(),
 *      createYourRuntimeAdapter(),  // <-- add here
 *    ]
 *    ```
 *    Or load dynamically via AIF_RUNTIME_MODULES env var.
 *
 * ## File structure convention
 *
 * ```
 * adapters/<name>/
 *   index.ts        — factory: create<Name>RuntimeAdapter(options) → RuntimeAdapter
 *   errors.ts       — error subclass + classifier function
 *   <transport>.ts  — per-transport logic (e.g. cli.ts, api.ts, sdk.ts)
 *   [sessions.ts]   — if supportsSessionList / supportsResume
 *   [diagnostics.ts]— if diagnoseError() needs CLI probing or stderr analysis
 *   [hooks.ts]      — if the SDK has a hook/callback system
 *   [options.ts]    — if execution intent parsing is complex
 * ```
 *
 * ## Transport types
 *
 * | Transport | When to use                                    | Example       |
 * |-----------|------------------------------------------------|---------------|
 * | SDK       | In-process library call (JS/TS SDK)             | Claude Agent SDK, Codex SDK |
 * | CLI       | Spawn a subprocess, parse stdout                | `codex run --json` |
 * | API       | HTTP POST to a remote endpoint                  | OpenAI-compatible REST API |
 *
 * Adapter can support multiple transports (see Codex adapter: sdk.ts + cli.ts + api.ts).
 * Transport is selected via RuntimeProfile.transport field.
 *
 * ## Capabilities → optional methods mapping
 *
 * | Capability              | Enables method(s)                                     |
 * |-------------------------|-------------------------------------------------------|
 * | supportsResume          | resume()                                              |
 * | supportsSessionList     | listSessions(), getSession(), listSessionEvents()     |
 * | supportsModelDiscovery  | listModels()                                          |
 * | supportsAgentDefinitions| execution.agentDefinitionName is forwarded to the SDK |
 * | supportsStreaming       | execution.onEvent receives streaming deltas            |
 * | supportsApprovals       | human-in-the-loop approval flows                      |
 * | supportsCustomEndpoint  | profile.baseUrl is respected                          |
 *
 * Set capabilities to false for features you don't implement.
 * The system checks capabilities BEFORE calling optional methods.
 *
 * ## Transport-aware capabilities
 *
 * If your adapter supports multiple transports with different capability sets,
 * implement `getEffectiveCapabilities(transport)`. The system calls
 * `resolveAdapterCapabilities(adapter, transport)` to get the effective set.
 *
 * ```ts
 * getEffectiveCapabilities(transport: RuntimeTransport): RuntimeCapabilities {
 *   if (transport === RuntimeTransport.SDK) return SDK_CAPS;
 *   if (transport === RuntimeTransport.CLI) return CLI_CAPS;
 *   return DEFAULT_CAPS;
 * }
 * ```
 *
 * `descriptor.capabilities` should reflect the default transport's capabilities.
 *
 * ## Reading execution options in run()
 *
 * ```ts
 * async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
 *   const exec = input.execution;            // RuntimeExecutionIntent | undefined
 *   const prompt = input.prompt;
 *   const model = input.model;               // resolved from profile/override/env
 *   const projectRoot = input.projectRoot;
 *
 *   // Generic options (any adapter can use):
 *   exec?.maxBudgetUsd       // cost cap
 *   exec?.maxTurns           // iteration limit
 *   exec?.timeoutMs          // first-output timeout
 *   exec?.systemPromptAppend // appended to system prompt
 *   exec?.environment        // env vars for subprocess
 *   exec?.abortController    // cancellation signal
 *   exec?.bypassPermissions  // skip permission checks (requires trust token in hooks)
 *
 *   // Lifecycle callbacks (fire-and-forget):
 *   exec?.onToolUse?.(toolName, detail)       // after each tool use
 *   exec?.onSubagentStart?.(name, id)         // when a subagent spawns
 *   exec?.onStderr?.(chunk)                   // stderr from subprocess
 *   exec?.onEvent?.(event)                    // streaming events
 *
 *   // Adapter-specific (opaque bag):
 *   const hooks = exec?.hooks ?? {};
 *   // Read whatever your adapter needs from hooks.
 *   // Example: hooks._trustToken, hooks.settingSources, etc.
 * }
 * ```
 *
 * ## Error handling
 *
 * Create an error subclass in errors.ts:
 * ```ts
 * import { RuntimeExecutionError } from "../../errors.js";
 *
 * export class YourRuntimeAdapterError extends RuntimeExecutionError {
 *   public readonly adapterCode: string;
 *   constructor(message: string, adapterCode: string, cause?: unknown) {
 *     super(message, cause);
 *     this.name = "YourRuntimeAdapterError";
 *     this.adapterCode = adapterCode;
 *   }
 * }
 *
 * export function classifyYourRuntimeError(error: unknown): YourRuntimeAdapterError {
 *   const message = error instanceof Error ? error.message : String(error);
 *   // Classify by patterns → return specific adapterCode
 *   return new YourRuntimeAdapterError(message, "YOUR_RUNTIME_ERROR", error);
 * }
 * ```
 *
 * ## Dynamic module loading
 *
 * External adapters can be loaded without modifying bootstrap.ts:
 *
 * ```
 * AIF_RUNTIME_MODULES=@org/my-runtime-adapter
 * ```
 *
 * The module must export `registerRuntimeModule(registry)`:
 * ```ts
 * export function registerRuntimeModule(registry: RuntimeRegistry) {
 *   registry.registerRuntime(createYourRuntimeAdapter());
 * }
 * ```
 */

import {
  DEFAULT_RUNTIME_CAPABILITIES,
  type RuntimeAdapter,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "../types.js";

export interface CreateExampleRuntimeAdapterOptions {
  runtimeId?: string;
  providerId?: string;
  displayName?: string;
}

export function createExampleRuntimeAdapter(
  options: CreateExampleRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const runtimeId = options.runtimeId ?? "example";
  const providerId = options.providerId ?? "example-provider";

  return {
    descriptor: {
      id: runtimeId,
      providerId,
      displayName: options.displayName ?? "Example Runtime",
      lightModel: null, // cheap model for review-gate etc., or null for default
      defaultApiKeyEnvVar: "MY_API_KEY", // env var name shown in UI placeholder
      defaultModelPlaceholder: "my-model-v1", // model name shown in UI placeholder
      supportedTransports: ["api"], // which transports this adapter handles
      capabilities: {
        ...DEFAULT_RUNTIME_CAPABILITIES,
        // Enable what you implement:
        // supportsStreaming: true,
        // supportsModelDiscovery: true,
        // supportsCustomEndpoint: true,
      },
    },

    async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
      // Implement your runtime execution here.
      // See "Reading execution options in run()" in the JSDoc above.
      void input;
      throw new Error(`${runtimeId} adapter: run() not implemented`);
    },

    // Uncomment and implement as you enable capabilities:
    //
    // getEffectiveCapabilities(transport) {
    //   // Return per-transport capabilities if different from descriptor.capabilities
    //   return this.descriptor.capabilities;
    // },
    // async resume(input) { ... },
    // async listSessions(input) { ... },
    // async getSession(input) { ... },
    // async listSessionEvents(input) { ... },
    // async validateConnection(input) { ... },
    // async listModels(input) { ... },
    // async diagnoseError(input) { ... },
    // sanitizeInput(text) { return text.trim(); },
  };
}
