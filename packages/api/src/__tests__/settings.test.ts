import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create a temp dir to act as monorepo root and home
const tempRoot = mkdtempSync(join(tmpdir(), "settings-test-"));
const aiFactoryDir = join(tempRoot, ".ai-factory");
mkdirSync(aiFactoryDir, { recursive: true });

const fakeHome = mkdtempSync(join(tmpdir(), "settings-home-"));

const TEST_PROJECT_ID = "test-project-id";

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    findMonorepoRoot: () => tempRoot,
  };
});

vi.mock("@aif/data", () => ({
  findProjectById: (id: string) =>
    id === TEST_PROJECT_ID ? { id, rootPath: tempRoot } : undefined,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

const { settingsRoutes } = await import("../routes/settings.js");

function createApp() {
  const app = new Hono();
  app.route("/settings", settingsRoutes);
  return app;
}

describe("settings API — config routes", () => {
  let app: ReturnType<typeof createApp>;
  const configPath = join(aiFactoryDir, "config.yaml");

  beforeEach(() => {
    app = createApp();
    // Clean up config file between tests
    try {
      rmSync(configPath);
    } catch {
      /* ok if missing */
    }
  });

  describe("GET /settings/config/status", () => {
    it("returns 400 when no projectId", async () => {
      const res = await app.request("/settings/config/status");
      expect(res.status).toBe(400);
    });

    it("returns exists: false when no config.yaml", async () => {
      const res = await app.request(`/settings/config/status?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(false);
    });

    it("returns exists: true when config.yaml exists", async () => {
      writeFileSync(configPath, "language:\n  ui: en\n");
      const res = await app.request(`/settings/config/status?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exists).toBe(true);
    });
  });

  describe("GET /settings/config", () => {
    it("returns 400 when no projectId", async () => {
      const res = await app.request("/settings/config");
      expect(res.status).toBe(400);
    });

    it("returns 404 when config.yaml missing", async () => {
      const res = await app.request(`/settings/config?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(404);
    });

    it("returns parsed config as JSON", async () => {
      writeFileSync(configPath, "language:\n  ui: ru\n  artifacts: en\n");
      const res = await app.request(`/settings/config?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toEqual({ language: { ui: "ru", artifacts: "en" } });
    });
  });

  describe("PUT /settings/config", () => {
    it("returns 400 when no projectId", async () => {
      const res = await app.request("/settings/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { language: { ui: "en" } } }),
      });
      expect(res.status).toBe(400);
    });

    it("writes config and returns success", async () => {
      // Create initial file so we can verify overwrite
      writeFileSync(configPath, "language:\n  ui: en\n");

      const newConfig = { language: { ui: "de", artifacts: "fr" }, git: { enabled: true } };
      const res = await app.request(`/settings/config?projectId=${TEST_PROJECT_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: newConfig }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify file was actually written by reading back
      const readRes = await app.request(`/settings/config?projectId=${TEST_PROJECT_ID}`);
      const readBody = await readRes.json();
      expect(readBody.config.language.ui).toBe("de");
      expect(readBody.config.git.enabled).toBe(true);
    });

    it("rejects invalid config (not an object)", async () => {
      writeFileSync(configPath, "language:\n  ui: en\n");
      const res = await app.request(`/settings/config?projectId=${TEST_PROJECT_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: null }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("MCP routes", () => {
    const claudeConfigPath = join(fakeHome, ".claude.json");
    const codexConfigPath = join(fakeHome, ".codex", "config.toml");

    beforeEach(() => {
      delete process.env.MCP_PORT;
      try {
        rmSync(claudeConfigPath);
      } catch {
        /* ok */
      }
      try {
        rmSync(join(fakeHome, ".codex"), { recursive: true, force: true });
      } catch {
        /* ok */
      }
    });

    it("GET /settings/mcp returns installed: false when no config", async () => {
      const res = await app.request("/settings/mcp");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installed).toBe(false);
    });

    it("POST /settings/mcp/install adds handoff server", async () => {
      writeFileSync(claudeConfigPath, "{}");
      const res = await app.request("/settings/mcp/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      // Verify it's now installed
      const checkRes = await app.request("/settings/mcp");
      const checkBody = await checkRes.json();
      expect(checkBody.installed).toBe(true);

      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
      expect(claudeConfig.mcpServers.handoff).toEqual({
        type: "stdio",
        command: "npx",
        args: ["tsx", join(tempRoot, "packages/mcp/src/index.ts")],
        cwd: tempRoot,
        env: {
          DATABASE_URL: join(tempRoot, "data", "aif.sqlite"),
          LOG_DESTINATION: "stderr",
          LOG_LEVEL: "info",
          MCP_TRANSPORT: "stdio",
          PROJECTS_DIR: join(tempRoot, ".projects"),
        },
      });

      const codexToml = readFileSync(codexConfigPath, "utf-8");
      expect(codexToml).toContain("[mcp_servers.handoff]");
      expect(codexToml).toContain('command = "npx"');
      expect(codexToml).not.toContain('url = "http://localhost:3100/mcp"');
    });

    it("POST /settings/mcp/install adds handoff HTTP server when MCP_PORT is set", async () => {
      process.env.MCP_PORT = "3100";
      writeFileSync(claudeConfigPath, "{}");

      const res = await app.request("/settings/mcp/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
      expect(claudeConfig.mcpServers.handoff).toEqual({
        type: "http",
        url: "http://localhost:3100/mcp",
      });

      const codexToml = readFileSync(codexConfigPath, "utf-8");
      expect(codexToml).toContain("[mcp_servers.handoff]");
      expect(codexToml).toContain('url = "http://localhost:3100/mcp"');
      expect(codexToml).not.toContain('command = "npx"');
    });

    it("DELETE /settings/mcp removes handoff server", async () => {
      writeFileSync(
        claudeConfigPath,
        JSON.stringify({ mcpServers: { handoff: { command: "test" } } }),
      );
      const res = await app.request("/settings/mcp", { method: "DELETE" });
      expect(res.status).toBe(200);

      const checkRes = await app.request("/settings/mcp");
      const checkBody = await checkRes.json();
      expect(checkBody.installed).toBe(false);
    });

    it("DELETE /settings/mcp removes handoff HTTP server", async () => {
      process.env.MCP_PORT = "3100";
      writeFileSync(
        claudeConfigPath,
        JSON.stringify({ mcpServers: { handoff: { url: "http://localhost:3100/mcp" } } }),
      );
      mkdirSync(join(fakeHome, ".codex"), { recursive: true });
      writeFileSync(codexConfigPath, '[mcp_servers.handoff]\nurl = "http://localhost:3100/mcp"\n');

      const res = await app.request("/settings/mcp", { method: "DELETE" });
      expect(res.status).toBe(200);

      const checkRes = await app.request("/settings/mcp");
      const checkBody = await checkRes.json();
      expect(checkBody.installed).toBe(false);
    });

    it("DELETE /settings/mcp is safe when not installed", async () => {
      const res = await app.request("/settings/mcp", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });
});
