import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createRuntimeWorkflowSpec,
  isValidEnvVarName,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
} from "@aif/runtime";
import { logger } from "@aif/shared";
import {
  createRuntimeProfile,
  deleteRuntimeProfile,
  findRuntimeProfileById,
  findTaskById,
  listRuntimeProfiles,
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

const log = logger("runtime-profile-route");

export const runtimeProfilesRouter = new Hono();
type CreateRuntimeProfilePayload = z.infer<typeof createRuntimeProfileSchema>;
type UpdateRuntimeProfilePayload = z.infer<typeof updateRuntimeProfileSchema>;
type RuntimeProfileValidationPayload = z.infer<typeof runtimeProfileValidationSchema>;
type RuntimeProfileModelsPayload = z.infer<typeof runtimeProfileModelsSchema>;

function listSensitiveHeaderKeys(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers).filter((key) => {
    const lowered = key.toLowerCase();
    return (
      lowered.includes("authorization") ||
      lowered.includes("cookie") ||
      lowered.includes("token") ||
      lowered.includes("api-key") ||
      lowered.includes("apikey") ||
      lowered.includes("secret")
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

  const runtimeId = profile.runtimeId.toLowerCase();
  const providerId = profile.providerId.toLowerCase();
  if (runtimeId === "claude" || providerId === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return "OPENAI_API_KEY";
}

function sanitizeBooleanQuery(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
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
  const rows = listRuntimeProfiles({ projectId, includeGlobal, enabledOnly });
  return c.json(rows.map(toRuntimeProfileResponse));
});

// GET /runtime-profiles/:id
runtimeProfilesRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const row = findRuntimeProfileById(id);
  if (!row) return c.json({ error: "Runtime profile not found" }, 404);
  return c.json(toRuntimeProfileResponse(row));
});

// POST /runtime-profiles
runtimeProfilesRouter.post(
  "/",
  zValidator("json", createRuntimeProfileSchema as never),
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
  zValidator("json", updateRuntimeProfileSchema as never),
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
runtimeProfilesRouter.delete("/:id", async (c) => {
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
    profile: effective.profile,
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
    fallbackRuntimeId: "claude",
    fallbackProviderId: "anthropic",
    env: process.env,
    allowDisabled: true,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
    resolved: redactResolvedRuntimeProfile(resolved),
  });
});

// POST /runtime-profiles/validate
runtimeProfilesRouter.post(
  "/validate",
  zValidator("json", runtimeProfileValidationSchema as never),
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

    const env = { ...process.env };
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
      env,
    });

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
  },
);

// POST /runtime-profiles/models
runtimeProfilesRouter.post(
  "/models",
  zValidator("json", runtimeProfileModelsSchema as never),
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

    const env = { ...process.env };
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
      env,
    });

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
  },
);
