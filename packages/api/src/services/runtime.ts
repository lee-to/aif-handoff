import {
  checkRuntimeCapabilities,
  createClaudeRuntimeAdapter,
  createCodexRuntimeAdapter,
  createRuntimeMemoryCache,
  createRuntimeModelDiscoveryService,
  createRuntimeRegistry,
  createRuntimeWorkflowSpec,
  redactResolvedRuntimeProfile,
  resolveRuntimeProfile,
  type RuntimeRunResult,
  type RuntimeCapabilityName,
  type ResolvedRuntimeProfile,
  type RuntimeAdapter,
  type RuntimeModelDiscoveryService,
  type RuntimeRegistry,
  type RuntimeWorkflowSpec,
} from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import {
  findProjectById,
  findRuntimeProfileById,
  findTaskById,
  resolveEffectiveRuntimeProfile,
  toRuntimeProfileResponse,
  type ProjectRow,
} from "@aif/data";

const log = logger("api-runtime");

const DEFAULT_RUNTIME_ID = "claude";
const DEFAULT_PROVIDER_ID = "anthropic";

let runtimeRegistryPromise: Promise<RuntimeRegistry> | null = null;
let modelDiscoveryService: RuntimeModelDiscoveryService | null = null;

function buildRuntimeRegistry(): RuntimeRegistry {
  return createRuntimeRegistry({
    builtInAdapters: [createClaudeRuntimeAdapter(), createCodexRuntimeAdapter()],
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-registry] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-module] ${message}`);
      },
    },
  });
}

async function buildRuntimeRegistryWithModules(): Promise<RuntimeRegistry> {
  const env = getEnv();
  const registry = buildRuntimeRegistry();

  for (const moduleSpecifier of env.AIF_RUNTIME_MODULES ?? []) {
    try {
      await registry.registerRuntimeModule(moduleSpecifier);
    } catch (error) {
      log.warn(
        { moduleSpecifier, error },
        "Runtime module failed to load for API runtime registry; continuing with built-ins",
      );
    }
  }

  return registry;
}

export async function getApiRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (!runtimeRegistryPromise) {
    runtimeRegistryPromise = buildRuntimeRegistryWithModules();
  }
  return runtimeRegistryPromise;
}

export async function getApiRuntimeModelDiscoveryService(): Promise<RuntimeModelDiscoveryService> {
  if (!modelDiscoveryService) {
    const registry = await getApiRuntimeRegistry();
    modelDiscoveryService = createRuntimeModelDiscoveryService({
      registry,
      cache: createRuntimeMemoryCache({ defaultTtlMs: 30_000 }),
      validationCache: createRuntimeMemoryCache({ defaultTtlMs: 15_000 }),
      logger: {
        debug(context, message) {
          log.debug({ ...context }, `DEBUG [runtime-validation] ${message}`);
        },
        info(context, message) {
          log.info({ ...context }, `INFO [runtime-validation] ${message}`);
        },
        warn(context, message) {
          log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
        },
      },
    });
  }
  return modelDiscoveryService;
}

function parseRuntimeOptions(
  raw: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid runtime options JSON and continue with profile defaults
  }
  return undefined;
}

export interface RuntimeExecutionContext {
  project: ProjectRow;
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  selectionSource: "task_override" | "project_default" | "system_default" | "none";
}

export async function resolveApiRuntimeContext(input: {
  projectId?: string | null;
  taskId?: string | null;
  mode: "task" | "chat";
  workflow: RuntimeWorkflowSpec;
  modelOverride?: string | null;
  runtimeOptionsOverride?: Record<string, unknown> | null;
  allowDisabled?: boolean;
}): Promise<RuntimeExecutionContext> {
  const task = input.taskId ? findTaskById(input.taskId) : undefined;
  const projectId = input.projectId ?? task?.projectId;
  if (!projectId) {
    throw new Error("Project ID is required to resolve runtime context");
  }

  const project = findProjectById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const selection = resolveEffectiveRuntimeProfile({
    taskId: task?.id,
    projectId,
    mode: input.mode,
    systemDefaultRuntimeProfileId: null,
  });

  const profileRow = selection.profile?.id
    ? findRuntimeProfileById(selection.profile.id)
    : undefined;
  const profile = profileRow ? toRuntimeProfileResponse(profileRow) : selection.profile;
  const runtimeOptionsFromTask = parseRuntimeOptions(task?.runtimeOptionsJson);
  const resolvedProfile = resolveRuntimeProfile({
    source: selection.source,
    profile,
    fallbackRuntimeId: DEFAULT_RUNTIME_ID,
    fallbackProviderId: DEFAULT_PROVIDER_ID,
    workflow: input.workflow,
    modelOverride: input.modelOverride ?? task?.modelOverride ?? profile?.defaultModel ?? null,
    runtimeOptionsOverride: input.runtimeOptionsOverride ?? runtimeOptionsFromTask,
    allowDisabled: input.allowDisabled,
    env: process.env,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-resolution] ${message}`);
      },
      info(context, message) {
        log.info({ ...context }, `INFO [runtime-validation] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-validation] ${message}`);
      },
    },
  });

  const registry = await getApiRuntimeRegistry();
  const adapter = registry.resolveRuntime(resolvedProfile.runtimeId);

  log.info(
    {
      projectId,
      taskId: task?.id ?? null,
      workflowKind: input.workflow.workflowKind,
      selectionSource: selection.source,
      ...redactResolvedRuntimeProfile(resolvedProfile),
    },
    "Resolved API runtime context",
  );

  return {
    project,
    adapter,
    resolvedProfile,
    selectionSource: selection.source,
  };
}

