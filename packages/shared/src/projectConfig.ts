import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface AifProjectPaths {
  plan: string;
  plans: string;
  fix_plan: string;
  roadmap: string;
  description: string;
  architecture: string;
  docs: string;
  research: string;
  rules_file: string;
  security: string;
  references: string;
  patches: string;
  evolutions: string;
  evolution: string;
  specs: string;
  rules: string;
}

export interface AifProjectWorkflow {
  auto_create_dirs: boolean;
  plan_id_format: "slug" | "timestamp" | "uuid";
  analyze_updates_architecture: boolean;
  architecture_updates_roadmap: boolean;
  verify_mode: "strict" | "normal" | "lenient";
}

export interface AifProjectGit {
  enabled: boolean;
  base_branch: string;
  create_branches: boolean;
  branch_prefix: string;
  /**
   * When true, `/aif-commit` (and approve-done auto-commit flow) must create a
   * commit but NOT push. When false (default), also push to the current branch
   * after committing. Surfaced in the web settings UI.
   */
  skip_push_after_commit: boolean;
  /**
   * Policy for `git pull --ff-only origin <base_branch>` before creating a
   * feature branch. When false (default), a failed pull is best-effort:
   * Handoff logs a warning and branches from the local base. When true, a
   * failed pull is a hard `BranchIsolationError("base_update_failed")` and
   * the task is parked as `blocked_external` — useful for projects that
   * require feature branches to start from an up-to-date base.
   */
  strict_base_update: boolean;
}

export interface AifProjectLanguage {
  /** Locale for UI prompts (currently informational; reserved for future UI). */
  ui: string;
  /**
   * Locale in which AI should produce artifacts: task descriptions, plans,
   * review notes, commit messages, roadmap items, chat replies.
   * BCP-47-ish language code, lowercased. "en" (default) means no directive is
   * injected and the model picks its native default.
   */
  artifacts: string;
  /**
   * Policy for technical tokens (identifiers, API names, file paths, CLI flags,
   * code snippets). "keep" — leave them in English even when artifacts language
   * is non-English. "translate" — translate alongside the rest.
   */
  technical_terms: "keep" | "translate";
}

export interface AifProjectConfig {
  paths: AifProjectPaths;
  workflow: AifProjectWorkflow;
  git: AifProjectGit;
  language: AifProjectLanguage;
}

const DEFAULT_PATHS: AifProjectPaths = {
  plan: ".ai-factory/PLAN.md",
  plans: ".ai-factory/plans/",
  fix_plan: ".ai-factory/FIX_PLAN.md",
  roadmap: ".ai-factory/ROADMAP.md",
  description: ".ai-factory/DESCRIPTION.md",
  architecture: ".ai-factory/ARCHITECTURE.md",
  docs: "docs/",
  research: ".ai-factory/RESEARCH.md",
  rules_file: ".ai-factory/RULES.md",
  security: ".ai-factory/SECURITY.md",
  references: ".ai-factory/references/",
  patches: ".ai-factory/patches/",
  evolutions: ".ai-factory/evolutions/",
  evolution: ".ai-factory/evolution/",
  specs: ".ai-factory/specs/",
  rules: ".ai-factory/rules/",
};

const DEFAULT_WORKFLOW: AifProjectWorkflow = {
  auto_create_dirs: true,
  plan_id_format: "slug",
  analyze_updates_architecture: true,
  architecture_updates_roadmap: true,
  verify_mode: "normal",
};

const DEFAULT_GIT: AifProjectGit = {
  enabled: true,
  base_branch: "main",
  create_branches: true,
  branch_prefix: "feature/",
  skip_push_after_commit: false,
  strict_base_update: false,
};

const DEFAULT_LANGUAGE: AifProjectLanguage = {
  ui: "en",
  artifacts: "en",
  technical_terms: "keep",
};

/**
 * Conservative BCP-47-ish tag: 2-3 letter primary subtag optionally followed
 * by one or more `-`/`_` separated alphanumeric subtags (2-8 chars each).
 * Catches typos and garbage values so they don't leak into the injected
 * system directive as-is (e.g. `"ru1"` or `"русский"` would be rejected).
 */
const BCP47_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/;

function normalizeLanguageTag(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return fallback;
  return BCP47_TAG.test(trimmed) ? trimmed : fallback;
}

function normalizeLanguage(raw: unknown): AifProjectLanguage {
  const obj = (raw ?? {}) as Partial<AifProjectLanguage>;
  const ui = normalizeLanguageTag(obj.ui, DEFAULT_LANGUAGE.ui);
  const artifacts = normalizeLanguageTag(obj.artifacts, DEFAULT_LANGUAGE.artifacts);
  // Mirror the lenient parsing of `ui`/`artifacts` so `"Translate"` or
  // `" translate "` don't silently revert to `keep`.
  const technicalRaw =
    typeof obj.technical_terms === "string" ? obj.technical_terms.trim().toLowerCase() : "";
  const technicalTerms =
    technicalRaw === "translate" ? "translate" : DEFAULT_LANGUAGE.technical_terms;
  return { ui, artifacts, technical_terms: technicalTerms };
}

/** Cached configs keyed by projectRoot to avoid re-reading on every call */
const configCache = new Map<string, { config: AifProjectConfig; mtimeMs: number }>();

/**
 * Load resolved config for a project.
 * If `.ai-factory/config.yaml` exists, its values override defaults.
 * Results are cached per projectRoot and invalidated when mtime changes.
 */
export function getProjectConfig(projectRoot: string): AifProjectConfig {
  const configPath = join(projectRoot, ".ai-factory", "config.yaml");

  if (!existsSync(configPath)) {
    return {
      paths: { ...DEFAULT_PATHS },
      workflow: { ...DEFAULT_WORKFLOW },
      git: { ...DEFAULT_GIT },
      language: { ...DEFAULT_LANGUAGE },
    };
  }

  const stat = statSync(configPath);
  const cached = configCache.get(projectRoot);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.config;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as Record<string, unknown> | null;

  const yamlPaths = (parsed?.paths ?? {}) as Partial<AifProjectPaths>;
  const yamlWorkflow = (parsed?.workflow ?? {}) as Partial<AifProjectWorkflow>;
  const yamlGit = (parsed?.git ?? {}) as Partial<AifProjectGit>;

  const config: AifProjectConfig = {
    paths: { ...DEFAULT_PATHS, ...yamlPaths },
    workflow: { ...DEFAULT_WORKFLOW, ...yamlWorkflow },
    git: { ...DEFAULT_GIT, ...yamlGit },
    language: normalizeLanguage(parsed?.language),
  };

  configCache.set(projectRoot, { config, mtimeMs: stat.mtimeMs });
  return config;
}

/** Clear the cached config for a project (useful after writing config.yaml) */
export function clearProjectConfigCache(projectRoot?: string): void {
  if (projectRoot) {
    configCache.delete(projectRoot);
  } else {
    configCache.clear();
  }
}
