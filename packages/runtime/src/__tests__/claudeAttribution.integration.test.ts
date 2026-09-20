import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntimeAdapter } from "../adapters/claude/index.js";
import {
  CLAUDE_MIN_VERSION,
  isVersionBelowMin,
  readBundledClaudeVersion,
} from "../adapters/claude/version.js";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

/**
 * Behavioral smoke test for the formerly-crashing `/chat` path — requested in
 * PR #162 review ("execute the real Handoff SDK adapter path ... with the
 * default suppression settings and confirm that the query starts and completes").
 *
 * It exercises the real adapter end to end (`createClaudeRuntimeAdapter().run`)
 * — `parseExecutionOptions` → version guard → `runClaudeRuntime` →
 * `buildClaudeQueryOptions` (which applies the default suppression
 * `settings.attribution = { commit: "", pr: "" }`) → Agent SDK `query` → stream.
 * A green result here proves the empty-attribution payload starts and completes
 * against the effective Claude Code binary, i.e. the HTTP 500 regression is gone.
 *
 * Gated: requires a real, authenticated `claude` on PATH AND
 * `AIF_CLAUDE_INTEGRATION=1`. CI does not satisfy this, so the main suite stays
 * hermetic. Run locally with:
 *   AIF_CLAUDE_INTEGRATION=1 npx vitest run claudeAttribution.integration.test.ts
 *
 * The previous version of this file asserted that a generated git commit lacked
 * a Co-Authored-By trailer. That assertion was non-discriminating: in the Agent
 * SDK + Bash-commit path the trailer is not injected regardless of attribution,
 * so the test passed identically for `{ attribution: { commit: "", pr: "" } }`,
 * `{}`, and no `settings` at all — it could not catch the regression. It is
 * replaced by this startup/completion smoke test, which directly observes the
 * failure mode (startup exit-code 1).
 */
const ENABLED = process.env.AIF_CLAUDE_INTEGRATION === "1";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe.skipIf(!ENABLED)("Claude runtime — default suppression settings (integration)", () => {
  it("starts and completes a run under the default empty-attribution settings", async () => {
    // The Claude Code binary the Agent SDK actually launches (its bundled
    // native binary, whose version is declared in the SDK manifest) must be
    // at/above the supported minimum — otherwise the version guard exercised
    // by adapter.run rejects the run before it starts, which is itself the
    // correct, non-opaque failure mode. Reading the manifest (not probing a
    // `claude` on PATH) keeps this pre-check aligned with what query() runs.
    const version = readBundledClaudeVersion();
    expect(
      version && !isVersionBelowMin(version),
      `Bundled Claude Code ${version?.raw ?? "unknown"} is below the supported minimum ${CLAUDE_MIN_VERSION}`,
    ).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "claude-attr-smoke-"));
    try {
      const adapter = createClaudeRuntimeAdapter({ logger: silentLogger });
      const input: RuntimeRunInput = {
        runtimeId: "claude",
        providerId: "anthropic",
        prompt: "Reply with exactly this and nothing else: OK",
        cwd,
        projectRoot: cwd,
        // No `execution.hooks.settings` override → buildClaudeQueryOptions
        // applies the default suppression { attribution: { commit: "", pr: "" } },
        // the exact payload that crashed older Claude Code builds at startup.
        execution: { hooks: { runTimeoutMs: 60_000 } },
        usageContext: TEST_USAGE_CONTEXT,
      };

      const result = await adapter.run(input);

      // Completed with output — the run started (did not exit with code 1) and
      // produced a result through the Agent SDK stream.
      expect(typeof result.outputText).toBe("string");
      expect((result.outputText ?? "").trim().length).toBeGreaterThan(0);
      const completed = (result.events ?? []).some((event) => event.type === "result:success");
      expect(completed).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});