export function assertApiRuntimeCapabilities(input: {
  adapter: RuntimeAdapter;
  resolvedProfile: ResolvedRuntimeProfile;
  workflow: RuntimeWorkflowSpec;
}): void {
  const result = checkRuntimeCapabilities({
    runtimeId: input.resolvedProfile.runtimeId,
    workflowKind: input.workflow.workflowKind,
    capabilities: input.adapter.descriptor.capabilities,
    required: input.workflow.requiredCapabilities,
    logger: {
      debug(context, message) {
        log.debug({ ...context }, `DEBUG [runtime-capabilities] ${message}`);
      },
      warn(context, message) {
        log.warn({ ...context }, `WARN [runtime-capabilities] ${message}`);
      },
    },
  });

  if (!result.ok) {
    throw new Error(
      `Runtime "${input.resolvedProfile.runtimeId}" cannot execute "${input.workflow.workflowKind}": ${result.missing.join(", ")}`,
    );
  }
}

export async function runApiRuntimeOneShot(input: {
  projectId: string;
  projectRoot: string;
  taskId?: string | null;
  prompt: string;
  workflowKind?: string;
  requiredCapabilities?: RuntimeCapabilityName[];
  modelOverride?: string | null;
  systemPromptAppend?: string;
  includePartialMessages?: boolean;
  maxTurns?: number;
}): Promise<{
  result: RuntimeRunResult;
  context: RuntimeExecutionContext;
}> {
  const workflow = createRuntimeWorkflowSpec({
    workflowKind: input.workflowKind ?? "oneshot",
    prompt: input.prompt,
    requiredCapabilities: input.requiredCapabilities ?? [],
    sessionReusePolicy: "never",
    systemPromptAppend: input.systemPromptAppend,
  });

  const context = await resolveApiRuntimeContext({
    projectId: input.projectId,
    taskId: input.taskId,
    mode: "task",
    workflow,
    modelOverride: input.modelOverride,
  });

  assertApiRuntimeCapabilities({
    adapter: context.adapter,
    resolvedProfile: context.resolvedProfile,
    workflow,
  });

  const bypassPermissions = getEnv().AGENT_BYPASS_PERMISSIONS;
  const result = await context.adapter.run({
    runtimeId: context.resolvedProfile.runtimeId,
    providerId: context.resolvedProfile.providerId,
    profileId: context.resolvedProfile.profileId,
    workflowKind: workflow.workflowKind,
    prompt: input.prompt,
    model: context.resolvedProfile.model ?? undefined,
    projectRoot: input.projectRoot,
    cwd: input.projectRoot,
    options: {
      ...context.resolvedProfile.options,
      ...(context.resolvedProfile.baseUrl ? { baseUrl: context.resolvedProfile.baseUrl } : {}),
      ...(context.resolvedProfile.apiKey ? { apiKey: context.resolvedProfile.apiKey } : {}),
      ...(context.resolvedProfile.apiKeyEnvVar
        ? { apiKeyEnvVar: context.resolvedProfile.apiKeyEnvVar }
        : {}),
    },
    metadata: {
      permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
      allowDangerouslySkipPermissions: bypassPermissions,
      settings: { attribution: { commit: "", pr: "" } },
      settingSources: ["project"],
      includePartialMessages: input.includePartialMessages ?? false,
      maxTurns: input.maxTurns,
      environment: input.taskId
        ? {
            HANDOFF_MODE: "1",
            HANDOFF_TASK_ID: input.taskId,
          }
        : {
            HANDOFF_MODE: "1",
          },
      systemPromptAppend: input.systemPromptAppend,
    },
  });

  log.info(
    {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workflowKind: workflow.workflowKind,
      runtimeId: context.resolvedProfile.runtimeId,
      profileId: context.resolvedProfile.profileId,
      providerId: context.resolvedProfile.providerId,
      model: context.resolvedProfile.model,
    },
    "INFO [api-runtime] One-shot runtime query completed",
  );

  return { result, context };
}
