import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertBox } from "@/components/ui/alert-box";
import { Spinner } from "@/components/ui/spinner";
import {
  useCancelCodexLogin,
  useCodexLoginCapabilities,
  useCodexLoginStatus,
  useStartCodexLogin,
  useSubmitCodexCallback,
} from "@/hooks/useCodexLogin";

type WizardStep = "idle" | "awaiting_paste" | "submitting" | "success" | "error";

interface ViewState {
  step: WizardStep;
  authUrl: string | null;
  sessionId: string | null;
  error: string | null;
}

/**
 * Small guided wizard for the Docker-bound Codex OAuth flow.
 *
 * The host browser cannot reach the CLI's `127.0.0.1:1455` callback inside the
 * agent container, so we: (1) ask the broker to spawn `codex login`, (2) hand
 * the auth URL to the user, (3) let them paste the browser redirect URL back
 * so the broker can complete the flow from inside the container.
 *
 * Intentionally composed of existing UI primitives only — never add new
 * primitives here without a matching Pencil design sync.
 */
export function CodexLoginCard() {
  const [view, setView] = useState<ViewState>({
    step: "idle",
    authUrl: null,
    sessionId: null,
    error: null,
  });
  const [pastedUrl, setPastedUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const capabilities = useCodexLoginCapabilities();

  // Always poll so a refresh picks up an in-flight session created before reload.
  const statusQuery = useCodexLoginStatus({ enabled: true });
  const startMutation = useStartCodexLogin();
  const submitMutation = useSubmitCodexCallback();
  const cancelMutation = useCancelCodexLogin();

  // Adopt any pre-existing session the broker reports (user refreshed the page)
  useEffect(() => {
    const data = statusQuery.data;
    if (!data || !data.active) return;
    if (view.step === "idle") {
      setView({
        step: "awaiting_paste",
        authUrl: data.authUrl,
        sessionId: data.sessionId,
        error: null,
      });
    }
  }, [statusQuery.data, view.step]);

  const disabledStart = startMutation.isPending || view.step === "submitting";

  const handleStart = async (): Promise<void> => {
    setView({ step: "idle", authUrl: null, sessionId: null, error: null });
    try {
      const res = await startMutation.mutateAsync();
      setView({
        step: "awaiting_paste",
        authUrl: res.authUrl,
        sessionId: res.sessionId,
        error: null,
      });
    } catch (err) {
      // 409 = broker already has an active session (e.g. after a page reload
      // or a form re-mount). Adopt it instead of surfacing as an error.
      if (err instanceof ApiError && err.status === 409) {
        const body = err.data as { sessionId?: string; authUrl?: string } | undefined;
        if (body?.authUrl && body.sessionId) {
          setView({
            step: "awaiting_paste",
            authUrl: body.authUrl,
            sessionId: body.sessionId,
            error: null,
          });
          return;
        }
      }
      setView({
        step: "error",
        authUrl: null,
        sessionId: null,
        error: err instanceof Error ? err.message : "Failed to start Codex login",
      });
    }
  };

  const handleCopy = async (): Promise<void> => {
    if (!view.authUrl) return;
    try {
      await navigator.clipboard.writeText(view.authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — user can still copy manually from the readonly textarea
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (!pastedUrl.trim()) return;
    setView((prev) => ({ ...prev, step: "submitting", error: null }));
    try {
      await submitMutation.mutateAsync(pastedUrl.trim());
      setView({ step: "success", authUrl: null, sessionId: null, error: null });
      setPastedUrl("");
    } catch (err) {
      setView((prev) => ({
        ...prev,
        step: "awaiting_paste",
        error: err instanceof Error ? err.message : "Callback submission failed",
      }));
    }
  };

  const handleCancel = async (): Promise<void> => {
    try {
      await cancelMutation.mutateAsync();
    } catch {
      // Even if cancel fails, the UI resets so the user can retry.
    }
    setPastedUrl("");
    setView({ step: "idle", authUrl: null, sessionId: null, error: null });
  };

  if (capabilities.data && capabilities.data.loginProxyEnabled !== true) {
    return <></>;
  }

  const heading = (() => {
    switch (view.step) {
      case "awaiting_paste":
        return "Step 2 — Paste the redirect URL";
      case "submitting":
        return "Completing Codex login…";
      case "success":
        return "Codex login succeeded";
      case "error":
        return "Codex login error";
      default:
        return "Codex OAuth login (Docker)";
    }
  })();

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{heading}</h3>
          <p className="text-xs text-muted-foreground">
            Use this wizard only when running inside Docker and you do not have
            <code className="mx-1">OPENAI_API_KEY</code> configured.
          </p>
        </div>

        {view.step === "idle" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Click Start to spawn <code>codex login</code> inside the agent container and receive
              an authorization URL.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={disabledStart} onClick={handleStart}>
                {startMutation.isPending ? <Spinner /> : "Start Codex login"}
              </Button>
            </div>
            {view.error && <AlertBox variant="error">{view.error}</AlertBox>}
          </div>
        )}

        {(view.step === "awaiting_paste" || view.step === "submitting") && view.authUrl && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">1. Open this URL in your browser</span>
              <Textarea
                readOnly
                value={view.authUrl}
                rows={2}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="flex gap-2">
                <Button type="button" size="xs" variant="outline" onClick={handleCopy}>
                  {copied ? "Copied" : "Copy URL"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => window.open(view.authUrl ?? "", "_blank", "noopener,noreferrer")}
                >
                  Open in new tab
                </Button>
              </div>
              <p className="text-3xs text-muted-foreground">
                After authorizing, the browser redirects to
                <code className="mx-1">http://localhost:1455/?code=…</code> and will show a
                connection-refused error. That is expected — copy the full URL from the address bar
                and paste it below.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">2. Paste the redirect URL</span>
              <Textarea
                value={pastedUrl}
                onChange={(e) => setPastedUrl(e.target.value)}
                rows={3}
                placeholder="http://localhost:1455/?code=…&state=…"
                disabled={view.step === "submitting"}
              />
            </div>

            {view.error && <AlertBox variant="error">{view.error}</AlertBox>}

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleSubmit}
                disabled={view.step === "submitting" || !pastedUrl.trim()}
              >
                {view.step === "submitting" ? <Spinner /> : "Submit callback"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                disabled={view.step === "submitting"}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {view.step === "success" && (
          <div className="flex flex-col gap-2">
            <AlertBox variant="success">
              Codex is now authenticated. Restart the agent to pick up the new credentials:
              <code className="ml-1">docker compose restart agent</code>
            </AlertBox>
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setView({
                    step: "idle",
                    authUrl: null,
                    sessionId: null,
                    error: null,
                  })
                }
              >
                Start over
              </Button>
            </div>
          </div>
        )}

        {view.step === "error" && (
          <div className="flex flex-col gap-2">
            <AlertBox variant="error">{view.error ?? "Unknown error"}</AlertBox>
            <div>
              <Button type="button" size="sm" onClick={handleStart}>
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
