import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTaskById, updateTask } from "@aif/data";
import { createRuntimeWorkflowSpec, RuntimeExecutionError, UsageSource } from "@aif/runtime";
import { getEnv, logger } from "@aif/shared";
import { toTaskBroadcastPayload } from "../repositories/tasks.js";
import { broadcast } from "../ws.js";
import { resolveQaArtifactDir } from "./qaRunner.js";
import { resolveApiRuntimeContext, runApiRuntimeOneShot } from "./runtime.js";

const log = logger("qa-check-runner");
const PLAYWRIGHT_MCP_SERVER_NAME = "playwright";

export interface RunQaCheckQueryInput {
  projectId: string;
  taskId: string;
  executionRoot: string;
}

export interface RunQaCheckQueryResult {
  ok: boolean;
  error?: string;
  code?: "ai_handoff_required" | "qa_test_cases_required";
}

export interface PlaywrightMcpPreflight {
  configured: boolean | null;
  runtimeId: string | null;
  transport: string | null;
}

function readArtifact(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function broadcastTaskUpdate(taskId: string): void {
  const task = findTaskById(taskId);
  if (task) {
    broadcast({ type: "task:updated", payload: toTaskBroadcastPayload(task) });
  }
}

function persistQaCheckError(taskId: string, error: string): RunQaCheckQueryResult {
  try {
    updateTask(taskId, { qaCheckStatus: "error" });
    broadcastTaskUpdate(taskId);
  } catch (persistError) {
    log.error({ persistError, taskId }, "Failed to persist QA Check error status");
  }
  return { ok: false, error };
}

/**
 * Static runtime preflight. `getMcpStatus` reports configured MCP state, so this
 * is advisory; the executing agent still inspects its actual tools. In
 * particular, Codex app-server is not treated as the ChatGPT desktop Browser.
 */
export async function checkPlaywrightMcp(
  input: RunQaCheckQueryInput,
): Promise<PlaywrightMcpPreflight> {
  try {
    const workflow = createRuntimeWorkflowSpec({
      workflowKind: "qa-check",
      prompt: "",
      fallbackSlashCommand: "/aif-qa-check agent",
      sessionReusePolicy: "never",
    });
    const context = await resolveApiRuntimeContext({
      projectId: input.projectId,
      taskId: input.taskId,
      mode: "task",
      workflow,
    });
    const runtimeId = context.resolvedProfile.runtimeId;
    const transport = context.resolvedProfile.transport;
    if (!context.adapter.getMcpStatus) {
      log.debug(
        { taskId: input.taskId, runtimeId, transport },
        "Playwright MCP preflight is unsupported by the runtime adapter",
      );
      return { configured: null, runtimeId, transport };
    }
    const status = await context.adapter.getMcpStatus({ serverName: PLAYWRIGHT_MCP_SERVER_NAME });
    log.info(
      { taskId: input.taskId, runtimeId, transport, installed: status.installed },
      "Playwright MCP preflight completed",
    );
    return { configured: status.installed, runtimeId, transport };
  } catch (error) {
    log.warn({ error, taskId: input.taskId }, "Playwright MCP preflight failed");
    return { configured: null, runtimeId: null, transport: null };
  }
}

export function buildQaCheckPrompt(input: {
  testCasesPath: string;
  reportPath: string;
  playwrightMcp: PlaywrightMcpPreflight;
}): string {
  const preflight =
    input.playwrightMcp.configured === true
      ? "configured"
      : input.playwrightMcp.configured === false
        ? "not configured"
        : "unknown";
  return [
    "/aif-qa-check agent",
    "",
    "Run the workflow in automated agent mode using the ready test cases at:",
    input.testCasesPath,
    "",
    `Write the final qa-check.md report to this EXACT absolute path: ${input.reportPath}`,
    "",
    `Playwright MCP configuration preflight: ${preflight}.`,
    "Treat this result as advisory and inspect the tools actually available in this runtime.",
    "Do not infer a built-in browser from the Codex app-server transport.",
    "If browser automation is unavailable, mark only browser-ui and browser-dependent hybrid",
    "cases Blocked with a concrete reason. Continue every CLI, backend-test, API, file/docs,",
    "database-read, and other non-browser case.",
    "",
    "This Handoff run is non-interactive. Do not ask questions. Search project docs, fixtures,",
    "agent context, and test configuration first; if required context is still unavailable,",
    "mark only the affected case Blocked and continue. Never perform production, destructive,",
    "or otherwise side-effectful actions without explicit authorization in the test case.",
    "Do not modify source code. Record concrete evidence for every Pass, Fail, or Blocked result.",
  ].join("\n");
}

/** Execute ready aif-qa test cases and persist qa-check.md. Never throws. */
export async function runQaCheckQuery(input: RunQaCheckQueryInput): Promise<RunQaCheckQueryResult> {
  const { projectId, taskId, executionRoot } = input;
  const task = findTaskById(taskId);
  if (!task) {
    const error = `Task not found: ${taskId}`;
    log.error({ projectId, taskId }, error);
    return { ok: false, error };
  }
  if (task.executionOwner === "human") {
    return {
      ...persistQaCheckError(taskId, "The task must be handed to AI before QA Check can run"),
      code: "ai_handoff_required",
    };
  }
  if (!task.qaTestCases?.trim()) {
    return {
      ...persistQaCheckError(taskId, "Run QA first to generate test cases"),
      code: "qa_test_cases_required",
    };
  }

  try {
    const { artifactDir, branch, branchSlug } = resolveQaArtifactDir(
      task.branchName,
      executionRoot,
    );
    const testCasesPath = join(artifactDir, "test-cases.md");
    const reportPath = join(artifactDir, "qa-check.md");
    mkdirSync(artifactDir, { recursive: true });
    if (!existsSync(testCasesPath)) {
      writeFileSync(testCasesPath, task.qaTestCases, "utf-8");
      log.info({ taskId, testCasesPath }, "Restored missing QA test-cases artifact from task");
    }

    const playwrightMcp = await checkPlaywrightMcp(input);
    updateTask(taskId, { qaCheckPlaywrightConfigured: playwrightMcp.configured });
    broadcastTaskUpdate(taskId);
    rmSync(reportPath, { force: true });

    log.info(
      {
        taskId,
        branch,
        branchSlug,
        artifactDir,
        playwrightConfigured: playwrightMcp.configured,
        runtimeId: playwrightMcp.runtimeId,
        transport: playwrightMcp.transport,
      },
      "Starting QA Check run",
    );

    const executionBoundaryTask = findTaskById(taskId);
    if (!executionBoundaryTask || executionBoundaryTask.executionOwner === "human") {
      return persistQaCheckError(taskId, "The task must be handed to AI before QA Check can run");
    }

    const { result } = await runApiRuntimeOneShot({
      projectId,
      projectRoot: executionRoot,
      taskId,
      prompt: buildQaCheckPrompt({ testCasesPath, reportPath, playwrightMcp }),
      workflowKind: "qa-check",
      fallbackSlashCommand: "/aif-qa-check agent",
      runTimeoutMs: getEnv().AGENT_STAGE_RUN_TIMEOUT_MS,
      usageContext: { source: UsageSource.QA },
    });

    log.info(
      { taskId, reportPath, outputPreview: result.outputText?.slice(0, 200) ?? "" },
      "Reading QA Check report",
    );
    const qaCheckReport = readArtifact(reportPath);
    if (!qaCheckReport?.trim()) {
      return persistQaCheckError(taskId, "QA Check did not produce qa-check.md");
    }

    updateTask(taskId, {
      qaCheckStatus: "done",
      qaCheckReport,
      qaCheckPlaywrightConfigured: playwrightMcp.configured,
    });
    broadcastTaskUpdate(taskId);
    log.info({ taskId }, "QA Check completed");
    return { ok: true };
  } catch (error) {
    const category = error instanceof RuntimeExecutionError ? error.category : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    log.error({ error, taskId, projectId, category }, "QA Check failed");
    return persistQaCheckError(taskId, message);
  }
}
