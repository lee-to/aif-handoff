import { describe, expect, it } from "vitest";
import type { RuntimeRunInput } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";
import {
  buildClaudeQueryOptions,
  type ClaudeRuntimeExecutionOptions,
} from "../adapters/claude/options.js";

const baseInput: RuntimeRunInput = {
  runtimeId: "claude",
  providerId: "anthropic",
  prompt: "say OK",
  projectRoot: "/tmp/project",
  cwd: "/tmp/project",
  usageContext: TEST_USAGE_CONTEXT,
};

describe("buildClaudeQueryOptions — settings forwarding", () => {
  it("defaults to attribution suppression when settings is undefined", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      // settings intentionally omitted
    } satisfies ClaudeRuntimeExecutionOptions);

    // Empty commit/pr are the documented Claude Code mechanism to hide the
    // Co-Authored-By trailers; they are the default suppression request.
    expect(options.settings).toEqual({ attribution: { commit: "", pr: "" } });
  });

  it("forwards empty-string attribution unchanged (suppression contract)", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: { attribution: { commit: "", pr: "" } },
    } satisfies ClaudeRuntimeExecutionOptions);

    // Must pass through verbatim — collapsing to {} would restore Claude Code's
    // default attribution (see ClaudeSdkSettings docs).
    expect(options.settings).toEqual({ attribution: { commit: "", pr: "" } });
  });

  it("forwards non-empty attribution unchanged", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: { attribution: { commit: "commit-trailer", pr: "pr-trailer" } },
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(options.settings).toEqual({
      attribution: { commit: "commit-trailer", pr: "pr-trailer" },
    });
  });

  it("preserves unrelated Claude settings alongside attribution", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      settings: {
        attribution: { commit: "", pr: "" },
        outputStyle: "technical",
      },
    } satisfies ClaudeRuntimeExecutionOptions);

    // Non-attribution keys (outputStyle, sandbox, permissions, …) must survive
    // — `settings` is an extensible bag, not an attribution-only object.
    expect(options.settings).toEqual({
      attribution: { commit: "", pr: "" },
      outputStyle: "technical",
    });
  });
});

describe("buildClaudeQueryOptions — executable selection (guard invariant)", () => {
  // The version guard must inspect the same binary `query()` launches
  // (probed === launched). With no explicit override the SDK runs its bundled
  // binary, so the option must be absent and the guard reads the SDK manifest;
  // with an explicit override the same path is both probed and forwarded.
  it("omits pathToClaudeCodeExecutable when none is configured (SDK uses bundled binary)", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      pathToClaudeCodeExecutable: undefined,
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(Object.prototype.hasOwnProperty.call(options, "pathToClaudeCodeExecutable")).toBe(false);
  });

  it("forwards an explicit pathToClaudeCodeExecutable so the guard and query() share it", () => {
    const options = buildClaudeQueryOptions(baseInput, {
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    } satisfies ClaudeRuntimeExecutionOptions);

    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });
});
