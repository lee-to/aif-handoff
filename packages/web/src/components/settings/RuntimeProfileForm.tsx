import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import {
  RUNTIME_TRANSPORTS,
  type CreateRuntimeProfileInput,
  type RuntimeDescriptor,
  type RuntimeProfile,
} from "@aif/shared/browser";
import { useRuntimeModels } from "@/hooks/useRuntimeProfiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CodexLoginCard } from "./CodexLoginCard";

interface Props {
  mode: "create" | "edit";
  projectId: string | null;
  runtimes: RuntimeDescriptor[];
  initial?: RuntimeProfile;
  onSubmit: (input: CreateRuntimeProfileInput) => Promise<void> | void;
  onCancel?: () => void;
}

interface RuntimeModelOption {
  id: string;
  label?: string;
  supportsStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

const MANAGED_OPTION_KEYS = ["effort", "modelReasoningEffort", "reasoningEffort"] as const;
const MODEL_DISCOVERY_DEBOUNCE_MS = 300;

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseJsonStringMap(raw: string): Record<string, string> {
  const parsed = parseJsonObject(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function stripManagedOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...(options ?? {}) };
  for (const key of MANAGED_OPTION_KEYS) {
    delete next[key];
  }
  return next;
}

function readInitialEffort(options: Record<string, unknown> | undefined): string {
  for (const key of MANAGED_OPTION_KEYS) {
    const value = options?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function getEffortOptionKey(
  runtimeId: string,
): "effort" | "modelReasoningEffort" | "reasoningEffort" | null {
  if (runtimeId === "claude") return "effort";
  if (runtimeId === "codex") return "modelReasoningEffort";
  if (runtimeId === "openrouter") return "effort";
  if (runtimeId === "opencode") return "reasoningEffort";
  return null;
}

function getRuntimeEffortLevels(runtimeId: string): string[] {
  if (runtimeId === "claude") return ["low", "medium", "high", "max"];
  if (runtimeId === "codex") return ["minimal", "low", "medium", "high", "xhigh"];
  if (runtimeId === "openrouter") return ["minimal", "low", "medium", "high", "xhigh"];
  if (runtimeId === "opencode") return ["none", "minimal", "low", "medium", "high", "xhigh"];
  return [];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function getModelEffortLevels(model: RuntimeModelOption | null): string[] {
  return readStringArray(model?.metadata?.supportedEffortLevels);
}

function mergeManagedOptions(
  runtimeId: string,
  options: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  const next = stripManagedOptions(options);
  const key = getEffortOptionKey(runtimeId);
  if (key && effort.trim()) {
    next[key] = effort.trim();
  }
  return next;
}

function makeDiscoveryLabel(model: RuntimeModelOption): string {
  return model.label ? `${model.label} (${model.id})` : model.id;
}

function pickPreferredDiscoveredModel(
  models: RuntimeModelOption[],
  runtimeDefaultModelPlaceholder?: string | null,
): RuntimeModelOption | null {
  if (models.length === 0) return null;

  const explicitDefault =
    models.find((model) => model.metadata?.isDefault === true) ??
    (runtimeDefaultModelPlaceholder
      ? models.find((model) => model.id === runtimeDefaultModelPlaceholder)
      : null);

  return explicitDefault ?? models[0] ?? null;
}

export function RuntimeProfileForm({
  mode,
  projectId,
  runtimes,
  initial,
  onSubmit,
  onCancel,
}: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const firstRuntime = runtimes[0];
  const initialRuntimeId = initial?.runtimeId ?? firstRuntime?.id ?? "";
  const [runtimeId, setRuntimeId] = useState(initialRuntimeId);
  const [providerId, setProviderId] = useState(
    initial?.providerId ??
      runtimes.find((runtime) => runtime.id === initialRuntimeId)?.providerId ??
      firstRuntime?.providerId ??
      "",
  );
  const initialTransport =
    initial?.transport ??
    runtimes.find((runtime) => runtime.id === initialRuntimeId)?.defaultTransport ??
    RUNTIME_TRANSPORTS[0];
  const [transport, setTransport] = useState(initialTransport);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState(initial?.apiKeyEnvVar ?? "");
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
  const [effort, setEffort] = useState(readInitialEffort(initial?.options));
  const [headersJson, setHeadersJson] = useState(JSON.stringify(initial?.headers ?? {}, null, 2));
  const [optionsJson, setOptionsJson] = useState(
    JSON.stringify(stripManagedOptions(initial?.options), null, 2),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<RuntimeModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelLoadRequestIdRef = useRef(0);
  const runtimeModels = useRuntimeModels();
  const currentRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const showCodexLoginCard = runtimeId === "codex";
  const supportsModelDiscovery = Boolean(currentRuntime?.capabilities.supportsModelDiscovery);
  const preferredDiscoveredModel = pickPreferredDiscoveredModel(
    discoveredModels,
    currentRuntime?.defaultModelPlaceholder ?? null,
  );
  const selectedDiscoveredModel =
    discoveredModels.find((model) => model.id === defaultModel.trim()) ??
    (defaultModel.trim().length === 0 ? preferredDiscoveredModel : null);
  const shouldShowModelFilter = discoveredModels.length > 5;
  const effortLevels = (() => {
    const byModel = getModelEffortLevels(selectedDiscoveredModel);
    return byModel.length > 0 ? byModel : getRuntimeEffortLevels(runtimeId);
  })();
  const effortOptions = effortLevels.map((level) => ({
    value: level,
    label: level.toUpperCase(),
  }));
  const normalizedEffort = effort.trim();
  const effectiveEffort =
    normalizedEffort.length > 0 && effortLevels.includes(normalizedEffort) ? normalizedEffort : "";

  const handleRuntimeChange = (nextRuntimeId: string) => {
    modelLoadRequestIdRef.current += 1;
    setRuntimeId(nextRuntimeId);
    const runtime = runtimes.find((item) => item.id === nextRuntimeId);
    setDefaultModel("");
    setEffort("");
    setDiscoveredModels([]);
    setModelsError(null);
    if (!runtime) return;
    setProviderId(runtime.providerId);
    const supported = runtime.supportedTransports ?? [];
    setTransport(runtime.defaultTransport ?? supported[0] ?? RUNTIME_TRANSPORTS[0]);
  };

  const buildProfileDraft = (): CreateRuntimeProfileInput => {
    const options = mergeManagedOptions(runtimeId, parseJsonObject(optionsJson), effectiveEffort);
    return {
      projectId,
      name: name.trim() || currentRuntime?.displayName || runtimeId || "Runtime profile",
      runtimeId: runtimeId.trim(),
      providerId: providerId.trim(),
      transport: transport.trim() || null,
      baseUrl: baseUrl.trim() || null,
      apiKeyEnvVar: apiKeyEnvVar.trim() || null,
      defaultModel: defaultModel.trim() || null,
      headers: parseJsonStringMap(headersJson),
      options,
      enabled,
    };
  };

  const loadModels = async (forceRefresh: boolean) => {
    if (!supportsModelDiscovery) {
      setDiscoveredModels([]);
      setModelsError(null);
      return;
    }
    const requestId = ++modelLoadRequestIdRef.current;
    const preferredModelPlaceholder = currentRuntime?.defaultModelPlaceholder ?? null;
    const result = await runtimeModels.mutateAsync({
      projectId: projectId ?? undefined,
      profile: buildProfileDraft(),
      forceRefresh,
    });
    if (requestId !== modelLoadRequestIdRef.current) {
      return;
    }
    setDiscoveredModels(result.models);
    setModelsError(null);
    const preferredModel = pickPreferredDiscoveredModel(result.models, preferredModelPlaceholder);
    setDefaultModel((current) => {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        return current;
      }
      return preferredModel?.id ?? current;
    });
  };

  const runAutoLoadModels = useEffectEvent(async () =>
    runtimeModels.mutateAsync({
      projectId: projectId ?? undefined,
      profile: buildProfileDraft(),
      forceRefresh: false,
    }),
  );

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const requestId = ++modelLoadRequestIdRef.current;
    if (!supportsModelDiscovery) {
      return;
    }

    const run = async () => {
      const preferredModelPlaceholder = currentRuntime?.defaultModelPlaceholder ?? null;
      setDiscoveredModels([]);
      setModelsError(null);
      try {
        const result = await runAutoLoadModels();
        if (cancelled || requestId !== modelLoadRequestIdRef.current) return;
        setDiscoveredModels(result.models);
        setModelsError(null);
        const preferredModel = pickPreferredDiscoveredModel(
          result.models,
          preferredModelPlaceholder,
        );
        setDefaultModel((current) => {
          const trimmed = current.trim();
          if (trimmed.length > 0) {
            return current;
          }
          return preferredModel?.id ?? current;
        });
      } catch (loadError) {
        if (cancelled) return;
        setDiscoveredModels([]);
        setModelsError(
          loadError instanceof Error ? loadError.message : "Failed to load runtime models",
        );
      }
    };

    debounceTimer = setTimeout(() => {
      void run();
    }, MODEL_DISCOVERY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [
    projectId,
    runtimeId,
    providerId,
    transport,
    baseUrl,
    apiKeyEnvVar,
    headersJson,
    optionsJson,
    supportsModelDiscovery,
    currentRuntime?.defaultModelPlaceholder,
  ]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(buildProfileDraft());
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Failed to save runtime profile",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border border-border bg-card/40 p-3">
      <p className="text-[11px] text-muted-foreground">
        {projectId
          ? "Project scope: only this project can select this profile by default."
          : "Global scope: every project can reuse this profile."}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Name</p>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Runtime profile name"
          />
          <p className="text-[11px] text-muted-foreground">
            Leave empty to auto-fill from selected runtime
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Runtime</p>
          <Select
            value={runtimeId}
            onChange={(e) => handleRuntimeChange(e.target.value)}
            options={runtimes.map((runtime) => ({
              value: runtime.id,
              label: `${runtime.displayName} (${runtime.id})`,
            }))}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Transport</p>
          <Select
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            options={(currentRuntime?.supportedTransports ?? RUNTIME_TRANSPORTS).map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
          />
          {currentRuntime?.defaultTransport && (
            <p className="text-[11px] text-muted-foreground">
              Default transport for this runtime: {currentRuntime.defaultTransport.toUpperCase()}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Suggested models</p>
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={selectedDiscoveredModel?.id}
              onChange={(e) => setDefaultModel(e.target.value)}
              disabled={discoveredModels.length === 0}
              placeholder={
                runtimeModels.isPending
                  ? "Loading models..."
                  : discoveredModels.length === 0
                    ? "No models loaded"
                    : "Pick from runtime catalog"
              }
              searchable={shouldShowModelFilter}
              searchPlaceholder="Filter suggested models"
              searchAutoFocus={shouldShowModelFilter}
              searchEmptyMessage="No matching models"
              options={discoveredModels.map((model) => ({
                value: model.id,
                label: makeDiscoveryLabel(model),
              }))}
            />
            <Button
              type="button"
              variant="outline"
              disabled={runtimeModels.isPending || !supportsModelDiscovery}
              onClick={() => {
                void loadModels(true).catch((loadError) => {
                  setModelsError(
                    loadError instanceof Error
                      ? loadError.message
                      : "Failed to refresh runtime models",
                  );
                });
              }}
            >
              {runtimeModels.isPending
                ? "Loading..."
                : discoveredModels.length > 0
                  ? "Refresh"
                  : "Load"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Pick a known model first, then tweak the ID manually if needed.
          </p>
          {modelsError && <p className="text-[11px] text-destructive">{modelsError}</p>}
        </div>
        <div className="space-y-1 md:col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Default model</p>
          <Input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={currentRuntime?.defaultModelPlaceholder ?? "model-id"}
            spellCheck={false}
          />
        </div>
        {effortOptions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Effort</p>
            <Select
              value={effectiveEffort}
              onChange={(e) => setEffort(e.target.value)}
              placeholder="runtime default"
              options={[{ value: "", label: "Runtime default" }, ...effortOptions]}
            />
            <p className="text-[11px] text-muted-foreground">
              {selectedDiscoveredModel
                ? `Levels for ${selectedDiscoveredModel.id}: ${effortLevels.join(", ")}`
                : `Available for ${runtimeId || "this runtime"}: ${effortLevels.join(", ")}`}
            </p>
          </div>
        )}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Base URL</p>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={currentRuntime?.defaultBaseUrl ?? "https://..."}
          />
          {currentRuntime?.defaultBaseUrlEnvVar && (
            <p className="text-[11px] text-muted-foreground">
              Leave empty to use {currentRuntime.defaultBaseUrlEnvVar} from env
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">API key env var</p>
          <Input
            value={apiKeyEnvVar}
            onChange={(e) => setApiKeyEnvVar(e.target.value)}
            placeholder={currentRuntime?.defaultApiKeyEnvVar ?? "API_KEY"}
            autoComplete="off"
            spellCheck={false}
            pattern="^[A-Za-z0-9_.-]+$"
            title="Environment variable name may contain letters, numbers, dot, underscore, and hyphen"
          />
          <p className="text-[11px] text-muted-foreground">
            Env var name only - secrets are never stored in profiles
          </p>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Headers JSON (non-secret)</p>
          <Textarea
            rows={6}
            value={headersJson}
            onChange={(e) => setHeadersJson(e.target.value)}
            placeholder='{"X-Provider":"value"}'
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Advanced options JSON</p>
          <Textarea
            rows={6}
            value={optionsJson}
            onChange={(e) => setOptionsJson(e.target.value)}
            placeholder='{"temperature":0.2}'
          />
          <p className="text-[11px] text-muted-foreground">
            Managed fields like model effort stay in the dedicated controls above.
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Secrets are never saved here. Use `apiKeyEnvVar` and environment variables.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showCodexLoginCard && (
        <div className="space-y-1">
          <CodexLoginCard />
        </div>
      )}

      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
          Enabled
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving..." : mode === "create" ? "Create Profile" : "Save Profile"}
          </Button>
          {onCancel && (
            <Button type="button" size="sm" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
