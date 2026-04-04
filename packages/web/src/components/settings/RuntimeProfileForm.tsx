import { useState, type FormEvent } from "react";
import type { CreateRuntimeProfileInput, RuntimeProfile } from "@aif/shared/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface RuntimeDescriptor {
  id: string;
  providerId: string;
  displayName: string;
}

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
  const [runtimeId, setRuntimeId] = useState(initial?.runtimeId ?? runtimes[0]?.id ?? "claude");
  const [providerId, setProviderId] = useState(
    initial?.providerId ??
      runtimes.find((runtime) => runtime.id === (initial?.runtimeId ?? runtimes[0]?.id))
        ?.providerId ??
      "anthropic",
  );
  const [transport, setTransport] = useState(initial?.transport ?? "sdk");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState(initial?.apiKeyEnvVar ?? "");
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
  const [headersJson, setHeadersJson] = useState(JSON.stringify(initial?.headers ?? {}, null, 2));
  const [optionsJson, setOptionsJson] = useState(JSON.stringify(initial?.options ?? {}, null, 2));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRuntimeChange = (nextRuntimeId: string) => {
    setRuntimeId(nextRuntimeId);
    const runtime = runtimes.find((item) => item.id === nextRuntimeId);
    if (runtime) {
      setProviderId(runtime.providerId);
    }
    if (nextRuntimeId === "codex" && !transport) {
      setTransport("cli");
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
          <select
            className="h-9 w-full rounded border border-input bg-background px-2 text-sm"
            value={runtimeId}
            onChange={(e) => handleRuntimeChange(e.target.value)}
          >
            {runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.displayName} ({runtime.id})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Provider</p>
          <Input value={providerId} onChange={(e) => setProviderId(e.target.value)} />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Transport</p>
          <Input
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            placeholder="sdk | cli | agentapi"
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
            placeholder="ANTHROPIC_API_KEY"
            autoComplete="off"
            spellCheck={false}
            pattern="^[A-Za-z0-9_.-]+$"
            title="Environment variable name may contain letters, numbers, dot, underscore, and hyphen"
          />
          <p className="text-[11px] text-muted-foreground">
            Use env var name only (A-Z, 0-9, ., _, -)
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Default model</p>
          <Input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="gpt-5.4"
          />
        </div>
        <label className="mt-6 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
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
    </form>
  );
}
