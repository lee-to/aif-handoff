import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { initProject } from "@aif/runtime";
import { findMonorepoRoot, validateProjectRootPath, logger } from "@aif/shared";
import type { CreateProjectInput, UpdateProjectOrganizationInput } from "@aif/shared";
import { getApiRuntimeRegistry } from "../services/runtime.js";
import {
  createProject as createProjectRecord,
  deleteProject as deleteProjectRecord,
  findProjectById,
  listProjectTaskOverviews,
  listProjects,
  type ProjectRow,
  updateProject as updateProjectRecord,
  updateProjectOrganization as updateProjectOrganizationRecord,
  upsertGitHubRepository,
} from "@aif/data";
import {
  cloneGitHubRepository,
  GitHubApiError,
  GitHubClient,
  GitHubCloneError,
  resolveGitHubToken,
  toGitHubErrorResponse,
} from "../services/github.js";

const log = logger("projects-repo");
const MONOREPO_ROOT = findMonorepoRoot(import.meta.dirname);

function readContainerProjectsMount(): string {
  const configured = process.env.PROJECTS_MOUNT?.trim();
  return configured && posix.isAbsolute(configured) ? posix.resolve(configured) : "/home/www";
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\");
}

function isWithinPosixPath(basePath: string, candidatePath: string): boolean {
  const rel = posix.relative(basePath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel));
}

function resolveHostProjectsDir(hostProjectsDir: string): string {
  if (isAbsolute(hostProjectsDir)) return resolve(hostProjectsDir);

  const hostRoot = process.env.PROJECTS_HOST_ROOT?.trim();
  return hostRoot && isAbsolute(hostRoot)
    ? resolve(hostRoot, hostProjectsDir)
    : resolve(MONOREPO_ROOT, hostProjectsDir);
}

function mapProjectPathToContainer(rootPath: string): string {
  const hostProjectsDir = process.env.PROJECTS_DIR?.trim();
  const containerProjectsMount = readContainerProjectsMount();

  if (hostProjectsDir) {
    const resolvedRootPath = resolve(rootPath);
    const resolvedHostProjectsDir = resolveHostProjectsDir(hostProjectsDir);

    if (isWithinPath(resolvedHostProjectsDir, resolvedRootPath)) {
      const rel = relative(resolvedHostProjectsDir, resolvedRootPath);
      return rel
        ? posix.join(containerProjectsMount, rel.split(sep).join(posix.sep))
        : containerProjectsMount;
    }

    if (win32.isAbsolute(hostProjectsDir) && win32.isAbsolute(rootPath)) {
      const windowsHostProjectsDir = win32.resolve(normalizeWindowsPath(hostProjectsDir));
      const windowsRootPath = win32.resolve(normalizeWindowsPath(rootPath));
      const rel = win32.relative(windowsHostProjectsDir, windowsRootPath);
      if (rel === "" || (rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel))) {
        return rel
          ? posix.join(containerProjectsMount, rel.split("\\").join(posix.sep))
          : containerProjectsMount;
      }
    }
  }

  const configuredProjectsMount = process.env.PROJECTS_MOUNT?.trim();
  if (
    !configuredProjectsMount ||
    !posix.isAbsolute(configuredProjectsMount) ||
    !posix.isAbsolute(rootPath)
  ) {
    return rootPath;
  }

  const normalizedRootPath = posix.resolve(rootPath);
  if (isWithinPosixPath(containerProjectsMount, normalizedRootPath)) {
    return normalizedRootPath;
  }

  return posix.join(containerProjectsMount, normalizedRootPath.slice(1));
}

type ProjectCreationStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

export type ProjectCreationResult =
  | { ok: true; project: ProjectRow }
  | {
      ok: false;
      status: ProjectCreationStatus;
      error: string;
      code?: string;
      retryAt?: string | null;
    };

