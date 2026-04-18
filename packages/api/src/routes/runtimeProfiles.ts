import { Hono } from "hono";
import { z } from "zod";
import {
  createRuntimeWorkflowSpec,
  getCodexAuthIdentity,
  isValidEnvVarName,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
} from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import {
  createRuntimeProfile,
  deleteRuntimeProfile,
  findRuntimeProfileById,
  findTaskById,
  getRuntimeProfileResponseById,
  listRuntimeProfileResponses,
  resolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse,
  updateRuntimeProfile,
} from "@aif/data";
import {
  createRuntimeProfileSchema,
  runtimeProfileModelsSchema,
  runtimeProfileValidationSchema,
  updateRuntimeProfileSchema,
} from "../schemas.js";
import { getApiRuntimeModelDiscoveryService, getApiRuntimeRegistry } from "../services/runtime.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { jsonValidator } from "../middleware/zodValidator.js";

const log = logger("runtime-profile-route");

const validationRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
const mutationRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

export const runtimeProfilesRouter = new Hono();
type CreateRuntimeProfilePayload = z.infer<typeof createRuntimeProfileSchema>;
type UpdateRuntimeProfilePayload = z.infer<typeof updateRuntimeProfileSchema>;
type RuntimeProfileValidationPayload = z.infer<typeof runtimeProfileValidationSchema>;
type RuntimeProfileModelsPayload = z.infer<typeof runtimeProfileModelsSchema>;

const ALLOWED_HEADER_PREFIXES = [
  "content-",
  "accept",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "user-agent",
  "cache-control",
  "if-",
];

function listSensitiveHeaderKeys(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers).filter((key) => {
    const lowered = key.toLowerCase();
    return !ALLOWED_HEADER_PREFIXES.some(
      (prefix) => lowered === prefix || lowered.startsWith(prefix),
    );
  });
}

function inferApiKeyEnvVar(profile: {
  runtimeId: string;
  providerId: string;
  apiKeyEnvVar?: string | null;
}): string {
  const explicitEnvVar = profile.apiKeyEnvVar?.trim();
  if (isValidEnvVarName(explicitEnvVar)) return explicitEnvVar;
  if (explicitEnvVar) {
    log.warn(
      {
        runtimeId: profile.runtimeId,
        providerId: profile.providerId,
        invalidApiKeyEnvVar: explicitEnvVar,
      },
      "WARN [runtime-profile-route] Invalid apiKeyEnvVar provided for temporary validation key; using inferred fallback",
    );
  }

  // Delegate provider-specific logic to the resolution layer via a lightweight resolve pass.
  const resolved = resolveRuntimeProfile({
    source: "api-key-inference",
    profile: { runtimeId: profile.runtimeId, providerId: profile.providerId },
    fallbackRuntimeId: profile.runtimeId,
    fallbackProviderId: profile.providerId,
  });
  return resolved.apiKeyEnvVar ?? "OPENAI_API_KEY";
}

