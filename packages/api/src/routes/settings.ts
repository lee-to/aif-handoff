import { Hono } from "hono";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  findProjectById,
  getAppDefaultRuntimeProfileId,
  getAppSettings,
  listRuntimeProfiles,
  updateAppSettings,
} from "@aif/data";
import {
  logger,
  findMonorepoRoot,
  getEnv,
  clearProjectConfigCache,
  parseMcpPortSetting,
} from "@aif/shared";
import type { RuntimeMcpInstallInput } from "@aif/runtime";
import { updateAppRuntimeDefaultsSchema } from "../schemas.js";
import { jsonValidator } from "../middleware/zodValidator.js";
import { getApiRuntimeRegistry } from "../services/runtime.js";
import { validateAppRuntimeDefaultSelections } from "../services/runtimeProfileScope.js";

const log = logger("api:settings");

const MCP_SERVER_NAME = "handoff";
const MONOREPO_ROOT = findMonorepoRoot(import.meta.dirname);

function buildMcpServerEntry(): RuntimeMcpInstallInput {
  const env = getEnv();
  const parsedPort = parseMcpPortSetting(process.env.MCP_PORT);

  if (parsedPort.status === "valid") {
    return {
      serverName: MCP_SERVER_NAME,
      transport: "streamable_http",
      url: `http://localhost:${parsedPort.value}/mcp`,
    };
  }

  return {
    serverName: MCP_SERVER_NAME,
    transport: "stdio",
    command: "npx",
    args: ["tsx", join(MONOREPO_ROOT, "packages/mcp/src/index.ts")],
    cwd: MONOREPO_ROOT,
    env: {
      MCP_TRANSPORT: "stdio",
      DATABASE_URL: join(MONOREPO_ROOT, env.DATABASE_URL),
      PROJECTS_DIR: join(MONOREPO_ROOT, process.env.PROJECTS_DIR || ".projects"),
      LOG_LEVEL: "info",
      LOG_DESTINATION: "stderr",
    },
  };
}

function resolveConfigPath(projectId: string | undefined): string | null {
  if (!projectId) return null;
  const project = findProjectById(projectId);
  if (!project) return null;
  return join(project.rootPath, ".ai-factory", "config.yaml");
}

export function buildAppRuntimeDefaultsResponse() {
  const settings = getAppSettings();
  return {
    defaultTaskRuntimeProfileId: settings.defaultTaskRuntimeProfileId,
    defaultPlanRuntimeProfileId: settings.defaultPlanRuntimeProfileId,
    defaultReviewRuntimeProfileId: settings.defaultReviewRuntimeProfileId,
    defaultChatRuntimeProfileId: settings.defaultChatRuntimeProfileId,
    resolvedDefaultTaskRuntimeProfileId: getAppDefaultRuntimeProfileId("task"),
    resolvedDefaultPlanRuntimeProfileId: getAppDefaultRuntimeProfileId("plan"),
    resolvedDefaultReviewRuntimeProfileId: getAppDefaultRuntimeProfileId("review"),
    resolvedDefaultChatRuntimeProfileId: getAppDefaultRuntimeProfileId("chat"),
  };
}

export async function buildSettingsOverview() {
  const env = getEnv();
  const appRuntimeDefaults = buildAppRuntimeDefaultsResponse();

  try {
    const registry = await getApiRuntimeRegistry();
    const runtimeProfiles = listRuntimeProfiles();
    const enabledProfiles = runtimeProfiles.filter((profile) => profile.enabled);
    return {
      useSubagents: env.AGENT_USE_SUBAGENTS,
      maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
      autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
      usageLimitsEnabled: env.AIF_USAGE_LIMITS_ENABLED,
      runtimeReadiness: {
        availableRuntimeCount: registry.listRuntimes().length,
        runtimeProfileCount: runtimeProfiles.length,
        enabledRuntimeProfileCount: enabledProfiles.length,
      },
      runtimeDefaults: {
        modules: env.AIF_RUNTIME_MODULES,
        openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
        codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        app: appRuntimeDefaults,
      },
    };
  } catch (error) {
    log.error({ error }, "Failed to include runtime settings payload");
    const allProfiles = listRuntimeProfiles();
    const enabledProfiles = listRuntimeProfiles({ enabledOnly: true });
    return {
      useSubagents: env.AGENT_USE_SUBAGENTS,
      maxReviewIterations: env.AGENT_MAX_REVIEW_ITERATIONS,
      autoReviewStrategy: env.AGENT_AUTO_REVIEW_STRATEGY,
      usageLimitsEnabled: env.AIF_USAGE_LIMITS_ENABLED,
      runtimeReadiness: {
        availableRuntimeCount: 0,
        runtimeProfileCount: allProfiles.length,
        enabledRuntimeProfileCount: enabledProfiles.length,
      },
      runtimeDefaults: {
        modules: env.AIF_RUNTIME_MODULES,
        openAiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
        codexCliPathConfigured: Boolean(env.CODEX_CLI_PATH),
        app: appRuntimeDefaults,
      },
    };
  }
}

