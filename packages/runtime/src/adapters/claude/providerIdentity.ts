import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export const ClaudeProviderFamily = {
  ANTHROPIC_NATIVE: "anthropic-native",
  ZAI_GLM_CODING: "zai-glm-coding",
  ALIYUN_CODING_PLAN_ANTHROPIC: "aliyun-coding-plan-anthropic",
  OTHER_ANTHROPIC_COMPATIBLE: "other-anthropic-compatible",
} as const;

export type ClaudeProviderFamily = (typeof ClaudeProviderFamily)[keyof typeof ClaudeProviderFamily];

export interface ClaudeLocalSettingsIdentity {
  baseUrl: string | null;
  authToken: string | null;
}

export interface ClaudeProviderIdentity {
  providerFamily: ClaudeProviderFamily;
  providerLabel: string;
  quotaSource: "sdk_event" | "headers" | "zai_monitor" | "none";
  baseUrl: string | null;
  baseOrigin: string | null;
  apiKeyEnvVar: string | null;
  accountFingerprint: string | null;
  accountLabel: string | null;
}

export interface ResolveClaudeProviderIdentityInput {
  providerId?: string | null;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  defaultModel?: string | null;
  localSettingsOverride?: ClaudeLocalSettingsIdentity | null;
}

interface ResolvedAuthContext {
  baseUrl: string | null;
  baseOrigin: string | null;
  apiKeyEnvVar: string | null;
  apiKey: string | null;
  localSettings: ClaudeLocalSettingsIdentity | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.toString().replace(/\/+$/, "") : null;
}

function normalizeBaseOrigin(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.origin.toLowerCase() : null;
}

function normalizeHost(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.hostname.toLowerCase() : null;
}

function normalizePathname(value: string | null | undefined): string | null {
  const parsed = parseUrl(value ?? null);
  return parsed ? parsed.pathname.replace(/\/+$/, "").toLowerCase() : null;
}

function formatHostLabel(hostname: string | null): string {
  if (!hostname) return "Anthropic-compatible";
  return hostname
    .replace(/^www\./, "")
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(".");
}

function computeAccountFingerprint(origin: string | null, apiKey: string | null): string | null {
  if (!apiKey) return null;
  const scope = origin ?? DEFAULT_ANTHROPIC_BASE_URL;
  return createHash("sha256").update(`${scope}|${apiKey}`).digest("hex").slice(0, 16);
}

function readClaudeLocalSettings(): ClaudeLocalSettingsIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = asRecord(parsedJson);
  const env = asRecord(parsed?.env);
  const baseUrl = normalizeBaseUrl(readString(env?.ANTHROPIC_BASE_URL));
  const authToken = readString(env?.ANTHROPIC_AUTH_TOKEN) ?? readString(env?.ANTHROPIC_API_KEY);

  if (!baseUrl && !authToken) {
    return null;
  }

  return {
    baseUrl,
    authToken,
  };
}

function resolveLocalSettingsIdentity(
  input: ResolveClaudeProviderIdentityInput,
): ClaudeLocalSettingsIdentity | null {
  if (input.localSettingsOverride !== undefined) {
    return input.localSettingsOverride;
  }

  if (input.transport === "sdk" || input.transport === "cli") {
    return readClaudeLocalSettings();
  }

  return null;
}

function shouldPreferLocalSettingsAuthToken(
  input: ResolveClaudeProviderIdentityInput,
  localSettings: ClaudeLocalSettingsIdentity | null,
  resolvedBaseUrl: string | null,
): boolean {
  if (!localSettings?.authToken) {
    return false;
  }

  const transport = readString(input.transport);
  if (transport !== "sdk" && transport !== "cli") {
    return false;
  }

  const family = resolveProviderFamily(
    resolvedBaseUrl ?? localSettings.baseUrl ?? null,
    input.providerId ?? null,
    localSettings.authToken,
  );

  return family === ClaudeProviderFamily.ZAI_GLM_CODING;
}

function resolveConfiguredApiKey(
  input: ResolveClaudeProviderIdentityInput,
  localSettings: ClaudeLocalSettingsIdentity | null,
  resolvedBaseUrl: string | null,
): { apiKey: string | null; apiKeyEnvVar: string | null } {
  if (shouldPreferLocalSettingsAuthToken(input, localSettings, resolvedBaseUrl)) {
    return {
      apiKey: localSettings?.authToken ?? null,
      apiKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
    };
  }

  if (input.apiKey) {
    return {
      apiKey: readString(input.apiKey),
      apiKeyEnvVar: readString(input.apiKeyEnvVar),
    };
  }

  const env = input.env ?? process.env;
  const explicitEnvVar = readString(input.apiKeyEnvVar);
  if (explicitEnvVar) {
    const explicitValue = readString(env[explicitEnvVar]);
    if (explicitValue) {
      return {
        apiKey: explicitValue,
        apiKeyEnvVar: explicitEnvVar,
      };
    }
  }

  const host = normalizeHost(resolvedBaseUrl);
  const path = normalizePathname(resolvedBaseUrl);
  const providerId = (input.providerId ?? "").trim().toLowerCase();

  const candidateEnvVars = new Set<string>();
  if (host === "api.z.ai" || host === "open.bigmodel.cn" || host === "dev.bigmodel.cn") {
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
    candidateEnvVars.add("ZAI_API_KEY");
  }
  if (host?.includes("coding.dashscope.aliyuncs.com")) {
    candidateEnvVars.add("DASHSCOPE_API_KEY");
    candidateEnvVars.add("OPENAI_API_KEY");
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }
  if (providerId === "anthropic" || !resolvedBaseUrl) {
    candidateEnvVars.add("ANTHROPIC_API_KEY");
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }
  if (path?.includes("/apps/anthropic")) {
    candidateEnvVars.add("ANTHROPIC_AUTH_TOKEN");
  }

  for (const envVar of candidateEnvVars) {
    const value = readString(env[envVar]);
    if (value) {
      return {
        apiKey: value,
        apiKeyEnvVar: explicitEnvVar ?? envVar,
      };
    }
  }

  if (localSettings?.authToken) {
    return {
      apiKey: localSettings.authToken,
      apiKeyEnvVar: explicitEnvVar ?? "ANTHROPIC_AUTH_TOKEN",
    };
  }

  return {
    apiKey: null,
    apiKeyEnvVar: explicitEnvVar,
  };
}

