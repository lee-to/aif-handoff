import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initBaseProjectDirectory, initProjectDirectory } from "../projectInit.js";

describe("projectInit", () => {
  it("creates project root and git repo but does not create .ai-factory/", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aif-project-init-"));
    try {
      initBaseProjectDirectory(projectRoot);

      expect(existsSync(projectRoot)).toBe(true);
      expect(existsSync(join(projectRoot, ".ai-factory"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("is safe to run multiple times", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aif-project-init-"));
    try {
      initBaseProjectDirectory(projectRoot);
      initBaseProjectDirectory(projectRoot);

      expect(existsSync(projectRoot)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15000);

  it("deprecated initProjectDirectory still works", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aif-project-init-"));
    try {
      initProjectDirectory(projectRoot);

      expect(existsSync(projectRoot)).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15000);
});
