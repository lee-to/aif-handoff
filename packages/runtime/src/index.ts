export {
  DEFAULT_RUNTIME_CAPABILITIES,
  getResultSessionId,
  resolveAdapterCapabilities,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectionValidationInput,
  type RuntimeConnectionValidationResult,
  type RuntimeDescriptor,
  type RuntimeDiagnoseErrorInput,
  type RuntimeMcpInput,
  type RuntimeMcpInstallInput,
  type RuntimeMcpStatus,
  type RuntimeEvent,
  type RuntimeExecutionIntent,
  type RuntimeLimitEventPayload,
  RuntimeLimitPrecision,
  RuntimeLimitScope,
  type RuntimeLimitSnapshot,
  RuntimeLimitSource,
  RuntimeLimitStatus,
  type RuntimeLimitWindow,
  RUNTIME_LIMIT_EVENT_TYPE,
  type RuntimeSubagentStartCallback,
  type RuntimeToolQuestionPayload,
  type RuntimeToolUseCallback,
  type RuntimeModel,
  type RuntimeModelListInput,
  type RuntimeRunInput,
  type RuntimeRunResult,
  type RuntimeSession,
  type RuntimeSessionEventsInput,
  type RuntimeSessionGetInput,
  type RuntimeSessionListInput,
  isRuntimeTransport,
  RUNTIME_TRANSPORTS,
  RuntimeTransport,
  type RuntimeUsage,
  type RuntimeUsageContext,
  UsageReporting,
  UsageSource,
} from "./types.js";

export { createNoopUsageSink, type RuntimeUsageEvent, type RuntimeUsageSink } from "./usageSink.js";

export {
  buildToolUseEvents,
  toolQuestionEvent,
  type BuildToolUseEventsInput,
} from "./toolEvents.js";

export {
  type RegisterRuntimeModule,
  type RuntimeModule,
  resolveRuntimeModuleRegistrar,
} from "./module.js";

export {
  RuntimeError,
  RuntimeCapabilityError,
  RuntimeExecutionError,
  RuntimeModuleLoadError,
  RuntimeModuleValidationError,
  RuntimeRegistrationError,
  RuntimeResolutionError,
  RuntimeValidationError,
  classifyByHttpStatus,
  classifyByMessageFallback,
  isExternalFailureCategory,
  isRuntimeErrorCategory,
  type RuntimeExecutionErrorMetadata,
  type RuntimeErrorCategory,
} from "./errors.js";

export {
  createRuntimeRegistry,
  type RegisterRuntimeOptions,
  RuntimeRegistry,
  type RuntimeRegistryLogger,
  type RuntimeRegistryOptions,
} from "./registry.js";

export {
  assertRuntimeCapabilities,
  checkRuntimeCapabilities,
  type RuntimeCapabilityCheckInput,
  type RuntimeCapabilityCheckResult,
  type RuntimeCapabilityName,
} from "./capabilities.js";

export { createRuntimeMemoryCache, type RuntimeCache, type RuntimeCacheOptions } from "./cache.js";

export {
  createRuntimeModelDiscoveryService,
  type RuntimeModelDiscoveryLogger,
  type RuntimeModelDiscoveryOptions,
  type RuntimeModelDiscoveryService,
} from "./modelDiscovery.js";

export {
  isValidEnvVarName,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
  validateResolvedRuntimeProfile,
  type ResolveRuntimeProfileInput,
  type ResolvedRuntimeProfile,
  type RuntimeProfileLike,
  type RuntimeResolutionEnv,
  type RuntimeResolutionLogger,
  type RuntimeValidationResult,
} from "./resolution.js";

export {
  resolveRuntimePromptPolicy,
  transformSkillCommandPrefix,
  type RuntimePromptPolicyInput,
  type RuntimePromptPolicyLogger,
  type RuntimePromptPolicyResult,
} from "./promptPolicy.js";

export {
  createRuntimeWorkflowSpec,
  type RuntimeSessionReusePolicy,
  type RuntimeWorkflowFallbackStrategy,
  type RuntimeWorkflowKind,
  type RuntimeWorkflowPromptInput,
  type RuntimeWorkflowSpec,
  type RuntimeWorkflowSpecInput,
} from "./workflowSpec.js";

export { bootstrapRuntimeRegistry, type BootstrapRuntimeRegistryOptions } from "./bootstrap.js";

export { buildLanguageDirective, type LanguageDirectiveInput } from "./languagePolicy.js";

export { initProject, type InitProjectOptions, type InitProjectResult } from "./projectInit.js";

export { isValidTrustToken, RUNTIME_TRUST_TOKEN, type RuntimeTrustToken } from "./trust.js";

export {
  isRetriableTimeoutError,
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  resolveRetryDelay,
  sleepMs,
  TIMEOUT_RETRIABLE_KEY,
  type ProcessTimeoutResult,
  type TimeoutIntent,
  type TimeoutLogger,
  withProcessTimeouts,
  withStreamTimeouts,
} from "./timeouts.js";

export {
  buildRuntimeLimitSignature,
  mapSafeRuntimeErrorReason,
  normalizeRuntimeLimitSnapshot,
  resolveRuntimeLimitFutureHint,
  sanitizeProviderMeta,
  selectViolatedWindowForExactThreshold,
  type RuntimeLimitFutureHint,
  type RuntimeLimitFutureHintSource,
  type SafeRuntimeErrorCategory,
  type SafeRuntimeErrorReason,
} from "@aif/shared";

/**
 * Adapter factories are intentionally NOT re-exported from the package root.
 *
 * The only supported way to obtain a runtime adapter is through
 * `bootstrapRuntimeRegistry()` / `createRuntimeRegistry()` → `resolveRuntime()`,
 * which wraps every adapter with the usage pipeline. Importing a factory
 * directly bypasses that wrapper and silently drops token accounting — so
 * external consumers must never do it. The ESLint `no-restricted-imports`
 * rule in the repo root prevents deep imports like
 * `@aif/runtime/src/adapters/...` outside of `packages/runtime/**`.
 */
export type {
  ClaudeRuntimeAdapterLogger,
  CreateClaudeRuntimeAdapterOptions,
} from "./adapters/claude/index.js";

export type {
  CodexRuntimeAdapterLogger,
  CreateCodexRuntimeAdapterOptions,
} from "./adapters/codex/index.js";

export { getCodexAuthIdentity, type CodexAuthIdentity } from "./adapters/codex/sessions.js";
export {
  ClaudeProviderFamily,
  resolveClaudeProviderAuth,
  resolveClaudeProviderIdentity,
  type ClaudeLocalSettingsIdentity,
  type ClaudeProviderFamily as ClaudeProviderFamilyType,
  type ClaudeProviderIdentity,
  type ResolveClaudeProviderIdentityInput,
} from "./adapters/claude/providerIdentity.js";

export type {
  CreateOpenCodeRuntimeAdapterOptions,
  OpenCodeRuntimeAdapterLogger,
} from "./adapters/opencode/index.js";

export type {
  CreateOpenRouterRuntimeAdapterOptions,
  OpenRouterAdapterLogger,
} from "./adapters/openrouter/index.js";
