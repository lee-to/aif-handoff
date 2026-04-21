import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

// Load root .env before reading env vars.
// Cannot use @aif/shared/env here — Vite loads config via native Node ESM
// which cannot resolve .js extensions in TS source files (unlike tsx used by api/agent).
const __dir = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(__dir, "../../.env");
const rootEnvLocal = resolve(__dir, "../../.env.local");
if (existsSync(rootEnv)) dotenvConfig({ path: rootEnv, override: true });
if (existsSync(rootEnvLocal)) dotenvConfig({ path: rootEnvLocal, override: true });

const WEB_PORT = Number(process.env.WEB_PORT) || 5180;
const WEB_HOST = process.env.WEB_HOST?.trim() || "localhost";
const API_PORT = Number(process.env.PORT) || 3009;
const apiTarget = `http://localhost:${API_PORT}`;

export default defineConfig(async () => {
  let tailwindcss: typeof import("@tailwindcss/vite").default;
  try {
    ({ default: tailwindcss } = await import("@tailwindcss/vite"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[FIX] Failed to load @tailwindcss/vite: ${message}`);
  }

  return {
    define: {
      "import.meta.env.VITE_API_PORT": JSON.stringify(String(API_PORT)),
    },
    // Lazy-load the Tailwind plugin so Vite config bundling does not try to parse
    // the native oxide binary as UTF-8 before Node can load it normally.
    plugins: [react(), tailwindcss()],
    build: {
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
              return "vendor";
            }
            if (
              id.includes("react-markdown") ||
              id.includes("remark-") ||
              id.includes("rehype-") ||
              id.includes("mdast") ||
              id.includes("micromark") ||
              id.includes("unified")
            ) {
              return "markdown";
            }
            if (id.includes("@dnd-kit")) {
              return "dnd";
            }
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dir, "./src"),
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test-setup.ts"],
    },
    server: {
      port: WEB_PORT,
      host: WEB_HOST,
      proxy: {
        "/projects": apiTarget,
        "/tasks": apiTarget,
        "/agent": apiTarget,
        "/chat": apiTarget,
        "/runtime-profiles": apiTarget,
        "/settings": apiTarget,
        "/health": apiTarget,
        "/ws": {
          target: `ws://localhost:${API_PORT}`,
          ws: true,
        },
      },
    },
  };
});