export const settingsRoutes = new Hono();

settingsRoutes.get("/runtime-defaults", (c) => {
  return c.json(buildAppRuntimeDefaultsResponse());
});

settingsRoutes.put("/runtime-defaults", jsonValidator(updateAppRuntimeDefaultsSchema), (c) => {
  const body = c.req.valid("json");
  log.debug({ body }, "DEBUG [settings] Runtime defaults update requested");

  const validation = validateAppRuntimeDefaultSelections(body);
  if (validation) {
    log.warn({ fieldErrors: validation.fieldErrors }, "Rejected invalid app runtime defaults");
    return c.json(validation, 400);
  }

  updateAppSettings(body);
  const response = buildAppRuntimeDefaultsResponse();
  log.info({ runtimeDefaults: response }, "Updated app runtime defaults");
  return c.json(response);
});

/** Get MCP server status across all registered runtimes */
settingsRoutes.get("/mcp", async (c) => {
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();
  const statuses: Array<{ runtimeId: string; installed: boolean; config?: unknown }> = [];

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    if (!adapter?.getMcpStatus) continue;
    try {
      const status = await adapter.getMcpStatus({ serverName: MCP_SERVER_NAME });
      statuses.push({
        runtimeId: descriptor.id,
        installed: status.installed,
        config: status.config,
      });
    } catch (err) {
      log.warn({ runtimeId: descriptor.id, err }, "Failed to check MCP status");
      statuses.push({ runtimeId: descriptor.id, installed: false });
    }
  }

  const anyInstalled = statuses.some((s) => s.installed);
  return c.json({
    installed: anyInstalled,
    serverName: MCP_SERVER_NAME,
    runtimes: statuses,
  });
});

/** Install MCP server into all registered runtimes that support it */
settingsRoutes.post("/mcp/install", async (c) => {
  const entry = buildMcpServerEntry();
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();
  const results: Array<{ runtimeId: string; success: boolean; error?: string }> = [];

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    if (!adapter?.installMcpServer) continue;
    try {
      await adapter.installMcpServer(entry);
      log.info(
        { runtimeId: descriptor.id, transport: entry.transport ?? "stdio" },
        "MCP server installed",
      );
      results.push({ runtimeId: descriptor.id, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ runtimeId: descriptor.id, err }, "Failed to install MCP server");
      results.push({ runtimeId: descriptor.id, success: false, error: message });
    }
  }

  return c.json({
    success: results.every((r) => r.success),
    serverName: MCP_SERVER_NAME,
    runtimes: results,
  });
});

/** Remove MCP server from all registered runtimes */
settingsRoutes.delete("/mcp", async (c) => {
  const registry = await getApiRuntimeRegistry();
  const runtimes = registry.listRuntimes();

  for (const descriptor of runtimes) {
    const adapter = registry.tryResolveRuntime(descriptor.id);
    if (!adapter?.uninstallMcpServer) continue;
    try {
      await adapter.uninstallMcpServer({ serverName: MCP_SERVER_NAME });
      log.info({ runtimeId: descriptor.id }, "MCP server removed");
    } catch (err) {
      log.error({ runtimeId: descriptor.id, err }, "Failed to remove MCP server");
    }
  }

  return c.json({ success: true });
});

/** Check if .ai-factory/config.yaml exists for a project */
settingsRoutes.get("/config/status", (c) => {
  const configPath = resolveConfigPath(c.req.query("projectId"));
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  return c.json({ exists: existsSync(configPath), path: configPath });
});

/** Read .ai-factory/config.yaml for a project */
settingsRoutes.get("/config", async (c) => {
  const configPath = resolveConfigPath(c.req.query("projectId"));
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  if (!existsSync(configPath)) {
    return c.json({ error: "config.yaml not found" }, 404);
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    const config = YAML.parse(raw) as Record<string, unknown>;
    return c.json({ config });
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to read config.yaml",
    );
    return c.json({ error: "Failed to read config.yaml" }, 500);
  }
});

/** Write .ai-factory/config.yaml for a project */
settingsRoutes.put("/config", async (c) => {
  const projectId = c.req.query("projectId");
  const configPath = resolveConfigPath(projectId);
  if (!configPath) {
    return c.json({ error: "projectId is required" }, 400);
  }
  try {
    const { config } = await c.req.json<{ config: Record<string, unknown> }>();
    if (!config || typeof config !== "object") {
      return c.json({ error: "config must be an object" }, 400);
    }
    const yaml = YAML.stringify(config, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "PLAIN",
    });
    await writeFile(configPath, yaml, "utf-8");
    const project = findProjectById(projectId!);
    if (project) clearProjectConfigCache(project.rootPath);
    log.info({ projectId }, "config.yaml updated");
    return c.json({ success: true });
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to write config.yaml",
    );
    return c.json({ error: "Failed to write config.yaml" }, 500);
  }
});
