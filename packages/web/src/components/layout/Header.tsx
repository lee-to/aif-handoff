import { useCallback, useEffect, useState } from "react";
import { Bell, Moon, Sun, Command, ChartColumn, Map, Loader2 } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import {
  getDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  useNotificationSettings,
} from "@/hooks/useNotificationSettings";
import { ProjectSelector } from "@/components/project/ProjectSelector";
import type { Project } from "@aif/shared/browser";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TaskMetricsSummary } from "@/lib/taskMetrics";
import { api } from "@/lib/api";

export interface RoadmapImportResult {
  roadmapAlias: string;
  created: number;
  skipped: number;
  taskIds: string[];
}

interface Props {
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onDeselectProject: () => void;
  onOpenCommandPalette: () => void;
  density: "comfortable" | "compact";
  onDensityChange: (density: "comfortable" | "compact") => void;
  viewMode: "kanban" | "list";
  onViewModeChange: (mode: "kanban" | "list") => void;
  taskMetrics: TaskMetricsSummary;
  onRoadmapImportComplete?: (result: RoadmapImportResult) => void;
}

export function Header({
  selectedProject,
  onSelectProject,
  onDeselectProject,
  onOpenCommandPalette,
  density,
  onDensityChange,
  viewMode,
  onViewModeChange,
  taskMetrics,
  onRoadmapImportComplete,
}: Props) {
  const { theme, toggleTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [roadmapAlias, setRoadmapAlias] = useState("");
  const [roadmapVision, setRoadmapVision] = useState("");
  const [roadmapLoading, setRoadmapLoading] = useState(false);
  const [roadmapError, setRoadmapError] = useState<string | null>(null);
  const [roadmapResult, setRoadmapResult] = useState<RoadmapImportResult | null>(null);
  const { settings, setSettings } = useNotificationSettings();
  const permission = getDesktopNotificationPermission();
  const isCompact = density === "compact";
  const integerFormatter = new Intl.NumberFormat("en-US");
  const usdFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const formatInteger = (value: number) => integerFormatter.format(Math.round(value));
  const formatUsd = (value: number) => usdFormatter.format(value);
  const formatPercent = (value: number) => `${value.toFixed(1)}%`;

  const handleDesktopNotificationsToggle = useCallback(async () => {
    const next = !settings.desktop;
    if (!next) {
      setSettings({ desktop: false });
      return;
    }

    const result = await requestDesktopNotificationPermission();
    if (result === "granted") {
      setSettings({ desktop: true });
      return;
    }

    setSettings({ desktop: false });
  }, [setSettings, settings.desktop]);

  const handleSoundToggle = useCallback(() => {
    setSettings({ sound: !settings.sound });
  }, [setSettings, settings.sound]);

  const handleRoadmapGenerate = useCallback(async () => {
    if (!selectedProject || !roadmapAlias.trim()) return;
    setRoadmapLoading(true);
    setRoadmapError(null);
    setRoadmapResult(null);
    try {
      console.debug("[roadmap] Starting generation with alias:", roadmapAlias);
      await api.generateRoadmap(
        selectedProject.id,
        roadmapAlias.trim(),
        roadmapVision.trim() || undefined,
      );
      // Server returns 202 immediately — result comes via WebSocket
      console.debug("[roadmap] Generation started, waiting for WS event...");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[roadmap] Failed to start generation:", message);
      setRoadmapError(message);
      setRoadmapLoading(false);
    }
  }, [selectedProject, roadmapAlias, roadmapVision]);

  // Listen for roadmap WS events
  useEffect(() => {
    const handleComplete = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (selectedProject && detail.projectId === selectedProject.id) {
        console.debug("[roadmap] Generation complete:", detail);
        setRoadmapResult(detail);
        setRoadmapLoading(false);
        onRoadmapImportComplete?.(detail);
      }
    };
    const handleError = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (selectedProject && detail.projectId === selectedProject.id) {
        console.error("[roadmap] Generation error:", detail);
        setRoadmapError(detail.error);
        setRoadmapLoading(false);
      }
    };

    window.addEventListener("roadmap:complete", handleComplete);
    window.addEventListener("roadmap:error", handleError);
    return () => {
      window.removeEventListener("roadmap:complete", handleComplete);
      window.removeEventListener("roadmap:error", handleError);
    };
  }, [selectedProject, onRoadmapImportComplete]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div
        className={`mx-auto flex w-full max-w-[1680px] items-center ${isCompact ? "h-14 px-4 md:px-5" : "h-16 px-6 md:px-8"}`}
      >
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight text-primary">&gt;</span>
          <div className="h-5 w-px bg-border" />
          <ProjectSelector
            selectedId={selectedProject?.id ?? null}
            onSelect={onSelectProject}
            onDeselect={onDeselectProject}
          />
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <button
            onClick={onOpenCommandPalette}
            className="hidden h-8 items-center gap-1 border border-border bg-card px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/70 hover:text-foreground md:inline-flex"
            aria-label="Open command palette"
            type="button"
          >
            <Command className="h-3.5 w-3.5" />K
          </button>

          <div className="hidden h-8 border border-border bg-card md:flex">
            <button
              onClick={() => onViewModeChange("kanban")}
              className={`h-full px-2 text-[10px] font-mono transition-colors ${
                viewMode === "kanban"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
              type="button"
            >
              KANBAN
            </button>
            <button
              onClick={() => onViewModeChange("list")}
              className={`h-full border-l border-border px-2 text-[10px] font-mono transition-colors ${
                viewMode === "list"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
              type="button"
            >
              LIST
            </button>
          </div>

          <div className="hidden h-8 border border-border bg-card md:flex">
            <button
              onClick={() => onDensityChange("comfortable")}
              className={`h-full px-2 text-[10px] font-mono transition-colors ${
                density === "comfortable"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
              type="button"
            >
              COMFY
            </button>
            <button
              onClick={() => onDensityChange("compact")}
              className={`h-full border-l border-border px-2 text-[10px] font-mono transition-colors ${
                density === "compact"
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
              type="button"
            >
              COMPACT
            </button>
          </div>

          <button
            onClick={toggleTheme}
            className="inline-flex h-8 w-8 items-center justify-center border border-border bg-card text-foreground transition-colors hover:border-primary/70 hover:bg-accent"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={() => {
              setRoadmapAlias("");
              setRoadmapVision("");
              setRoadmapError(null);
              setRoadmapResult(null);
              setRoadmapOpen(true);
            }}
            disabled={!selectedProject}
            className="inline-flex h-8 items-center gap-1 border border-border bg-card px-2 text-[10px] font-mono text-foreground transition-colors hover:border-primary/70 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Generate roadmap tasks"
            type="button"
          >
            <Map className="h-3.5 w-3.5" />
            <span className="hidden md:inline">ROADMAP</span>
          </button>
          <button
            onClick={() => setMetricsOpen(true)}
            className="inline-flex h-8 items-center gap-1 border border-border bg-card px-2 text-[10px] font-mono text-foreground transition-colors hover:border-primary/70 hover:bg-accent"
            aria-label="Task metrics"
            type="button"
          >
            <ChartColumn className="h-3.5 w-3.5" />
            <span className="hidden md:inline">METRICS</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center border border-border bg-card text-foreground transition-colors hover:border-primary/70 hover:bg-accent"
            aria-label="Notification settings"
          >
            <Bell className="h-4 w-4" />
          </button>
        </div>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogClose onClose={() => setSettingsOpen(false)} />
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between border border-border bg-card/50 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Desktop notifications</p>
                <p className="text-xs text-muted-foreground">
                  Browser and OS alerts when a task changes status
                </p>
              </div>
              <button
                onClick={() => void handleDesktopNotificationsToggle()}
                className="min-w-16 border border-border bg-background px-2 py-1 text-xs transition-colors hover:border-primary/70"
              >
                {settings.desktop ? "ON" : "OFF"}
              </button>
            </div>

            <div className="flex items-center justify-between border border-border bg-card/50 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Sound</p>
                <p className="text-xs text-muted-foreground">
                  Play a short sound on task status change
                </p>
              </div>
              <button
                onClick={handleSoundToggle}
                className="min-w-16 border border-border bg-background px-2 py-1 text-xs transition-colors hover:border-primary/70"
              >
                {settings.sound ? "ON" : "OFF"}
              </button>
            </div>

            {permission === "unsupported" && (
              <p className="text-xs text-amber-400">
                This browser does not support desktop notifications.
              </p>
            )}
            {permission === "denied" && (
              <p className="text-xs text-amber-400">
                Desktop notifications are blocked in browser settings.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={metricsOpen} onOpenChange={setMetricsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogClose onClose={() => setMetricsOpen(false)} />
          <DialogHeader>
            <DialogTitle>Task Metrics</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Completed tasks</p>
              <p className="text-lg font-semibold">{formatInteger(taskMetrics.completedTasks)}</p>
              <p className="text-xs text-muted-foreground">
                {formatPercent(taskMetrics.completionRate)} of{" "}
                {formatInteger(taskMetrics.totalTasks)}
              </p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Total token usage</p>
              <p className="text-lg font-semibold">{formatInteger(taskMetrics.totalTokenTotal)}</p>
              <p className="text-xs text-muted-foreground">
                in {formatInteger(taskMetrics.totalTokenInput)} / out{" "}
                {formatInteger(taskMetrics.totalTokenOutput)}
              </p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Total cost</p>
              <p className="text-lg font-semibold">{formatUsd(taskMetrics.totalCostUsd)}</p>
              <p className="text-xs text-muted-foreground">
                avg {formatUsd(taskMetrics.averageCostPerTaskUsd)} per task
              </p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Average tokens per task</p>
              <p className="text-lg font-semibold">
                {formatInteger(taskMetrics.averageTokensPerTask)}
              </p>
              <p className="text-xs text-muted-foreground">across all tracked tasks</p>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Active</p>
              <p className="text-base font-medium">{formatInteger(taskMetrics.activeTasks)}</p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Blocked</p>
              <p className="text-base font-medium">{formatInteger(taskMetrics.blockedTasks)}</p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Backlog</p>
              <p className="text-base font-medium">{formatInteger(taskMetrics.backlogTasks)}</p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Verified</p>
              <p className="text-base font-medium">{formatInteger(taskMetrics.verifiedTasks)}</p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Auto mode tasks</p>
              <p className="text-base font-medium">{formatInteger(taskMetrics.autoModeTasks)}</p>
            </div>
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">Fix tasks / Retries</p>
              <p className="text-base font-medium">
                {formatInteger(taskMetrics.fixTasks)} / {formatInteger(taskMetrics.totalRetries)}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={roadmapOpen} onOpenChange={setRoadmapOpen}>
        <DialogContent>
          <DialogClose onClose={() => setRoadmapOpen(false)} />
          <DialogHeader>
            <DialogTitle>Import Roadmap Tasks</DialogTitle>
          </DialogHeader>
          {roadmapResult ? (
            <div className="space-y-3">
              <div className="border border-green-500/30 bg-green-500/10 px-3 py-2">
                <p className="text-sm font-medium text-green-400">Roadmap generated</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Created {roadmapResult.created} task{roadmapResult.created !== 1 ? "s" : ""}
                  {roadmapResult.skipped > 0 &&
                    `, skipped ${roadmapResult.skipped} duplicate${roadmapResult.skipped !== 1 ? "s" : ""}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Alias:{" "}
                  <span className="font-mono text-foreground">{roadmapResult.roadmapAlias}</span>
                </p>
              </div>
              <button
                onClick={() => setRoadmapOpen(false)}
                className="w-full border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Generate a project roadmap from DESCRIPTION.md, then create backlog tasks
                automatically.
              </p>
              <div>
                <label htmlFor="roadmap-alias" className="block text-xs font-medium mb-1">
                  Roadmap alias
                </label>
                <input
                  id="roadmap-alias"
                  type="text"
                  value={roadmapAlias}
                  onChange={(e) => setRoadmapAlias(e.target.value)}
                  placeholder="e.g. v1.0, sprint-1, mvp"
                  className="w-full border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none"
                  disabled={roadmapLoading}
                />
              </div>
              <div>
                <label htmlFor="roadmap-vision" className="block text-xs font-medium mb-1">
                  Vision / requirements{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  id="roadmap-vision"
                  value={roadmapVision}
                  onChange={(e) => setRoadmapVision(e.target.value)}
                  placeholder="Describe what you want to build, priorities, or constraints..."
                  rows={3}
                  className="w-full border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none resize-none"
                  disabled={roadmapLoading}
                />
              </div>
              {roadmapError && <p className="text-xs text-destructive">{roadmapError}</p>}
              <button
                onClick={() => void handleRoadmapGenerate()}
                disabled={roadmapLoading || !roadmapAlias.trim()}
                className="w-full border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {roadmapLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating...
                  </>
                ) : (
                  "Generate Roadmap"
                )}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </header>
  );
}
