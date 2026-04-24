import { Hono } from "hono";
import { z } from "zod";
import {
  createRuntimeWorkflowSpec,
  getCodexAuthIdentity,
  isValidEnvVarName,
  listLatestCodexLimitSnapshots,
  redactResolvedRuntimeProfile,
  resolveClaudeProviderIdentity,
  resolveRuntimeProfile,
  selectPreferredCodexLimitSnapshot,
} from "@aif/runtime";
import {
  getEnv,
  logger,
  normalizeRuntimeLimitSnapshot,
  type RuntimeLimitSnapshot,
} from "@aif/shared";
import {
  createRuntimeProfile,
  deleteRuntimeProfile,
  findRuntimeProfileById,
  findProjectById,
  findTaskById,
  getRuntimeProfileResponseById,
  listRuntimeProfileResponses,
  getAppDefaultRuntimeProfileId,
  resolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse,
  updateRuntimeProfile,
} from "@aif/data";
import {
  createRuntimeProfileSchema,
  runtimeProfileListQuerySchema,
  runtimeProfileModelsSchema,
  runtimeProfileValidationSchema,
  updateRuntimeProfileSchema,
} from "../schemas.js";
import { getApiRuntimeModelDiscoveryService, getApiRuntimeRegistry } from "../services/runtime.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { jsonValidator, queryValidator } from "../middleware/zodValidator.js";

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

function isClaudeProfile(profile: { runtimeId: string }): boolean {
  return profile.runtimeId === "claude";
}

function readProviderMetaString(
  providerMeta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = providerMeta?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface LocalCodexAccountProfileLike {
  id: string;
  projectId?: string | null;
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  defaultModel?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
  runtimeLimitUpdatedAt?: string | null;
}

interface ClaudeIdentityProfileLike {
  runtimeId: string;
  providerId: string;
  transport?: string | null;
  baseUrl?: string | null;
  apiKeyEnvVar?: string | null;
  defaultModel?: string | null;
  runtimeLimitSnapshot?: RuntimeLimitSnapshot | null;
}

type CodexLiveSnapshotList = Awaited<ReturnType<typeof listLatestCodexLimitSnapshots>>;

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
    runtimeLimitSnapshot: normalizeRuntimeLimitSnapshot({
      ...snapshot,
      providerMeta: nextProviderMeta,
    }),
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

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function applyCodexSnapshotToProfile<T extends RuntimeLimitSnapshot>(
  snapshot: T,
  profileId: string,
): T {
  const nextSnapshot = snapshot.profileId === profileId ? snapshot : { ...snapshot, profileId };
  return normalizeRuntimeLimitSnapshot(nextSnapshot) as unknown as T;
}

function mergeCodexLimitSnapshots<T extends RuntimeLimitSnapshot>(...groups: T[][]): T[] {
  const snapshots = groups
    .flat()
    .sort((left, right) => parseTimestampMs(right.checkedAt) - parseTimestampMs(left.checkedAt));
  const merged = new Map<string, T>();

  for (const snapshot of snapshots) {
    const limitId =
      readProviderMetaString(
        isObjectRecord(snapshot.providerMeta) ? snapshot.providerMeta : null,
        "limitId",
      ) ?? "__unknown__";
    if (!merged.has(limitId)) {
      merged.set(limitId, snapshot);
    }
  }

  return [...merged.values()];
}

function createCodexLiveSnapshotLookup() {
  const cache = new Map<string, Promise<CodexLiveSnapshotList>>();

  return {
    async get(input: {
      runtimeId: string;
      providerId: string;
      projectRoot?: string | null;
    }): Promise<CodexLiveSnapshotList> {
      const key = `${input.runtimeId}|${input.providerId}|${input.projectRoot ?? "__global__"}`;
      const cached = cache.get(key);
      if (cached) {
        return await cached;
      }

      const request = listLatestCodexLimitSnapshots({
        runtimeId: input.runtimeId,
        providerId: input.providerId,
        projectRoot: input.projectRoot ?? null,
      }).catch((error) => {
        cache.delete(key);
        throw error;
      });
      cache.set(key, request);
      return await request;
    },
  };
}

async function refreshProfileWithLiveCodexLimit<T extends LocalCodexAccountProfileLike>(
  profile: T,
  selectedProjectId?: string | null,
  snapshotLookup = createCodexLiveSnapshotLookup(),
): Promise<T> {
  // Usage-limits feature is the expensive-I/O path (Codex session scan,
  // Claude identity network call). Gate here so a deployment can opt out
  // via AIF_USAGE_LIMITS_ENABLED=false and skip all associated work.
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profile;
  }

  if (!isLocalCodexProfile(profile)) {
    return profile;
  }

  const model = profile.defaultModel?.trim() ?? null;
  if (!model) {
    return profile;
  }

  const effectiveProjectId = profile.projectId ?? selectedProjectId ?? null;
  const projectRoot = effectiveProjectId
    ? (findProjectById(effectiveProjectId)?.rootPath ?? null)
    : null;
  const projectSnapshots = projectRoot
    ? await snapshotLookup.get({
        runtimeId: profile.runtimeId,
        providerId: profile.providerId,
        projectRoot,
      })
    : [];
  const globalSnapshots = await snapshotLookup.get({
    runtimeId: profile.runtimeId,
    providerId: profile.providerId,
  });
  const liveSnapshots = mergeCodexLimitSnapshots(projectSnapshots, globalSnapshots);
  const persistedProviderMeta = isObjectRecord(profile.runtimeLimitSnapshot?.providerMeta)
    ? profile.runtimeLimitSnapshot.providerMeta
    : null;
  const persistedLimitId = readProviderMetaString(persistedProviderMeta, "limitId");
  const liveSnapshot = selectPreferredCodexLimitSnapshot({
    model,
    snapshots: liveSnapshots,
    preferredLimitId: persistedLimitId,
  });
  if (!liveSnapshot) {
    return profile;
  }

  const persistedAtMs = Math.max(
    parseTimestampMs(profile.runtimeLimitUpdatedAt ?? null),
    parseTimestampMs(profile.runtimeLimitSnapshot?.checkedAt ?? null),
  );
  const liveCheckedAtMs = parseTimestampMs(liveSnapshot.checkedAt);
  if (persistedAtMs > liveCheckedAtMs) {
    return profile;
  }

  return {
    ...profile,
    runtimeLimitSnapshot: applyCodexSnapshotToProfile(liveSnapshot, profile.id),
    runtimeLimitUpdatedAt: liveSnapshot.checkedAt,
  };
}

