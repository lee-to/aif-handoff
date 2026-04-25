import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several agent tests do real git operations on tmp work-trees (init,
    // checkout, commit). Under parallel vitest workers the default 5s
    // timeout flakes — bump to 20s globally; deterministic non-git tests
    // still finish in <100ms, so the larger budget only kicks in on the
    // slow path.
    testTimeout: 20_000,
    server: {
      deps: {
        inline: ["@aif/runtime", "@anthropic-ai/claude-agent-sdk"],
      },
    },
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/hooks.ts",
        "src/subagents/**",
        "src/queryAudit.ts",
        "src/wakeChannel.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
