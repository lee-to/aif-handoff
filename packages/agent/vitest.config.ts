import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