async function refreshProfilesWithLiveCodexLimits<T extends LocalCodexAccountProfileLike>(
  profiles: T[],
  selectedProjectId?: string | null,
): Promise<T[]> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profiles;
  }
  const snapshotLookup = createCodexLiveSnapshotLookup();
  return await Promise.all(
    profiles.map((profile) =>
      refreshProfileWithLiveCodexLimit(profile, selectedProjectId, snapshotLookup),
    ),
  );
}

async function enrichProfileWithClaudeIdentity<T extends ClaudeIdentityProfileLike>(
  profile: T,
): Promise<T> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profile;
  }
  if (!isClaudeProfile(profile) || !profile.runtimeLimitSnapshot) {
    return profile;
  }

  const identity = await resolveClaudeProviderIdentity({
    providerId: profile.providerId,
    transport: profile.transport ?? null,
    baseUrl: profile.baseUrl ?? null,
    apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
    defaultModel: profile.defaultModel ?? null,
    env: process.env,
  });
  const snapshot = profile.runtimeLimitSnapshot;
  const providerMeta = isObjectRecord(snapshot.providerMeta) ? snapshot.providerMeta : {};
  const nextProviderMeta = {
    ...providerMeta,
    ...(readProviderMetaString(providerMeta, "providerFamily")
      ? {}
      : { providerFamily: identity.providerFamily }),
    ...(readProviderMetaString(providerMeta, "providerLabel")
      ? {}
      : { providerLabel: identity.providerLabel }),
    ...(readProviderMetaString(providerMeta, "quotaSource")
      ? {}
      : { quotaSource: identity.quotaSource }),
    ...(readProviderMetaString(providerMeta, "accountFingerprint")
      ? {}
      : { accountFingerprint: identity.accountFingerprint }),
    ...(readProviderMetaString(providerMeta, "accountLabel")
      ? {}
      : { accountLabel: identity.accountLabel }),
  };

  return {
    ...profile,
    runtimeLimitSnapshot: normalizeRuntimeLimitSnapshot({
      ...snapshot,
      providerMeta: nextProviderMeta,
    }),
  };
}

