import { RuntimeResolutionError, RuntimeValidationError } from "./errors.js";
import { RuntimeTransport } from "./types.js";
import type { RuntimeWorkflowSpec } from "./workflowSpec.js";

export interface RuntimeProfileLike {
  id?: string | null;
  name?: string;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export interface RuntimeResolutionEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  CODEX_CLI_PATH?: string;
  AGENTAPI_BASE_URL?: string;
  [key: string]: string | undefined;
}

export interface RuntimeResolutionLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
}

export interface ResolveRuntimeProfileInput {
  source: string;
  profile: RuntimeProfileLike | null;
  env?: RuntimeResolutionEnv;
  workflow?: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  suppressModelFallback?: boolean;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  fallbackRuntimeId?: string;
  fallbackProviderId?: string;
  allowDisabled?: boolean;
  logger?: RuntimeResolutionLogger;
}

export interface ResolvedRuntimeProfile {
  source: string;
  profileId: string | null;
  runtimeId: string;
  providerId: string;
  transport: RuntimeTransport;
  baseUrl: string | null;
  apiKeyEnvVar: string | null;
  apiKey: string | null;
  model: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  workflow?: RuntimeWorkflowSpec;
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ENV_VAR_NAME_REGEX = /^[A-Za-z0-9_.-]+$/;

export function isValidEnvVarName(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return ENV_VAR_NAME_REGEX.test(trimmed);
}

function inferDefaultApiKeyEnvVar(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    if (normalizeString(env.ANTHROPIC_API_KEY)) return "ANTHROPIC_API_KEY";
    if (normalizeString(env.ANTHROPIC_AUTH_TOKEN)) return "ANTHROPIC_AUTH_TOKEN";
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function inferDefaultBaseUrl(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    return normalizeString(env.ANTHROPIC_BASE_URL);
  }

  return normalizeString(env.OPENAI_BASE_URL);
}

function inferDefaultTransport(runtimeId: string): RuntimeTransport {
  if (runtimeId.toLowerCase() === "codex") return RuntimeTransport.CLI;
  return RuntimeTransport.SDK;
}

function inferDefaultModel(
  runtimeId: string,
  providerId: string,
  env: RuntimeResolutionEnv,
): string | null {
  const runtime = runtimeId.toLowerCase();
  const provider = providerId.toLowerCase();

  if (runtime === "claude" || provider === "anthropic") {
    return normalizeString(env.ANTHROPIC_MODEL);
  }

  if (runtime === "codex" || provider === "openai") {
    return normalizeString(env.OPENAI_MODEL);
  }

  return null;
}

function resolveApiKey(envVarName: string, env: RuntimeResolutionEnv): string | null {
  return normalizeString(env[envVarName]);
}

function mergeRuntimeOptions(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function applyTransportDefaults(
  transport: RuntimeTransport,
  options: Record<string, unknown>,
  env: RuntimeResolutionEnv,
): Record<string, unknown> {
  if (transport === RuntimeTransport.CLI) {
    const codexCliPath = normalizeString(env.CODEX_CLI_PATH);
    if (codexCliPath && options.codexCliPath == null) {
      return { ...options, codexCliPath };
    }
  }

  if (transport === RuntimeTransport.API) {
    const agentApiBaseUrl = normalizeString(env.AGENTAPI_BASE_URL);
    if (agentApiBaseUrl && options.agentApiBaseUrl == null) {
      return { ...options, agentApiBaseUrl };
    }
  }

  return options;
}

export function resolveRuntimeProfile(input: ResolveRuntimeProfileInput): ResolvedRuntimeProfile {
  const env = input.env ?? (process.env as RuntimeResolutionEnv);
  const profile = input.profile;

  const runtimeId = normalizeString(profile?.runtimeId) ?? normalizeString(input.fallbackRuntimeId);
  const providerId =
    normalizeString(profile?.providerId) ?? normalizeString(input.fallbackProviderId);

  if (!runtimeId || !providerId) {
    throw new RuntimeResolutionError(
      "Unable to resolve runtime profile: runtimeId/providerId are missing",
    );
  }

  if (profile?.enabled === false && !input.allowDisabled) {
    throw new RuntimeValidationError(`Runtime profile "${profile.id ?? "unknown"}" is disabled`);
  }

  const rawTransport = normalizeString(profile?.transport);
  const transport: RuntimeTransport =
    (rawTransport === "agentapi"
      ? RuntimeTransport.API
      : (rawTransport as RuntimeTransport | null)) ?? inferDefaultTransport(runtimeId);
  const explicitApiKeyEnvVar = normalizeString(profile?.apiKeyEnvVar);
  const defaultApiKeyEnvVar = inferDefaultApiKeyEnvVar(runtimeId, providerId, env);
  let apiKeyEnvVar = defaultApiKeyEnvVar;
  if (explicitApiKeyEnvVar) {
    if (isValidEnvVarName(explicitApiKeyEnvVar)) {
      apiKeyEnvVar = explicitApiKeyEnvVar;
    } else {
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          invalidApiKeyEnvVar: explicitApiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Invalid apiKeyEnvVar detected; falling back to inferred default env var",
      );
    }
  }
  let apiKey = resolveApiKey(apiKeyEnvVar, env);
  if (!apiKey && explicitApiKeyEnvVar && apiKeyEnvVar !== defaultApiKeyEnvVar) {
    const fallbackApiKey = resolveApiKey(defaultApiKeyEnvVar, env);
    if (fallbackApiKey) {
      input.logger?.warn?.(
        {
          source: input.source,
          profileId: normalizeString(profile?.id),
          runtimeId,
          providerId,
          missingApiKeyEnvVar: apiKeyEnvVar,
          fallbackApiKeyEnvVar: defaultApiKeyEnvVar,
        },
        "Configured apiKeyEnvVar is not set; falling back to inferred default env var",
      );
      apiKeyEnvVar = defaultApiKeyEnvVar;
      apiKey = fallbackApiKey;
    }
  }
  const baseUrl =
    normalizeString(profile?.baseUrl) ?? inferDefaultBaseUrl(runtimeId, providerId, env);
  const model =
    input.suppressModelFallback === true
      ? null
      : (normalizeString(input.modelOverride) ??
        normalizeString(profile?.defaultModel) ??
        inferDefaultModel(runtimeId, providerId, env));
  const headers = profile?.headers ?? {};
  const mergedOptions = mergeRuntimeOptions(profile?.options, input.runtimeOptionsOverride);
  const options = applyTransportDefaults(transport, mergedOptions, env);

  const resolved: ResolvedRuntimeProfile = {
    source: input.source,
    profileId: normalizeString(profile?.id),
    runtimeId,
    providerId,
    transport,
    baseUrl,
    apiKeyEnvVar,
    apiKey,
    model,
    headers,
    options,
    workflow: input.workflow,
  };

  input.logger?.debug?.(
    {
      source: input.source,
      profileId: resolved.profileId,
      runtimeId: resolved.runtimeId,
      providerId: resolved.providerId,
      transport: resolved.transport,
      hasBaseUrl: Boolean(resolved.baseUrl),
      hasApiKey: Boolean(resolved.apiKey),
      model: resolved.model,
      suppressModelFallback: input.suppressModelFallback === true,
      optionKeys: Object.keys(resolved.options),
    },
    "Resolved runtime profile",
  );

  return resolved;
}

export interface RuntimeValidationResult {
  ok: boolean;
  message: string;
  warnings: string[];
}

export function validateResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): RuntimeValidationResult {
  const warnings: string[] = [];

  // API transport requires both key and base URL
  if (resolved.transport === RuntimeTransport.API) {
    if (!resolved.apiKey) {
      warnings.push(
        `Missing API key env var ${resolved.apiKeyEnvVar ?? "unknown"} for runtime "${resolved.runtimeId}" (API transport)`,
      );
    }
    if (!resolved.baseUrl && typeof resolved.options.agentApiBaseUrl !== "string") {
      warnings.push("API transport requires a base URL (set profile baseUrl or AGENTAPI_BASE_URL)");
    }
  }

  // CLI transport requires a CLI path
  if (
    resolved.transport === RuntimeTransport.CLI &&
    typeof resolved.options.codexCliPath !== "string"
  ) {
    warnings.push("CLI transport is selected but codexCliPath is missing");
  }

  // SDK transport — API key is optional (CLI-backed SDKs manage auth via their own login flow)

  const ok = warnings.length === 0;
  return {
    ok,
    message: ok ? "Runtime profile validation passed" : "Runtime profile validation has warnings",
    warnings,
  };
}

export function redactResolvedRuntimeProfile(
  resolved: ResolvedRuntimeProfile,
): Record<string, unknown> {
  return {
    source: resolved.source,
    profileId: resolved.profileId,
    runtimeId: resolved.runtimeId,
    providerId: resolved.providerId,
    transport: resolved.transport,
    baseUrl: resolved.baseUrl,
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    hasApiKey: Boolean(resolved.apiKey),
    model: resolved.model,
    headers: Object.keys(resolved.headers),
    optionKeys: Object.keys(resolved.options),
    workflowKind: resolved.workflow?.workflowKind ?? null,
  };
}
