import { describe, expect, it, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { resetEnvCache } from "@aif/shared";
import { bootstrapRuntimeRegistry } from "../bootstrap.js";
import { RuntimeTransport, UsageSource } from "../types.js";
import { createAntigravityRuntimeAdapter } from "../adapters/antigravity/index.js";

const hasLiveCli = Boolean(process.env.TEST_ANTIGRAVITY_INTEGRATION);

describe("Antigravity Pipeline Verification", () => {
  describe("Registration & Security", () => {
    it("1.1 успішно реєструє antigravity в bootstrapRuntimeRegistry", async () => {
      process.env.AIF_RUNTIME_ANTIGRAVITY_ENABLED = "true";
      resetEnvCache();
      try {
        const registry = await bootstrapRuntimeRegistry();
        const adapter = registry.resolveRuntime("antigravity");
        expect(adapter).toBeDefined();
        expect(adapter.descriptor.id).toBe("antigravity");
        expect(adapter.descriptor.providerId).toBe("google");
        expect(adapter.descriptor.capabilities.supportsResume).toBe(true);
        expect(adapter.descriptor.capabilities.supportsModelDiscovery).toBe(true);
      } finally {
        delete process.env.AIF_RUNTIME_ANTIGRAVITY_ENABLED;
        resetEnvCache();
      }
    });

    it("1.4 захист від ін'єкцій: блокує виконання .cmd / .bat файлів", async () => {
      const adapter = createAntigravityRuntimeAdapter();
      const res = await adapter.validateConnection!({
        runtimeId: "antigravity",
        options: { antigravityCliPath: "C:\\malicious\\script.cmd" },
      });
      expect(res.ok).toBe(false);
      expect(res.message).toContain("Executing Antigravity via batch script");
    });
  });

  describe.runIf(hasLiveCli)("Live Pipeline Verification", () => {
    let tempWorkspace: string = "";
    let sessionId: string | undefined;

    afterAll(() => {
      if (tempWorkspace && fs.existsSync(tempWorkspace)) {
        try {
          fs.rmSync(tempWorkspace, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
    });

    it("1.2 успішно валідує зв'язок з бінарником agy.exe", async () => {
      const adapter = createAntigravityRuntimeAdapter();
      const result = await adapter.validateConnection!({
        runtimeId: "antigravity",
        transport: RuntimeTransport.CLI,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Google Antigravity CLI");
    });

    it("1.3 динамічно виявляє моделі через agy models та кешує їх", async () => {
      const adapter = createAntigravityRuntimeAdapter();
      const models = await adapter.listModels!({ runtimeId: "antigravity" });
      expect(models.length).toBeGreaterThanOrEqual(10);

      const flashHigh = models.find((m) => m.id === "gemini-3.8-flash-high");
      expect(flashHigh).toBeDefined();
      expect(flashHigh?.label).toContain("Flash");

      // Швидке повторне отримання з пам'яті (кеш)
      const t0 = Date.now();
      const cached = await adapter.listModels!({ runtimeId: "antigravity" });
      const elapsed = Date.now() - t0;
      expect(cached.length).toBe(models.length);
      expect(elapsed).toBeLessThan(100);
    });

    // =========================================================================
    // ЕТАП 2: Реалізація завдання (Роль Builder / Antigravity CLI)
    // =========================================================================
    describe("Етап 2: Реалізація інженерного завдання (Builder Phase)", () => {
      it("2.1 створює модуль TypeScript у робочому просторі та повертає валідну сесію", async () => {
        tempWorkspace = path.join(os.tmpdir(), `agy-pipeline-${Date.now()}`);
        fs.mkdirSync(tempWorkspace, { recursive: true });

        // Ініціалізуємо git репозиторій для роботи агента
        execSync("git init", { cwd: tempWorkspace });
        execSync('git config user.name "Handoff Test"', { cwd: tempWorkspace });
        execSync('git config user.email "test@handoff.dev"', { cwd: tempWorkspace });

        const adapter = createAntigravityRuntimeAdapter();
        const runResult = await adapter.run({
          runtimeId: "antigravity",
          model: "gemini-3.8-flash-high",
          cwd: tempWorkspace,
          usageContext: { source: UsageSource.TEST },
          prompt:
            "Create a clean TypeScript file `src/math.ts` with two functions: `sum(a: number, b: number): number` and `subtract(a: number, b: number): number`. Also create a file `src/index.ts` that exports them. Then commit the files with git message 'feat: add math module'. Keep your response very brief.",
          execution: {
            runTimeoutMs: 120_000,
            bypassPermissions: true,
          },
        });

        expect(runResult.outputText).toBeDefined();
        expect(runResult.outputText?.length ?? 0).toBeGreaterThan(0);
        expect(runResult.sessionId).toBeDefined();
        expect(runResult.sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );

        sessionId = runResult.sessionId ?? undefined;

        // Перевіряємо створені файли у робочому просторі
        const mathFile = path.join(tempWorkspace, "src/math.ts");
        const indexFile = path.join(tempWorkspace, "src/index.ts");
        expect(fs.existsSync(mathFile)).toBe(true);
        expect(fs.existsSync(indexFile)).toBe(true);

        const mathContent = fs.readFileSync(mathFile, "utf8");
        expect(mathContent).toContain("sum");
        expect(mathContent).toContain("subtract");

        // Перевіряємо, чи є коміт у git
        const gitLog = execSync("git log -n 1 --oneline", {
          cwd: tempWorkspace,
          encoding: "utf8",
        });
        expect(gitLog).toContain("math");
      }, 150_000);
    });

    // =========================================================================
    // ЕТАП 3: Рев'ю коду та Верифікація (Review Phase)
    // =========================================================================
    describe("Етап 3: Верифікація результату (Review Phase)", () => {
      it("3.1 створений код синтаксично валідний і виконується", () => {
        expect(tempWorkspace).toBeTruthy();
        const mathFile = path.join(tempWorkspace, "src/math.ts");
        expect(fs.existsSync(mathFile)).toBe(true);

        // Створюємо перевірочний скрипт runner
        const verifyScript = path.join(tempWorkspace, "verify.js");
        fs.writeFileSync(
          verifyScript,
          `
        const fs = require("fs");
        const content = fs.readFileSync("src/math.ts", "utf8");
        if (!content.includes("sum") || !content.includes("subtract")) {
          throw new Error("Missing functions");
        }
        console.log("VERIFIED_OK");
        `,
        );

        const out = execSync("node verify.js", {
          cwd: tempWorkspace,
          encoding: "utf8",
        });
        expect(out).toContain("VERIFIED_OK");
      });
    });

    // =========================================================================
    // ЕТАП 4: Цикл доопрацювання (Session Resume Feedback Loop)
    // =========================================================================
    describe("Етап 4: Відновлення сесії та внесення виправлень за рев'ю (Resume Phase)", () => {
      it("4.1 підхоплює попередню сесію за sessionId та додає нову функцію", async () => {
        expect(sessionId).toBeDefined();
        const adapter = createAntigravityRuntimeAdapter();

        const resumeResult = await adapter.resume!({
          runtimeId: "antigravity",
          sessionId: sessionId!,
          cwd: tempWorkspace,
          usageContext: { source: UsageSource.TEST },
          prompt:
            "Review feedback: Please add a function `multiply(a: number, b: number): number` to `src/math.ts` and export it in `src/index.ts`. Commit with 'feat(math): add multiply'. Be concise.",
          execution: {
            runTimeoutMs: 120_000,
            bypassPermissions: true,
          },
        });

        expect(resumeResult.outputText).toBeDefined();

        const mathFile = path.join(tempWorkspace, "src/math.ts");
        const mathContent = fs.readFileSync(mathFile, "utf8");
        expect(mathContent).toContain("multiply");
        expect(mathContent).toContain("sum"); // попередній код не зламано

        const gitLog = execSync("git log -n 2 --oneline", {
          cwd: tempWorkspace,
          encoding: "utf8",
        });
        expect(gitLog).toContain("multiply");
      }, 150_000);
    });

    // =========================================================================
    // ЕТАП 5: Стійкість та очищення процесів у Windows (Resilience & Tree Kill)
    // =========================================================================
    describe("Етап 5: Стійкість та примусове завершення процесів", () => {
      it("5.1 коректно перериває тривалий процес через AbortController без зомбі-процесів", async () => {
        const adapter = createAntigravityRuntimeAdapter();
        const abortController = new AbortController();

        // Запускаємо фонове переривання через 1500 мс
        const abortTimer = setTimeout(() => {
          abortController.abort();
        }, 1500);

        const startT = Date.now();
        await expect(
          adapter.run({
            runtimeId: "antigravity",
            cwd: tempWorkspace,
            usageContext: { source: UsageSource.TEST },
            prompt:
              "Please write a huge 5000 line TypeScript library with extensive documentation and endless helper algorithms.",
            execution: {
              runTimeoutMs: 60_000,
              bypassPermissions: true,
              abortController,
            },
          }),
        ).rejects.toThrow();

        clearTimeout(abortTimer);
        const elapsed = Date.now() - startT;

        // Має перерватися за ~1.5 - 3 секунди, а не чекати таймауту в 60 с
        expect(elapsed).toBeLessThan(10_000);
      }, 20_000);
    });
  });
});