function sanitizeBooleanQuery(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalCodexProfile(profile: { runtimeId: string; transport?: string | null }): boolean {
  return (
    profile.runtimeId === "codex" && (profile.transport === "sdk" || profile.transport === "cli")
  );
}

function readProviderMetaString(
  providerMeta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = providerMeta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface LocalCodexAccountProfileLike {
  runtimeId: string;
  transport?: string | null;
  runtimeLimitSnapshot?: {
    providerMeta?: Record<string, unknown> | null;
  } | null;
}

function enrichProfileWithCodexIdentity<T extends LocalCodexAccountProfileLike>(
  profile: T,
  identity: Awaited<ReturnType<typeof getCodexAuthIdentity>>,
): T {
  if (!isLocalCodexProfile(profile) || !profile.runtimeLimitSnapshot || !identity) {
    return profile;
  }

  const snapshot = profile.runtimeLimitSnapshot;
  const providerMeta = isObjectRecord(snapshot.providerMeta) ? snapshot.providerMeta : {};
  const nextProviderMeta = {
    ...providerMeta,
    ...(readProviderMetaString(providerMeta, "accountId") ? {} : { accountId: identity.accountId }),
    ...(readProviderMetaString(providerMeta, "authMode") ? {} : { authMode: identity.authMode }),
    ...(readProviderMetaString(providerMeta, "accountName")
      ? {}
      : { accountName: identity.accountName }),
    ...(readProviderMetaString(providerMeta, "accountEmail")
      ? {}
      : { accountEmail: identity.accountEmail }),
    ...(readProviderMetaString(providerMeta, "planType") ? {} : { planType: identity.planType }),
  };

  return {
    ...profile,
    runtimeLimitSnapshot: {
      ...snapshot,
      providerMeta: nextProviderMeta,
    },
  };
}

async function enrichProfilesWithCodexIdentity<T extends LocalCodexAccountProfileLike>(
  profiles: T[],
): Promise<T[]> {
  if (!profiles.some((profile) => isLocalCodexProfile(profile) && profile.runtimeLimitSnapshot)) {
    return profiles;
  }

  const identity = await getCodexAuthIdentity();
  if (!identity) {
    return profiles;
  }

  return profiles.map((profile) => enrichProfileWithCodexIdentity(profile, identity));
}

function resolveValidationProfile(input: {
  profileId?: string;
  projectId?: string;
  profile?:
    | {
        projectId?: string | null;
        name: string;
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
    | undefined;
}) {
  if (input.profileId) {
    const row = findRuntimeProfileById(input.profileId);
    if (!row) return null;
    return {
      source: "profile_id",
      profile: toRuntimeProfileResponse(row),
    } as const;
  }

  if (input.profile) {
    return {
      source: "payload",
      profile: {
        id: null,
        projectId: input.profile.projectId ?? null,
        name: input.profile.name,
        runtimeId: input.profile.runtimeId,
        providerId: input.profile.providerId,
        transport: input.profile.transport ?? null,
        baseUrl: input.profile.baseUrl ?? null,
        apiKeyEnvVar: input.profile.apiKeyEnvVar ?? null,
        defaultModel: input.profile.defaultModel ?? null,
        headers: input.profile.headers ?? {},
        options: input.profile.options ?? {},
        enabled: input.profile.enabled ?? true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as const;
  }

  if (input.projectId) {
    const effective = resolveEffectiveRuntimeProfile({
      projectId: input.projectId,
      mode: "task",
      systemDefaultRuntimeProfileId: null,
    });
    if (!effective.profile) {
      return null;
    }
    return {
      source: `effective:${effective.source}`,
      profile: effective.profile,
    } as const;
  }

  return null;
}

// GET /runtime-profiles/runtimes
runtimeProfilesRouter.get("/runtimes", async (c) => {
  const registry = await getApiRuntimeRegistry();
  return c.json(
    registry.listRuntimes().map((runtime) => ({
      id: runtime.id,
      providerId: runtime.providerId,
      displayName: runtime.displayName,
      description: runtime.description ?? null,
      capabilities: runtime.capabilities,
      defaultTransport: runtime.defaultTransport ?? null,
      defaultApiKeyEnvVar: runtime.defaultApiKeyEnvVar ?? null,
      defaultBaseUrlEnvVar: runtime.defaultBaseUrlEnvVar ?? null,
      defaultBaseUrl: runtime.defaultBaseUrlEnvVar
        ? (process.env[runtime.defaultBaseUrlEnvVar] ?? null)
        : null,
      defaultModelPlaceholder: runtime.defaultModelPlaceholder ?? null,
      supportedTransports: runtime.supportedTransports ?? [],
    })),
  );
});

// GET /runtime-profiles?projectId=...&includeGlobal=...&enabledOnly=...
runtimeProfilesRouter.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  const includeGlobal = sanitizeBooleanQuery(c.req.query("includeGlobal"), true);
  const enabledOnly = sanitizeBooleanQuery(c.req.query("enabledOnly"), false);

  log.debug(
    { projectId, includeGlobal, enabledOnly },
    "DEBUG [runtime-profile-route] List request",
  );
  const profiles = listRuntimeProfileResponses({ projectId, includeGlobal, enabledOnly });
  return c.json(await enrichProfilesWithCodexIdentity(profiles));
});

// GET /runtime-profiles/:id
runtimeProfilesRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const profile = getRuntimeProfileResponseById(id);
  if (!profile) return c.json({ error: "Runtime profile not found" }, 404);
  return c.json((await enrichProfilesWithCodexIdentity([profile]))[0]);
});

// POST /runtime-profiles
runtimeProfilesRouter.post(
  "/",
  mutationRateLimit,
  jsonValidator(createRuntimeProfileSchema),
  async (c) => {
    const body = c.req.valid("json") as CreateRuntimeProfilePayload;
    const sensitiveHeaderKeys = listSensitiveHeaderKeys(body.headers);
    if (sensitiveHeaderKeys.length > 0) {
      log.warn(
        { profileName: body.name, runtimeId: body.runtimeId, sensitiveHeaderKeys },
        "WARN [runtime-profile-route] Rejected create request with sensitive header keys",
      );
      return c.json(
        {
          error: "Sensitive header keys are not allowed in persisted runtime profiles",
          fieldErrors: {
            headers: sensitiveHeaderKeys.map((key) => `Disallowed header key: ${key}`),
          },
        },
        400,
      );
    }

    const created = createRuntimeProfile(body);
    if (!created) return c.json({ error: "Failed to create runtime profile" }, 500);
    log.debug(
      { profileId: created.id, runtimeId: created.runtimeId, providerId: created.providerId },
      "DEBUG [runtime-profile-route] Created runtime profile",
    );
    return c.json(toRuntimeProfileResponse(created), 201);
  },
);

// PUT /runtime-profiles/:id
runtimeProfilesRouter.put(
  "/:id",
  mutationRateLimit,
  jsonValidator(updateRuntimeProfileSchema),
  async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid("json") as UpdateRuntimeProfilePayload;
    const existing = findRuntimeProfileById(id);
    if (!existing) return c.json({ error: "Runtime profile not found" }, 404);
    const sensitiveHeaderKeys = listSensitiveHeaderKeys(body.headers);
    if (sensitiveHeaderKeys.length > 0) {
      log.warn(
        { profileId: id, runtimeId: existing.runtimeId, sensitiveHeaderKeys },
        "WARN [runtime-profile-route] Rejected update request with sensitive header keys",
      );
      return c.json(
        {
          error: "Sensitive header keys are not allowed in persisted runtime profiles",
          fieldErrors: {
            headers: sensitiveHeaderKeys.map((key) => `Disallowed header key: ${key}`),
          },
        },
        400,
      );
    }
    const updated = updateRuntimeProfile(id, body);
    if (!updated) return c.json({ error: "Failed to update runtime profile" }, 500);
    return c.json(toRuntimeProfileResponse(updated));
  },
);

