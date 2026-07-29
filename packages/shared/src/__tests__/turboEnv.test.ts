import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function readRepoText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("Turbo environment passthrough", () => {
  it("passes documented AIF feature flags through Turbo-managed tasks", () => {
    const docs = readRepoText("docs/configuration.md");
    const turbo = JSON.parse(readRepoText("turbo.json")) as {
      globalPassThroughEnv?: string[];
    };
    const passThrough = new Set(turbo.globalPassThroughEnv ?? []);
    const hasAifWildcard = passThrough.has("AIF_*");
    const documentedFeatureFlags = [...new Set(docs.match(/AIF_[A-Z0-9_]+_ENABLED/g) ?? [])].sort();

    expect(documentedFeatureFlags).toEqual([
      "AIF_AGENT_AUTO_QUEUE_COMMIT_GATE_ENABLED",
      "AIF_API_NODE_SERVER_V2_WEBSOCKET_ENABLED",
      "AIF_QA_PIPELINE_ENABLED",
      "AIF_RUNTIME_CODEX_NATIVE_SUBAGENTS_ENABLED",
      "AIF_RUNTIME_MODEL_EFFORT_DISCOVERY_ENABLED",
      "AIF_RUNTIME_OPENCODE_LONG_RUNNING_DISPATCHER_ENABLED",
      "AIF_RUNTIME_SESSION_FORK_ENABLED",
      "AIF_STAGE_RUNTIME_PIN_ENABLED",
      "AIF_TASK_WORKTREES_ENABLED",
      "AIF_USAGE_LIMITS_ENABLED",
      "AIF_WARMUP_ENABLED",
    ]);

    if (!hasAifWildcard) {
      for (const flag of documentedFeatureFlags) {
        expect(passThrough.has(flag), `${flag} is missing from turbo.json`).toBe(true);
      }
    }
  });
});
