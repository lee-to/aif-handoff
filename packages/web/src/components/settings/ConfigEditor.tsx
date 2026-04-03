import { useState } from "react";
import { Loader2, Save, Check, AlertTriangle, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StickyActionBar } from "@/components/ui/sticky-action-bar";
import { api, type AifConfig } from "@/lib/api";

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
];

const TECHNICAL_TERMS_OPTIONS = [
  { value: "keep", label: "Keep original (API, database...)" },
  { value: "translate", label: "Translate where possible" },
];

const PLAN_ID_FORMAT_OPTIONS = [
  { value: "slug", label: "Slug (from branch/description)" },
  { value: "timestamp", label: "Timestamp" },
  { value: "uuid", label: "UUID" },
];

const VERIFY_MODE_OPTIONS = [
  { value: "strict", label: "Strict" },
  { value: "normal", label: "Normal" },
  { value: "lenient", label: "Lenient" },
];

interface Props {
  config: AifConfig;
  onConfigChange: (config: AifConfig) => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-2 first:mt-0">
      {children}
    </h3>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="w-56 shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "bg-primary border-primary" : "bg-muted border-border"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

export function ConfigEditor({ config, onConfigChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [original, setOriginal] = useState(() => JSON.stringify(config));

  const isDirty = JSON.stringify(config) !== original;

  function update<S extends keyof AifConfig>(section: S, field: string, value: unknown) {
    const current = config[section] ?? {};
    onConfigChange({
      ...config,
      [section]: { ...(current as Record<string, unknown>), [field]: value },
    });
    setSaved(false);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveConfig(config);
      setOriginal(JSON.stringify(config));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    onConfigChange(JSON.parse(original) as AifConfig);
    setError(null);
    setSaved(false);
  }

  return (
    <div className="space-y-1">
      {/* Language */}
      <SectionTitle>Language</SectionTitle>
      <Field label="UI language" hint="Language for AI-agent communication">
        <Select
          value={config.language?.ui ?? "en"}
          options={LANGUAGE_OPTIONS}
          onChange={(e) => update("language", "ui", e.target.value)}
        />
      </Field>
      <Field label="Artifacts language" hint="Language for generated plans, docs">
        <Select
          value={config.language?.artifacts ?? "en"}
          options={LANGUAGE_OPTIONS}
          onChange={(e) => update("language", "artifacts", e.target.value)}
        />
      </Field>
      <Field label="Technical terms" hint="How to handle technical terms in translations">
        <Select
          value={config.language?.technical_terms ?? "keep"}
          options={TECHNICAL_TERMS_OPTIONS}
          onChange={(e) => update("language", "technical_terms", e.target.value)}
        />
      </Field>

      {/* Paths */}
      <SectionTitle>Paths</SectionTitle>
      {(
        [
          ["description", "Description file", ".ai-factory/DESCRIPTION.md"],
          ["architecture", "Architecture file", ".ai-factory/ARCHITECTURE.md"],
          ["docs", "Docs directory", "docs/"],
          ["roadmap", "Roadmap file", ".ai-factory/ROADMAP.md"],
          ["research", "Research file", ".ai-factory/RESEARCH.md"],
          ["rules_file", "Rules file", ".ai-factory/RULES.md"],
          ["plan", "Fast-mode plan file", ".ai-factory/PLAN.md"],
          ["plans", "Plans directory", ".ai-factory/plans/"],
          ["fix_plan", "Fix plan file", ".ai-factory/FIX_PLAN.md"],
          ["security", "Security file", ".ai-factory/SECURITY.md"],
          ["references", "References directory", ".ai-factory/references/"],
          ["patches", "Patches directory", ".ai-factory/patches/"],
          ["evolutions", "Evolutions directory", ".ai-factory/evolutions/"],
          ["evolution", "Evolution state directory", ".ai-factory/evolution/"],
          ["specs", "Specs directory", ".ai-factory/specs/"],
          ["rules", "Rules directory", ".ai-factory/rules/"],
        ] as const
      ).map(([key, label, defaultVal]) => (
        <Field key={key} label={label}>
          <Input
            value={config.paths?.[key] ?? defaultVal}
            onChange={(e) => update("paths", key, e.target.value)}
            className="h-7 text-xs font-mono"
          />
        </Field>
      ))}

      {/* Workflow */}
      <SectionTitle>Workflow</SectionTitle>
      <ToggleField
        label="Auto-create directories"
        hint="Create .ai-factory/ directories when missing"
        checked={config.workflow?.auto_create_dirs ?? true}
        onChange={(v) => update("workflow", "auto_create_dirs", v)}
      />
      <Field label="Plan ID format" hint="Format for new plan identifiers">
        <Select
          value={config.workflow?.plan_id_format ?? "slug"}
          options={PLAN_ID_FORMAT_OPTIONS}
          onChange={(e) => update("workflow", "plan_id_format", e.target.value)}
        />
      </Field>
      <ToggleField
        label="Analyze updates architecture"
        hint="Setup/analyze flow updates ARCHITECTURE.md"
        checked={config.workflow?.analyze_updates_architecture ?? true}
        onChange={(v) => update("workflow", "analyze_updates_architecture", v)}
      />
      <ToggleField
        label="Architecture updates roadmap"
        hint="/aif-architecture updates ROADMAP.md"
        checked={config.workflow?.architecture_updates_roadmap ?? true}
        onChange={(v) => update("workflow", "architecture_updates_roadmap", v)}
      />
      <Field label="Verification mode" hint="Default verification strictness">
        <Select
          value={config.workflow?.verify_mode ?? "normal"}
          options={VERIFY_MODE_OPTIONS}
          onChange={(e) => update("workflow", "verify_mode", e.target.value)}
        />
      </Field>

      {/* Git */}
      <SectionTitle>Git</SectionTitle>
      <ToggleField
        label="Git enabled"
        hint="Use git-aware workflows"
        checked={config.git?.enabled ?? true}
        onChange={(v) => update("git", "enabled", v)}
      />
      <Field label="Base branch" hint="Default branch for diff/review/merge">
        <Input
          value={config.git?.base_branch ?? "main"}
          onChange={(e) => update("git", "base_branch", e.target.value)}
          className="h-7 text-xs font-mono"
        />
      </Field>
      <ToggleField
        label="Create feature branches"
        hint="Auto-create branches for plans"
        checked={config.git?.create_branches ?? true}
        onChange={(v) => update("git", "create_branches", v)}
      />
      <Field label="Branch prefix" hint="Prefix for feature branch names">
        <Input
          value={config.git?.branch_prefix ?? "feature/"}
          onChange={(e) => update("git", "branch_prefix", e.target.value)}
          className="h-7 text-xs font-mono"
        />
      </Field>
      <ToggleField
        label="Skip push after commit"
        hint="Don't prompt to push after /aif-commit"
        checked={config.git?.skip_push_after_commit ?? false}
        onChange={(v) => update("git", "skip_push_after_commit", v)}
      />

      {/* Rules */}
      <SectionTitle>Rules</SectionTitle>
      <Field label="Base rules file" hint="Project-specific conventions file">
        <Input
          value={config.rules?.base ?? ".ai-factory/rules/base.md"}
          onChange={(e) => update("rules", "base", e.target.value)}
          className="h-7 text-xs font-mono"
        />
      </Field>

      {/* Save bar */}
      <StickyActionBar
        visible={isDirty || saved || !!error}
        className="-mb-2 -mx-3 justify-between px-3 pt-3 pb-2 mt-4"
      >
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs text-green-400 flex items-center gap-1">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
          {error && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 border border-border bg-background px-2.5 py-1 text-xs transition-colors hover:border-primary/70"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !isDirty}
            className="inline-flex items-center gap-1 border border-border bg-primary/10 px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </button>
        </div>
      </StickyActionBar>
    </div>
  );
}