// DELETE /runtime-profiles/:id
runtimeProfilesRouter.delete("/:id", mutationRateLimit, async (c) => {
  const { id } = c.req.param();
  const existing = findRuntimeProfileById(id);
  if (!existing) return c.json({ error: "Runtime profile not found" }, 404);
  deleteRuntimeProfile(id);
  return c.json({ success: true });
});

// GET /runtime-profiles/effective/task/:taskId
runtimeProfilesRouter.get("/effective/task/:taskId", async (c) => {
  const { taskId } = c.req.param();
  const task = findTaskById(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId: null,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile
      ? (await enrichProfilesWithCodexIdentity([effective.profile]))[0]
      : effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
  });
});

// GET /runtime-profiles/effective/chat/:projectId
runtimeProfilesRouter.get("/effective/chat/:projectId", async (c) => {
  const { projectId } = c.req.param();
  const effective = resolveEffectiveRuntimeProfile({
    projectId,
    mode: "chat",
    systemDefaultRuntimeProfileId: null,
  });

  const workflow = createRuntimeWorkflowSpec({
    workflowKind: "chat",
    prompt: "Resolve effective chat runtime profile",
    requiredCapabilities: [],
    sessionReusePolicy: "never",
  });
  const resolved = resolveRuntimeProfile({
    source: effective.source,
    profile: effective.profile,
    workflow,
    fallbackRuntimeId: getEnv().AIF_DEFAULT_RUNTIME_ID,
    fallbackProviderId: getEnv().AIF_DEFAULT_PROVIDER_ID,
    env: process.env,
    allowDisabled: true,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile
      ? (await enrichProfilesWithCodexIdentity([effective.profile]))[0]
      : effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
    resolved: redactResolvedRuntimeProfile(resolved),
  });
});

