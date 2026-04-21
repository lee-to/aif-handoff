import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/.git/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "src/components/kanban/AddTaskForm.tsx",
        "src/components/kanban/TaskCard.tsx",
        "src/components/task/AgentTimeline.tsx",
        "src/components/task/TaskComments.tsx",
        "src/components/task/TaskDescription.tsx",
        "src/components/task/TaskDetail.tsx",
        "src/components/task/TaskLog.tsx",
        "src/components/task/TaskPlan.tsx",
        "src/lib/utils.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dir, "./src"),
    },
  },
});