function projectRecordInput(input: CreateProjectInput, rootPath: string) {
  return {
    name: input.name,
    rootPath,
    plannerMaxBudgetUsd: input.plannerMaxBudgetUsd,
    planCheckerMaxBudgetUsd: input.planCheckerMaxBudgetUsd,
    implementerMaxBudgetUsd: input.implementerMaxBudgetUsd,
    reviewSidecarMaxBudgetUsd: input.reviewSidecarMaxBudgetUsd,
    parallelEnabled: input.parallelEnabled,
    defaultTaskRuntimeProfileId: input.defaultTaskRuntimeProfileId,
    defaultPlanRuntimeProfileId: input.defaultPlanRuntimeProfileId,
    defaultReviewRuntimeProfileId: input.defaultReviewRuntimeProfileId,
    defaultChatRuntimeProfileId: input.defaultChatRuntimeProfileId,
  };
}

function initFailure(error: string): ProjectCreationResult {
  return { ok: false, status: 500, error };
}

async function initializeProject(project: ProjectRow): Promise<ProjectCreationResult> {
  try {
    const registry = await getApiRuntimeRegistry();
    const result = initProject({ projectRoot: project.rootPath, registry });
    if (result.ok) return { ok: true, project };
    log.error(
      { projectId: project.id, rootPath: project.rootPath, error: result.error },
      "Project init failed, rolling back project record",
    );
    return initFailure(result.error ?? "Project initialization failed");
  } catch (error) {
    log.error(
      { projectId: project.id, rootPath: project.rootPath, err: error },
      "Project init failed, rolling back project record",
    );
    return initFailure(
      `Project initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveManagedProjectsRoot(): string {
  const projectsMount = process.env.PROJECTS_MOUNT?.trim();
  if (projectsMount && isAbsolute(projectsMount)) return resolve(projectsMount);
  const projectsDir = process.env.PROJECTS_DIR?.trim();
  return projectsDir ? resolveHostProjectsDir(projectsDir) : resolve(MONOREPO_ROOT, "projects");
}

function isSafePathSegment(value: string): boolean {
  return (
    value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")
  );
}

function filesystemErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function cleanupManagedClone(destination: string, projectId?: string): void {
  log.warn({ projectId, destination }, "Rolling back managed GitHub clone");
  try {
    rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    log.warn(
      { projectId, destination, errorCode: filesystemErrorCode(error) },
      "Managed GitHub clone cleanup failed",
    );
  }
}

async function createPathProject(input: CreateProjectInput & { rootPath: string }) {
  const rootPath = mapProjectPathToContainer(input.rootPath);
  const pathError = validateProjectRootPath(rootPath);
  if (pathError) return { ok: false, status: 400, error: pathError } as const;

  const project = createProjectRecord(projectRecordInput(input, rootPath));
  if (!project) return { ok: false, status: 500, error: "Failed to create project" } as const;
  const result = await initializeProject(project);
  if (!result.ok) deleteProjectRecord(project.id);
  return result;
}

async function createGitHubProject(
  input: CreateProjectInput & { githubRepository: string },
): Promise<ProjectCreationResult> {
  const [requestedOwner, requestedRepository] = input.githubRepository.split("/") as [
    string,
    string,
  ];
  let token: string;
  let remote;
  try {
    token = resolveGitHubToken("GITHUB_TOKEN");
    log.debug(
      { owner: requestedOwner, repository: requestedRepository },
      "Validating GitHub project source",
    );
    remote = await new GitHubClient(token).getRepository(requestedOwner, requestedRepository);
  } catch (error) {
    if (!(error instanceof GitHubApiError)) {
      log.error({ err: error }, "Unexpected GitHub project source validation failure");
      return {
        ok: false,
        status: 502,
        error: "GitHub integration failed",
        code: "github_upstream",
      };
    }
    const response = toGitHubErrorResponse(error);
    return { ok: false, status: response.status, ...response.body };
  }

  const owner = remote.owner.login;
  const repository = remote.name;
  if (!isSafePathSegment(owner) || !isSafePathSegment(repository)) {
    log.error({ owner, repository }, "GitHub API returned unsafe repository path segments");
    return { ok: false, status: 502, error: "GitHub integration failed", code: "github_upstream" };
  }

  const managedRoot = resolveManagedProjectsRoot();
  const parent = resolve(managedRoot, "github", owner);
  const destination = resolve(parent, repository);
  const pathError = validateProjectRootPath(destination);
  if (pathError) return { ok: false, status: 400, error: pathError };

  try {
    mkdirSync(parent, { recursive: true });
    const realRoot = realpathSync(managedRoot);
    const realParent = realpathSync(parent);
    if (!isWithinPath(realRoot, realParent)) {
      log.error({ managedRoot, parent }, "GitHub clone parent escaped managed project root");
      return {
        ok: false,
        status: 502,
        error: "GitHub integration failed",
        code: "github_upstream",
      };
    }
    mkdirSync(destination);
  } catch (error) {
    const errorCode = filesystemErrorCode(error);
    if (errorCode === "EEXIST") {
      log.warn({ owner, repository, destination }, "GitHub clone destination already exists");
      return {
        ok: false,
        status: 409,
        error: "GitHub clone destination already exists",
        code: "github_clone_conflict",
      };
    }
    log.error(
      { owner, repository, destination, errorCode },
      "GitHub clone destination reservation failed",
    );
    return {
      ok: false,
      status: 502,
      error: "GitHub repository clone failed",
      code: "github_clone_failed",
    };
  }

  let project: ProjectRow | undefined;
  try {
    await cloneGitHubRepository({ owner, repository, destination, token });
    project = createProjectRecord(projectRecordInput(input, destination));
    if (!project) throw new Error("Project record was not created");
    upsertGitHubRepository({
      projectId: project.id,
      owner,
      name: repository,
      htmlUrl: remote.html_url,
      defaultBranch: remote.default_branch,
      tokenEnvVar: "GITHUB_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const result = await initializeProject(project);
    if (!result.ok) {
      deleteProjectRecord(project.id);
      cleanupManagedClone(destination, project.id);
      return result;
    }
    log.info(
      { projectId: project.id, owner, repository, rootPath: destination },
      "GitHub-backed project creation completed",
    );
    return result;
  } catch (error) {
    if (project) deleteProjectRecord(project.id);
    cleanupManagedClone(destination, project?.id);
    if (error instanceof GitHubCloneError) {
      return {
        ok: false,
        status: 502,
        error: error.message,
        code: "github_clone_failed",
      };
    }
    log.error(
      { projectId: project?.id, owner, repository, destination, err: error },
      "GitHub-backed project persistence failed",
    );
    return { ok: false, status: 500, error: "Failed to create project" };
  }
}

export async function createProject(input: CreateProjectInput): Promise<ProjectCreationResult> {
  log.debug(
    { sourceKind: input.rootPath === undefined ? "github" : "path", name: input.name },
    "Project creation started",
  );
  return input.rootPath === undefined
    ? createGitHubProject(input as CreateProjectInput & { githubRepository: string })
    : createPathProject(input as CreateProjectInput & { rootPath: string });
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
  const normalizedInput = { ...input, rootPath: mapProjectPathToContainer(input.rootPath) };
  const pathError = validateProjectRootPath(normalizedInput.rootPath);
  if (pathError) return { project: undefined, pathError };

  return { project: updateProjectRecord(id, normalizedInput) };
}

export function deleteProject(id: string): void {
  deleteProjectRecord(id);
}

export function updateProjectOrganization(
  id: string,
  input: UpdateProjectOrganizationInput,
): ProjectRow | undefined {
  return updateProjectOrganizationRecord(id, input);
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

export { listProjects, listProjectTaskOverviews, findProjectById };
