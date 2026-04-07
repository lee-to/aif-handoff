import { logger } from "@aif/shared";
import { findProjectById } from "@aif/data";
import { runApiRuntimeOneShot } from "./runtime.js";

const log = logger("commit-generation");

const PROJECT_SCOPE_APPEND =
  "Project scope rule: work strictly inside the current working directory (project root). " +
  "Do not inspect or modify files in the orchestrator monorepo or in parent/sibling directories " +
  "unless the user explicitly asks for that path. Avoid broad discovery outside the current project root.";

/**
 * Fire-and-forget: run `/aif-commit` via shared runtime in the project root.
 * Logs errors but never throws — caller should not await or depend on success.
 */
export async function runCommitQuery(projectId: string): Promise<void> {
  const project = findProjectById(projectId);
  if (!project) {
    log.error({ projectId }, "Project not found for commit generation");
    return;
  }

  log.info(
    { projectId, projectRoot: project.rootPath },
    "Starting /aif-commit via runtime adapter",
  );

  try {
    await runApiRuntimeOneShot({
      projectId,
      projectRoot: project.rootPath,
      prompt: "/aif-commit",
      workflowKind: "commit",
      systemPromptAppend: PROJECT_SCOPE_APPEND,
    });
    log.info({ projectId }, "/aif-commit completed successfully");
  } catch (err) {
    log.error({ err, projectId }, "/aif-commit runtime error");
  }
}
