import { useState, type FormEvent } from "react";
import {
  RUNTIME_TRANSPORTS,
  type CreateRuntimeProfileInput,
  type RuntimeDescriptor,
  type RuntimeProfile,
} from "@aif/shared/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  mode: "create" | "edit";
  projectId: string | null;
  runtimes: RuntimeDescriptor[];
  initial?: RuntimeProfile;
  onSubmit: (input: CreateRuntimeProfileInput) => Promise<void> | void;
  onCancel?: () => void;
}

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
  const [runtimeId, setRuntimeId] = useState(initial?.runtimeId ?? firstRuntime?.id ?? "");
  const [providerId, setProviderId] = useState(
    initial?.providerId ??
      runtimes.find((runtime) => runtime.id === (initial?.runtimeId ?? firstRuntime?.id))
        ?.providerId ??
      firstRuntime?.providerId ??
      "",
  );
  const [transport, setTransport] = useState(initial?.transport ?? RUNTIME_TRANSPORTS[0]);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState(initial?.apiKeyEnvVar ?? "");
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
  const [headersJson, setHeadersJson] = useState(JSON.stringify(initial?.headers ?? {}, null, 2));
  const [optionsJson, setOptionsJson] = useState(JSON.stringify(initial?.options ?? {}, null, 2));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRuntime = runtimes.find((r) => r.id === runtimeId);

  const handleRuntimeChange = (nextRuntimeId: string) => {
    setRuntimeId(nextRuntimeId);
    const runtime = runtimes.find((item) => item.id === nextRuntimeId);
    if (runtime) {
      setProviderId(runtime.providerId);
      const supported = runtime.supportedTransports ?? [];
      if (supported.length > 0 && !supported.includes(transport)) {
        setTransport(supported[0]);
      }
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const input: CreateRuntimeProfileInput = {
        projectId,
        name: name.trim(),
        runtimeId: runtimeId.trim(),
        providerId: providerId.trim(),
        transport: transport.trim() || null,
        baseUrl: baseUrl.trim() || null,
        apiKeyEnvVar: apiKeyEnvVar.trim() || null,
        defaultModel: defaultModel.trim() || null,
        headers: parseJsonStringMap(headersJson),
        options: parseJsonObject(optionsJson),
        enabled,
      };
      await onSubmit(input);
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
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Name</p>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Runtime profile name"
          />
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
          <p className="text-xs font-medium text-muted-foreground">Default model</p>
          <Input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder={currentRuntime?.defaultModelPlaceholder ?? "model-id"}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Transport</p>
          <Select
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            options={(currentRuntime?.supportedTransports ?? RUNTIME_TRANSPORTS).map((t) => ({
              value: t,
              label: t.toUpperCase(),
            }))}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Base URL</p>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
          />
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
            Env var name only — secrets are never stored in profiles
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
          <p className="text-xs font-medium text-muted-foreground">Options JSON</p>
          <Textarea
            rows={6}
            value={optionsJson}
            onChange={(e) => setOptionsJson(e.target.value)}
            placeholder='{"temperature":0.2}'
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Secrets are never saved here. Use `apiKeyEnvVar` and environment variables.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
          Enabled
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={saving || !name.trim()}>
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