// POST /runtime-profiles/validate
runtimeProfilesRouter.post(
  "/validate",
  validationRateLimit,
  jsonValidator(runtimeProfileValidationSchema),
  async (c) => {
    const body = c.req.valid("json") as RuntimeProfileValidationPayload;
    const resolvedInput = resolveValidationProfile({
      profileId: body.profileId,
      projectId: body.projectId,
      profile: body.profile,
    });

    if (!resolvedInput) {
      return c.json(
        {
          error:
            "Provide profileId, profile payload, or projectId with an existing effective profile",
        },
        400,
      );
    }

    const env: Record<string, string | undefined> = {};
    if (body.apiKey) {
      const envKey = inferApiKeyEnvVar(resolvedInput.profile);
      env[envKey] = body.apiKey;
      log.warn(
        { source: resolvedInput.source, envKey },
        "WARN [runtime-profile-route] Temporary API key received for validation only",
      );
    }

    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "runtime-validate",
      prompt: "Validate runtime connectivity",
      requiredCapabilities: [],
      sessionReusePolicy: "never",
    });

    const resolved = resolveRuntimeProfile({
      source: resolvedInput.source,
      profile: resolvedInput.profile,
      workflow,
      modelOverride: body.modelOverride ?? null,
      runtimeOptionsOverride: body.runtimeOptions ?? null,
      allowDisabled: true,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    try {
      const discovery = await getApiRuntimeModelDiscoveryService();
      const validation = await discovery.validateConnection(resolved, body.forceRefresh ?? true);

      log.info(
        {
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          ok: validation.ok,
        },
        "INFO [runtime-profile-route] Validation completed",
      );

      return c.json({
        ok: validation.ok,
        message: validation.message,
        details: validation.details ?? null,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runtimeId: resolved.runtimeId }, "Runtime profile validation failed");
      return c.json({
        ok: false,
        message,
        details: null,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    }
  },
);

// POST /runtime-profiles/models
runtimeProfilesRouter.post(
  "/models",
  validationRateLimit,
  jsonValidator(runtimeProfileModelsSchema),
  async (c) => {
    const body = c.req.valid("json") as RuntimeProfileModelsPayload;
    const resolvedInput = resolveValidationProfile({
      profileId: body.profileId,
      projectId: body.projectId,
      profile: body.profile,
    });

    if (!resolvedInput) {
      return c.json(
        {
          error:
            "Provide profileId, profile payload, or projectId with an existing effective profile",
        },
        400,
      );
    }

    const env: Record<string, string | undefined> = {};
    if (body.apiKey) {
      const envKey = inferApiKeyEnvVar(resolvedInput.profile);
      env[envKey] = body.apiKey;
      log.warn(
        { source: resolvedInput.source, envKey },
        "WARN [runtime-profile-route] Temporary API key received for model discovery only",
      );
    }

    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "runtime-models",
      prompt: "List runtime models",
      requiredCapabilities: ["supportsModelDiscovery"],
      sessionReusePolicy: "never",
    });

    const resolved = resolveRuntimeProfile({
      source: resolvedInput.source,
      profile: resolvedInput.profile,
      workflow,
      modelOverride: body.modelOverride ?? null,
      runtimeOptionsOverride: body.runtimeOptions ?? null,
      allowDisabled: true,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    try {
      const discovery = await getApiRuntimeModelDiscoveryService();
      const models = await discovery.listModels(resolved, body.forceRefresh ?? true);

      log.info(
        {
          runtimeId: resolved.runtimeId,
          providerId: resolved.providerId,
          profileId: resolved.profileId,
          modelCount: models.length,
        },
        "INFO [runtime-profile-route] Model discovery completed",
      );

      return c.json({
        models,
        profile: redactResolvedRuntimeProfile(resolved),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runtimeId: resolved.runtimeId }, "Runtime model discovery failed");
      return c.json(
        { error: message, models: [], profile: redactResolvedRuntimeProfile(resolved) },
        422,
      );
    }
  },
);
