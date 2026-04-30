import { useEffect, useMemo, useState } from "react";
import { Flame, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  useClearProjectWarmup,
  useCreateProjectWarmup,
  useProjectWarmup,
} from "@/hooks/useProjectWarmup";
import type { ProjectWarmupSession, ProjectWarmupSupport } from "@/lib/api";
import type { Project } from "@aif/shared/browser";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;
const DEFAULT_TTL_SECONDS = 3_600;

interface WarmupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  enabled: boolean;
}

function formatRuntime(support: ProjectWarmupSupport | null | undefined): string {
  if (!support?.runtimeId || !support.providerId) return "n/a";
  const transport = support.transport ? ` ${support.transport}` : "";
  return `${support.runtimeId}/${support.providerId}${transport}`;
}

function formatModel(model: string | null | undefined): string {
  return model?.trim() || "auto";
}

function formatWorkflow(workflowKind: string | null | undefined): string {
  if (!workflowKind) return "runtime";
  return workflowKind.replace(/[-_]/g, " ");
}

function formatRemaining(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const remainingSeconds = clamped % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function getRemainingSeconds(
  warmup: ProjectWarmupSession | null | undefined,
  tick: number,
): number {
  if (!warmup) return 0;
  const fromExpiry = Math.floor((Date.parse(warmup.expiresAt) - tick) / 1000);
  return Number.isFinite(fromExpiry) ? Math.max(0, fromExpiry) : warmup.remainingSeconds;
}

function statusBadge(warmup: ProjectWarmupSession | null | undefined, enabled: boolean) {
  if (!enabled) return { label: "DISABLED", variant: "secondary" as const };
  if (!warmup) return { label: "NO SESSION", variant: "secondary" as const };
  if (warmup.status === "failed") return { label: "FAILED", variant: "destructive" as const };
  if (warmup.status === "ready") return { label: "READY", variant: "default" as const };
  return { label: warmup.status.toUpperCase(), variant: "outline" as const };
}

export function WarmupDialog({ open, onOpenChange, project, enabled }: WarmupDialogProps) {
  const projectId = project?.id ?? null;
  const [ttlSeconds, setTtlSeconds] = useState(String(DEFAULT_TTL_SECONDS));
  const [ttlTouched, setTtlTouched] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { toast } = useToast();
  const warmupQuery = useProjectWarmup(projectId, open && enabled);
  const createWarmup = useCreateProjectWarmup(projectId);
  const clearWarmup = useClearProjectWarmup(projectId);

  const warmup = warmupQuery.data?.warmup ?? null;
  const fallbackWarmups = useMemo(() => (warmup ? [warmup] : []), [warmup]);
  const warmups = warmupQuery.data?.warmups ?? fallbackWarmups;
  const support = warmupQuery.data?.support ?? null;
  const fallbackTargets = useMemo(() => (support ? [support] : []), [support]);
  const targets = warmupQuery.data?.targets ?? fallbackTargets;
  const supportEnabled = Boolean(warmupQuery.data?.enabled && support?.supported);
  const effectiveTtlSeconds = ttlTouched
    ? ttlSeconds
    : String(warmup?.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const ttlValue = Number(effectiveTtlSeconds);
  const ttlValid =
    Number.isInteger(ttlValue) && ttlValue >= MIN_TTL_SECONDS && ttlValue <= MAX_TTL_SECONDS;
  const remainingSeconds = getRemainingSeconds(warmup, now);
  const badge = statusBadge(warmup, enabled);
  const busy = createWarmup.isPending || clearWarmup.isPending;

  const runtimeRows = useMemo(
    () => [
      ["Runtime", formatRuntime(support)],
      ["Model", formatModel(support?.model)],
      ["Profile", support?.runtimeProfileId ?? "default"],
      ["Source", support?.selectionSource ?? "default"],
    ],
    [support],
  );
  const targetRows = useMemo(
    () =>
      targets.map((target) => {
        const matchingWarmup = warmups.find(
          (item) =>
            item.runtimeProfileId === target.runtimeProfileId &&
            item.runtimeId === target.runtimeId &&
            item.providerId === target.providerId &&
            item.transport === target.transport &&
            item.model === target.model,
        );
        return {
          key: [
            target.workflowKind ?? "target",
            target.runtimeProfileId ?? "default",
            target.runtimeId ?? "runtime",
            target.providerId ?? "provider",
            target.transport ?? "transport",
            target.model ?? "model",
          ].join(":"),
          label: formatWorkflow(target.workflowKind),
          runtime: formatRuntime(target),
          model: formatModel(target.model),
          status: matchingWarmup?.status ?? (target.supported ? "no session" : "unsupported"),
        };
      }),
    [targets, warmups],
  );

  useEffect(() => {
    if (!open) return;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [open]);

  async function handleCreate() {
    if (!projectId || !ttlValid) return;
    try {
      await createWarmup.mutateAsync({ ttlSeconds: ttlValue });
      setTtlTouched(false);
      toast(warmup ? "Warmup regenerated" : "Warmup created", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Failed to create warmup", "error", 8000);
    }
  }

  async function handleClear() {
    if (!projectId || !warmup) return;
    try {
      await clearWarmup.mutateAsync();
      toast("Warmup cleared", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Failed to clear warmup", "error", 8000);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-primary" />
            Runtime Warmup
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {project?.name ?? "No project selected"}
              </p>
              <p className="text-xs text-muted-foreground">Project context</p>
            </div>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>

          <div className="grid gap-2 text-xs sm:grid-cols-2">
            {runtimeRows.map(([label, value]) => (
              <div key={label} className="border border-border bg-background px-3 py-2">
                <p className="font-mono text-3xs uppercase text-muted-foreground">{label}</p>
                <p className="mt-1 truncate font-mono text-foreground">{value}</p>
              </div>
            ))}
          </div>

          {targetRows.length > 1 && (
            <div className="grid gap-2 text-xs">
              {targetRows.map((target) => (
                <div
                  key={target.key}
                  className="grid gap-2 border border-border bg-background px-3 py-2 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-3xs uppercase text-muted-foreground">Target</p>
                    <p className="mt-1 truncate font-mono text-foreground">{target.label}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-3xs uppercase text-muted-foreground">Runtime</p>
                    <p className="mt-1 truncate font-mono text-foreground">
                      {target.runtime} / {target.model}
                    </p>
                  </div>
                  <Badge variant={target.status === "ready" ? "default" : "secondary"}>
                    {target.status.toUpperCase()}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          {warmup && (
            <div className="grid gap-2 text-xs sm:grid-cols-3">
              <div className="border border-border bg-background px-3 py-2">
                <p className="font-mono text-3xs uppercase text-muted-foreground">Remaining</p>
                <p className="mt-1 font-mono text-foreground">
                  {formatRemaining(remainingSeconds)}
                </p>
              </div>
              <div className="border border-border bg-background px-3 py-2">
                <p className="font-mono text-3xs uppercase text-muted-foreground">TTL</p>
                <p className="mt-1 font-mono text-foreground">
                  {formatRemaining(warmup.ttlSeconds)}
                </p>
              </div>
              <div className="border border-border bg-background px-3 py-2">
                <p className="font-mono text-3xs uppercase text-muted-foreground">Expires</p>
                <p className="mt-1 truncate font-mono text-foreground">
                  {new Date(warmup.expiresAt).toLocaleTimeString()}
                </p>
              </div>
            </div>
          )}

          {warmup?.summary && (
            <div className="max-h-28 overflow-y-auto border border-border bg-background px-3 py-2">
              <p className="font-mono text-3xs uppercase text-muted-foreground">Summary</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-foreground">{warmup.summary}</p>
            </div>
          )}

          {warmupQuery.isError && (
            <p className="text-xs text-destructive">
              {warmupQuery.error instanceof Error
                ? warmupQuery.error.message
                : "Failed to load warmup state"}
            </p>
          )}
          {!enabled && <p className="text-xs text-muted-foreground">Warmup is disabled.</p>}
          {enabled && support && !support.supported && (
            <p className="text-xs text-muted-foreground">
              Unsupported runtime: {support.skipReason ?? "unsupported_runtime"}.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div>
              <label htmlFor="warmup-ttl" className="mb-1 block text-xs font-medium">
                TTL seconds
              </label>
              <Input
                id="warmup-ttl"
                type="number"
                min={MIN_TTL_SECONDS}
                max={MAX_TTL_SECONDS}
                value={effectiveTtlSeconds}
                onChange={(event) => {
                  setTtlTouched(true);
                  setTtlSeconds(event.target.value);
                }}
                disabled={busy || !enabled || !projectId}
                aria-invalid={!ttlValid}
              />
              {!ttlValid && (
                <p className="mt-1 text-3xs text-destructive">
                  Enter {MIN_TTL_SECONDS}-{MAX_TTL_SECONDS}.
                </p>
              )}
            </div>
            <Button
              variant="outline"
              className="self-end gap-2"
              onClick={() => void handleCreate()}
              disabled={!projectId || !supportEnabled || !ttlValid || busy || warmupQuery.isLoading}
            >
              {createWarmup.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {warmup ? "Regenerate" : "Create"}
            </Button>
            <Button
              variant="outline"
              className="self-end gap-2"
              onClick={() => void handleClear()}
              disabled={!projectId || !warmup || busy}
            >
              {clearWarmup.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Clear
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