function resolveProviderFamily(
  baseUrl: string | null,
  providerId: string | null,
  apiKey: string | null,
): ClaudeProviderFamily {
  const host = normalizeHost(baseUrl);
  const path = normalizePathname(baseUrl);
  const normalizedProviderId = (providerId ?? "").toLowerCase();

  if (host === "api.z.ai" || host === "open.bigmodel.cn" || host === "dev.bigmodel.cn") {
    return ClaudeProviderFamily.ZAI_GLM_CODING;
  }

  if (host?.includes("coding.dashscope.aliyuncs.com") && path?.includes("/apps/anthropic")) {
    return ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC;
  }

  if (apiKey?.startsWith("sk-sp-")) {
    return ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC;
  }

  if (!baseUrl && normalizedProviderId === "anthropic") {
    return ClaudeProviderFamily.ANTHROPIC_NATIVE;
  }

  if (host === "api.anthropic.com" || host?.endsWith(".anthropic.com")) {
    return ClaudeProviderFamily.ANTHROPIC_NATIVE;
  }

  return ClaudeProviderFamily.OTHER_ANTHROPIC_COMPATIBLE;
}

function resolveProviderLabel(family: ClaudeProviderFamily, baseUrl: string | null): string {
  switch (family) {
    case ClaudeProviderFamily.ANTHROPIC_NATIVE:
      return "Anthropic";
    case ClaudeProviderFamily.ZAI_GLM_CODING:
      return "Z.AI GLM Coding Plan";
    case ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC:
      return "Alibaba Coding Plan";
    default:
      return formatHostLabel(normalizeHost(baseUrl));
  }
}

function resolveQuotaSource(
  family: ClaudeProviderFamily,
  transport: string | null | undefined,
): ClaudeProviderIdentity["quotaSource"] {
  switch (family) {
    case ClaudeProviderFamily.ZAI_GLM_CODING:
      return "zai_monitor";
    case ClaudeProviderFamily.ANTHROPIC_NATIVE:
      return transport === "api" ? "headers" : "sdk_event";
    case ClaudeProviderFamily.ALIYUN_CODING_PLAN_ANTHROPIC:
      return "none";
    default:
      return transport === "api" ? "headers" : "sdk_event";
  }
}

function resolveAuthContext(input: ResolveClaudeProviderIdentityInput): ResolvedAuthContext {
  const localSettings = resolveLocalSettingsIdentity(input);
  const explicitBaseUrl = normalizeBaseUrl(input.baseUrl);
  const localBaseUrl = localSettings?.baseUrl ?? null;
  const baseUrl = explicitBaseUrl ?? localBaseUrl;
  const { apiKey, apiKeyEnvVar } = resolveConfiguredApiKey(input, localSettings, baseUrl);

  return {
    baseUrl,
    baseOrigin: normalizeBaseOrigin(baseUrl) ?? DEFAULT_ANTHROPIC_BASE_URL,
    apiKey,
    apiKeyEnvVar,
    localSettings,
  };
}

export function resolveClaudeProviderIdentity(
  input: ResolveClaudeProviderIdentityInput,
): ClaudeProviderIdentity {
  const authContext = resolveAuthContext(input);
  const family = resolveProviderFamily(
    authContext.baseUrl,
    input.providerId ?? null,
    authContext.apiKey,
  );
  const providerLabel = resolveProviderLabel(family, authContext.baseUrl);
  const accountFingerprint = computeAccountFingerprint(authContext.baseOrigin, authContext.apiKey);

  return {
    providerFamily: family,
    providerLabel,
    quotaSource: resolveQuotaSource(family, input.transport),
    baseUrl: authContext.baseUrl,
    baseOrigin: authContext.baseOrigin,
    apiKeyEnvVar: authContext.apiKeyEnvVar,
    accountFingerprint,
    accountLabel: null,
  };
}

export function resolveClaudeProviderAuth(input: ResolveClaudeProviderIdentityInput): {
  identity: ClaudeProviderIdentity;
  authToken: string | null;
} {
  const authContext = resolveAuthContext(input);
  const family = resolveProviderFamily(
    authContext.baseUrl,
    input.providerId ?? null,
    authContext.apiKey,
  );
  const providerLabel = resolveProviderLabel(family, authContext.baseUrl);

  return {
    identity: {
      providerFamily: family,
      providerLabel,
      quotaSource: resolveQuotaSource(family, input.transport),
      baseUrl: authContext.baseUrl,
      baseOrigin: authContext.baseOrigin,
      apiKeyEnvVar: authContext.apiKeyEnvVar,
      accountFingerprint: computeAccountFingerprint(authContext.baseOrigin, authContext.apiKey),
      accountLabel: null,
    },
    authToken: authContext.apiKey,
  };
}
