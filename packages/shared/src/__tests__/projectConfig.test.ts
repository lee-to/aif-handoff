import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getProjectConfig, clearProjectConfigCache } from "../projectConfig.js";

describe("getProjectConfig", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "project-config-test-"));
    mkdirSync(join(projectRoot, ".ai-factory"), { recursive: true });
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns defaults when config.yaml does not exist", () => {
    const config = getProjectConfig(projectRoot);
    expect(config.paths.plan).toBe(".ai-factory/PLAN.md");
    expect(config.paths.fix_plan).toBe(".ai-factory/FIX_PLAN.md");
    expect(config.paths.roadmap).toBe(".ai-factory/ROADMAP.md");
    expect(config.paths.plans).toBe(".ai-factory/plans/");
    expect(config.workflow.plan_id_format).toBe("slug");
    expect(config.workflow.verify_mode).toBe("normal");
  });

  it("overrides paths from config.yaml", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "paths:\n  plan: custom/PLAN.md\n  fix_plan: custom/FIX.md\n  roadmap: custom/ROADMAP.md\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.paths.plan).toBe("custom/PLAN.md");
    expect(config.paths.fix_plan).toBe("custom/FIX.md");
    expect(config.paths.roadmap).toBe("custom/ROADMAP.md");
    // Non-overridden paths keep defaults
    expect(config.paths.plans).toBe(".ai-factory/plans/");
  });

  it("overrides workflow from config.yaml", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "workflow:\n  plan_id_format: uuid\n  verify_mode: strict\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.workflow.plan_id_format).toBe("uuid");
    expect(config.workflow.verify_mode).toBe("strict");
    // Non-overridden keeps defaults
    expect(config.workflow.auto_create_dirs).toBe(true);
  });

  it("caches config and returns same result on second call", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "paths:\n  plan: cached/PLAN.md\n",
    );
    const first = getProjectConfig(projectRoot);
    const second = getProjectConfig(projectRoot);
    expect(first).toBe(second); // same object reference = cache hit
    expect(first.paths.plan).toBe("cached/PLAN.md");
  });

  it("handles empty config.yaml gracefully", () => {
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "");
    const config = getProjectConfig(projectRoot);
    // All defaults
    expect(config.paths.plan).toBe(".ai-factory/PLAN.md");
    expect(config.workflow.plan_id_format).toBe("slug");
  });

  it("handles partial config with only some sections", () => {
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "language:\n  ui: ru\n");
    const config = getProjectConfig(projectRoot);
    // paths and workflow untouched
    expect(config.paths.plan).toBe(".ai-factory/PLAN.md");
    expect(config.workflow.verify_mode).toBe("normal");
  });

  it("returns default git section when config.yaml does not exist", () => {
    const config = getProjectConfig(projectRoot);
    expect(config.git.enabled).toBe(true);
    expect(config.git.base_branch).toBe("main");
    expect(config.git.create_branches).toBe(true);
    expect(config.git.branch_prefix).toBe("feature/");
    expect(config.git.skip_push_after_commit).toBe(false);
  });

  it("overrides git.skip_push_after_commit=true from config.yaml", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "git:\n  skip_push_after_commit: true\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.git.skip_push_after_commit).toBe(true);
    // Other git defaults preserved
    expect(config.git.enabled).toBe(true);
    expect(config.git.base_branch).toBe("main");
  });

  it("overrides full git section from config.yaml", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      [
        "git:",
        "  enabled: false",
        "  base_branch: develop",
        "  create_branches: false",
        "  branch_prefix: feat/",
        "  skip_push_after_commit: true",
        "",
      ].join("\n"),
    );
    const config = getProjectConfig(projectRoot);
    expect(config.git.enabled).toBe(false);
    expect(config.git.base_branch).toBe("develop");
    expect(config.git.create_branches).toBe(false);
    expect(config.git.branch_prefix).toBe("feat/");
    expect(config.git.skip_push_after_commit).toBe(true);
  });

  it("returns default language block when config.yaml does not exist", () => {
    const config = getProjectConfig(projectRoot);
    expect(config.language.ui).toBe("en");
    expect(config.language.artifacts).toBe("en");
    expect(config.language.technical_terms).toBe("keep");
  });

  it("returns default language block when config.yaml has no language section", () => {
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "paths:\n  plan: p.md\n");
    const config = getProjectConfig(projectRoot);
    expect(config.language.ui).toBe("en");
    expect(config.language.artifacts).toBe("en");
    expect(config.language.technical_terms).toBe("keep");
  });

  it("parses partial language block (only artifacts)", () => {
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "language:\n  artifacts: ru\n");
    const config = getProjectConfig(projectRoot);
    expect(config.language.ui).toBe("en");
    expect(config.language.artifacts).toBe("ru");
    expect(config.language.technical_terms).toBe("keep");
  });

  it("parses full language block", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "language:\n  ui: ru\n  artifacts: ru\n  technical_terms: translate\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.language.ui).toBe("ru");
    expect(config.language.artifacts).toBe("ru");
    expect(config.language.technical_terms).toBe("translate");
  });

  it("normalizes language codes to lowercase", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "language:\n  artifacts: RU\n  ui: Fr\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.language.artifacts).toBe("ru");
    expect(config.language.ui).toBe("fr");
  });

  it("falls back to 'keep' for invalid technical_terms value without throwing", () => {
    writeFileSync(
      join(projectRoot, ".ai-factory", "config.yaml"),
      "language:\n  artifacts: ru\n  technical_terms: nonsense\n",
    );
    const config = getProjectConfig(projectRoot);
    expect(config.language.technical_terms).toBe("keep");
  });

  it("clearProjectConfigCache invalidates cache", () => {
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "paths:\n  plan: v1/PLAN.md\n");
    const first = getProjectConfig(projectRoot);
    expect(first.paths.plan).toBe("v1/PLAN.md");

    // Update the file and clear cache
    writeFileSync(join(projectRoot, ".ai-factory", "config.yaml"), "paths:\n  plan: v2/PLAN.md\n");
    clearProjectConfigCache(projectRoot);
    const second = getProjectConfig(projectRoot);
    expect(second.paths.plan).toBe("v2/PLAN.md");
  });
});