async function enrichProfilesWithProviderIdentity<
  T extends LocalCodexAccountProfileLike & ClaudeIdentityProfileLike,
>(profiles: T[]): Promise<T[]> {
  if (!getEnv().AIF_USAGE_LIMITS_ENABLED) {
    return profiles;
  }
  const withCodexIdentity = await enrichProfilesWithCodexIdentity(profiles);
  return await Promise.all(
    withCodexIdentity.map((profile) => enrichProfileWithClaudeIdentity(profile)),
  );
}

function compareVisibleRuntimeProfiles(
  left: { id: string; projectId: string | null; createdAt: string },
  right: { id: string; projectId: string | null; createdAt: string },
): number {
  const leftRank = left.projectId == null ? 0 : 1;
  const rightRank = right.projectId == null ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
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
    const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
    const effective = resolveEffectiveRuntimeProfile({
      projectId: input.projectId,
      mode: "task",
      systemDefaultRuntimeProfileId,
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

// GET /runtime-profiles?projectId=...&includeGlobal=...&enabledOnly=...&scope=...
runtimeProfilesRouter.get("/", queryValidator(runtimeProfileListQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const projectId = query.projectId;
  const includeGlobal = sanitizeBooleanQuery(query.includeGlobal, true);
  const enabledOnly = sanitizeBooleanQuery(query.enabledOnly, false);
  const scope = query.scope ?? "visible";

  log.debug(
    { projectId, includeGlobal, enabledOnly, scope },
    "DEBUG [runtime-profile-route] List request",
  );
  if (scope === "project" && !projectId) {
    return c.json({ error: "projectId is required when scope=project" }, 400);
  }

  let profiles;
  if (scope === "global") {
    profiles = listRuntimeProfileResponses({ enabledOnly }).filter(
      (profile) => profile.projectId == null,
    );
  } else if (scope === "project") {
    profiles = listRuntimeProfileResponses({
      projectId,
      includeGlobal: false,
      enabledOnly,
    }).filter((profile) => profile.projectId === projectId);
  } else {
    profiles = listRuntimeProfileResponses({ projectId, includeGlobal, enabledOnly }).sort(
      compareVisibleRuntimeProfiles,
    );
  }
  const refreshedProfiles = await refreshProfilesWithLiveCodexLimits(profiles, projectId ?? null);
  return c.json(await enrichProfilesWithProviderIdentity(refreshedProfiles));
});

// GET /runtime-profiles/:id
runtimeProfilesRouter.get("/:id", async (c) => {
  const { id } = c.req.param();
  const profile = getRuntimeProfileResponseById(id);
  if (!profile) return c.json({ error: "Runtime profile not found" }, 404);
  const refreshedProfile = await refreshProfileWithLiveCodexLimit(
    profile,
    profile.projectId ?? null,
  );
  return c.json((await enrichProfilesWithProviderIdentity([refreshedProfile]))[0]);
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

  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("task");
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId: task.projectId,
    mode: "task",
    systemDefaultRuntimeProfileId,
  });

  return c.json({
    source: effective.source,
    profile: effective.profile
      ? (
          await enrichProfilesWithProviderIdentity([
            await refreshProfileWithLiveCodexLimit(effective.profile, task.projectId),
          ])
        )[0]
      : effective.profile,
    taskRuntimeProfileId: effective.taskRuntimeProfileId,
    projectRuntimeProfileId: effective.projectRuntimeProfileId,
    systemRuntimeProfileId: effective.systemRuntimeProfileId,
  });
});

// GET /runtime-profiles/effective/chat/:projectId
runtimeProfilesRouter.get("/effective/chat/:projectId", async (c) => {
  const { projectId } = c.req.param();
  const systemDefaultRuntimeProfileId = getAppDefaultRuntimeProfileId("chat");
  const effective = resolveEffectiveRuntimeProfile({
    projectId,
    mode: "chat",
    systemDefaultRuntimeProfileId,
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
      ? (
          await enrichProfilesWithProviderIdentity([
            await refreshProfileWithLiveCodexLimit(effective.profile, projectId),
          ])
        )[0]
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
