import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/ws.ts", "src/middleware/**", "src/routes/projects.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
