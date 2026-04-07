import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initProject } from "@aif/runtime";
import { validateProjectRootPath, logger } from "@aif/shared";
import { getApiRuntimeRegistry } from "../services/runtime.js";
import {
  createProject as createProjectRecord,
  deleteProject as deleteProjectRecord,
  findProjectById,
  listProjects,
  type ProjectRow,
  updateProject as updateProjectRecord,
} from "@aif/data";

const log = logger("projects-repo");

export function createProject(input: {
  name: string;
  rootPath: string;
  plannerMaxBudgetUsd?: number | null;
  planCheckerMaxBudgetUsd?: number | null;
  implementerMaxBudgetUsd?: number | null;
  reviewSidecarMaxBudgetUsd?: number | null;
  parallelEnabled?: boolean;
  defaultTaskRuntimeProfileId?: string | null;
  defaultChatRuntimeProfileId?: string | null;
}): { project: ProjectRow | undefined; pathError?: string } {
  const pathError = validateProjectRootPath(input.rootPath);
  if (pathError) return { project: undefined, pathError };

  const project = createProjectRecord(input);

  try {
    getApiRuntimeRegistry()
      .then((registry) => {
        initProject({ projectRoot: input.rootPath, registry });
      })
      .catch((err) => {
        log.warn(
          { rootPath: input.rootPath, err },
          "Runtime registry unavailable, project init skipped",
        );
      });
  } catch (err) {
    log.warn(
      { projectId: project?.id, rootPath: input.rootPath, err },
      "Project directory initialization failed",
    );
  }

  return { project };
}

export function updateProject(
  id: string,
  input: {
    name: string;
    rootPath: string;
    plannerMaxBudgetUsd?: number | null;
    planCheckerMaxBudgetUsd?: number | null;
    implementerMaxBudgetUsd?: number | null;
    reviewSidecarMaxBudgetUsd?: number | null;
    parallelEnabled?: boolean;
    defaultTaskRuntimeProfileId?: string | null;
    defaultPlanRuntimeProfileId?: string | null;
    defaultReviewRuntimeProfileId?: string | null;
    defaultChatRuntimeProfileId?: string | null;
  },
): { project: ProjectRow | undefined; pathError?: string } {
  const pathError = validateProjectRootPath(input.rootPath);
  if (pathError) return { project: undefined, pathError };

  return { project: updateProjectRecord(id, input) };
}

export function deleteProject(id: string): void {
  deleteProjectRecord(id);
}

export function getProjectMcpServers(projectId: string): Record<string, unknown> {
  const project = findProjectById(projectId);
  if (!project) return {};

  const mcpPath = resolve(project.rootPath, ".mcp.json");
  if (!existsSync(mcpPath)) return {};

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export { listProjects, findProjectById };
