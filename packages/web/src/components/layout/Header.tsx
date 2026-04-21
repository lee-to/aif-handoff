import { useEffect, useRef, useState } from "react";
import { Bell, Moon, Sun, Command, ChartColumn, Cpu, Map, Settings } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useEffectiveChatRuntime } from "@/hooks/useRuntimeProfiles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProjectSelector } from "@/components/project/ProjectSelector";
import type { Project } from "@aif/shared/browser";
import type { TaskMetricsSummary } from "@/lib/taskMetrics";
import { NotificationsDialog } from "./NotificationsDialog";
import { MetricsDialog, type AggregateProjectTotals } from "./MetricsDialog";
import { RoadmapDialog } from "./RoadmapDialog";
import { GlobalSettingsDialog } from "./GlobalSettingsDialog";

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
  aggregateTotals?: AggregateProjectTotals | null;
  runtimeProfilesOpen: boolean;
  onToggleRuntimeProfiles: () => void;
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
  aggregateTotals,
  runtimeProfilesOpen,
  onToggleRuntimeProfiles,
  onRoadmapImportComplete,
}: Props) {
  const { theme, toggleTheme } = useTheme();
  const headerRef = useRef<HTMLElement>(null);
  const { data: effectiveChatRuntime, isFetching: effectiveRuntimeFetching } =
    useEffectiveChatRuntime(selectedProject?.id ?? null);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const h = `${el.offsetHeight}px`;
    document.documentElement.style.setProperty("--header-height", h);
  }, [density]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const isCompact = density === "compact";
  const currentRuntimeLabel = !selectedProject
    ? "No project"
    : effectiveRuntimeFetching
      ? "Loading..."
      : (effectiveChatRuntime?.profile?.name ?? "Default");

  return (
    <header ref={headerRef} className="sticky top-0 z-60 border-b border-border bg-background">
      <div
        className={`mx-auto flex w-full items-center ${isCompact ? "h-14 px-4 md:px-5" : "h-16 px-6 md:px-8"}`}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onDeselectProject}
            aria-label="Go to projects overview"
            title="Projects overview"
            className="flex items-center focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-10 w-auto text-foreground transition-opacity hover:opacity-80"
              viewBox="110 -62 1150 1150"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                transform="translate(292.2076721191406,242.98760986328125)"
                d="M304.79233 7.01239l3.5 1.60001c13.12152 5.47189 24.57171 14.30096 33.20001 25.6 5 6.79999 8.70001 14.20001 12.29999 21.79999l1.29999 2.79999 20 43.29999 1 2.39999c9.83435 21.55914 19.86816 43.02673 30.10003 64.40002l15.70001 33.4 1 2.29999 3.20002 6.70001 1 2 6.69995 13.70001q-8.59998 6.29999-17.90003 11.5-9.30005 5.20001-18.09997 10.79999l-3 1.79999-3 1.70001-2.59998 1.6c-2.30121 1.62726-4.41418 3.5055-6.30005 5.60001l-1.20001-2.79999c-9.48712-21.57745-19.22107-43.04553-29.19995-64.40002l-4.79999-10.5-1.70001-3.60001c-1.20001-2.69998-1.20001-2.69998-1.20001-4.69998l-2-1-2-6q-1.59998-4-3.59998-8l-1-2.20001-5.40002-11.79999-1-2.29999-6.29999-13.6c-2.59998-5.79999-2.59998-5.79999-2.59998-8l-3-1 2 0-1-2.29999-5-10.60001-0.90002-1.89999q-6-12.70001-11.5-25.5-2.70001-6.20001-6.40002-11.79999c-1.20002-1.89999-1.20002-1.89999-2.20002-4-1.29998-2.5-2.5-2.89999-5-3.89999l-1.79998-1c-7.58136-4.14392-16.48554-5.14923-24.79999-2.80005-9.31189 3.69611-16.78742 10.92004-20.79999 20.1l-2.20001 4.79999-1.20001 2.70001q-8 17.29999-15.40003 34.79999l-9.39999 21.4c-14.29999 32.20001-14.29999 32.20001-27.9 64.70001q-3.20001 7.70001-6.70001 15.20001-6.5 14-12.6 28l-17.29996 39-1.20001 2.79999-1 2.29999c-1 1.90002-1 1.90002-0.79999 3.90002 45.25894 19.76428 95.26861 26.0155 144 18l2.40002-0.40002c18.90003-3.09998 54.90003-10.90003 68.59998-24.59998l4.09997-1.59998q8.20002-3.20001 15.70002-7.90002 5.79998-3.29999 11.90002-6.29999 9.90002-5 19.20001-10.79999l7.20001-4.29998 1.79999-1q12.90003-7.79999 26.09998-15.10001l2.20001-1.29999c28.10889-16.21713 57.46906-30.16153 87.80002-41.70004l3.19995-1.20001c70.40002-26.10001 135.6001-29 209.40002-28.79999l35.5-0.10001 2.5 0c4 0 7.5 0.10001 11.40003 1.10001l1-2 3.69995 0.5q9 0.89999 18.30005 0.5c1 3.20001 1 6 1 9.20001l0 3.20001-0.09998 3.4-0.90002 40.20001-171.59998 1-4 0.10001c-3 0-5.5-0.4-8.40002-1.10001l0 1.70001c1.29993 24.29999 1.19995 48.69998 1.09997 73.00003l0 18.09998c0.10315 24.16772-0.06347 48.33588-0.5 72.49994-0.40002 21.79999-0.40002 21.79999-2.59997 30.70001l-2 1-0.40003 3c-2.5 17.40002-15.20007 33.5-28.59997 44-18.70191 13.0799-41.79444 18.28741-64.30005 14.5-23.69995-4.29999-40.49997-16.70001-55.89999-34.40002-1.70002-2-1.70002-2-3.5-3.79999-1.59998-1.59998-2.29999-3.29999-3.29999-5.29999l-1.29999-1.70001q-3-4.40003-5.5-9.09998l-1-2c-2.84357-5.41247-5.51166-10.91534-8-16.5-0.94012-2.4906-2.36804-4.76843-4.20001-6.70001l-0.79999-2.5q-2.59998-7-6.09998-13.40002l-11.40002-23.20002q-7.5-15.5-15.20001-30.79998l-1.70001-3.5-1.59998-3c-1.20001-2.59998-1.20001-2.59998-2.20001-5.59998l-1.79999 1c-2.20001 1-2.20001 1-5.20001 2l-6.20001 3.59998q-11.70002 6.59997-23.79999 12.40002l-2.20001 1.09998c-29.2674 14.63415-60.64856 24.58844-93 29.5-13.79999 2.09997-27.79999 1.59997-41.70002 1.5l-10.59997 0-20.5-0.09998 0-2-1.70001 0c-7.28165 0.06213-14.54108-0.81171-21.59998-2.59998l-3.70001-0.79998c-22.10001-5-43.60001-11.70002-64-21.59998l-0.79999 2.59998q-1.79999 5-4 10l-0.89999 2-2.60001 5.79998q-5.89999 13.5-11.29999 27.20002-2.1 5.20001-4.6 10.20001-4.60001 9.79999-8.70002 19.79999l-1.39999 3.29998-14 33.70002-3 7.09997-0.89999 2.20001c-0.79999 2-0.79999 2-2.79999 5.09998-3 1-3 1-6 1l-5.60001 0c-3.60001 0-6.79999 0.29999-10.39999 1l-4-1-1.70001 0.40002q-6.20001 1.5-12.5 0.09998c-4-0.70001-8.20001-0.59998-12.4-0.59998l-7.29999 0q-3 0.20002-6.1 1.09998c-0.79999-2.29999-1.10001-3.59998-0.4-6l1.10001-2.09998 1.20001-2.40002q0.60001-1.40002 1.4-2.70001l2.79998-5.79999 1.5-3 6.4-14.20001 1.29999-3.09998 9-20.29999 1-2.5 88.49997-200.90002 11.20001-25c15.19833-34.50821 30.56515-68.94196 46.1-103.29999l1-2.20001q4.79999-10.79999 9.29999-21.79999c10-24.70001 25.9-43.60001 50.69998-54.19999 20.79999-8.3 51.40003-11.39999 71.90003-0.5m265.90005 233.99998l-2.20007 0.89999-12 5.10001c-16.82361 7.09863-33.40002 14.76978-49.69998 23l-2.20001 1.09998q-18 9.20001-34.79999 19.90002l1.5 3.20001 10.40002 22q9.59998 21 19.70001 41.5 7.39997 15.29999 14.4 30.5c8.79993 22.40003 8.79993 22.40003 25.79993 37.70001 8.14929 2.76178 17.01818 2.51349 25-0.70001 6.5-3.79999 9.70007-11.20001 11.70007-18.20001 1.79993-8 1.69995-15.79999 1.59997-24l0-31-0.09997-54.40002-0.09998-59.60001c-3.30005 0-6.20007 1.70001-9.09997 3"
              />
              <path
                fill="currentColor"
                transform="translate(491.9999694824219,245.8822021484375)"
                d="M476.70004 0.01779l49.60001 0 142.69995 0.10001q1.19995 4.3 1.09998 8.89999l0 9.20001-0.09998 33.9c-2.80005 1.39999-5.19995 1.10001-8.40002 1.1l-39.80005 0-114.7999-0.1-1 2-2-2q-4.40002-0.20001-8.70001-0.20001l-2.59998 0-7.70001 0.20001-4 0c-10.37579-0.14636-20.53015 3.005-29 9l-3 2c-8.59998 7.39999-9.90002 18.39999-11 29q-0.20001 7-0.20001 14l0 14 0.09997 10.20001 0.09998 19.89999c-2.59998 0.9-4.59998 1.29999-7.29999 1.60001-12.71252 1.58865-25.33069 3.85858-37.79993 6.79999q-6.5 1.39999-12.90002 2.6l0-84 2 0 0.20001-3.6c3.29175-21.03055 14.26599-40.09302 30.79999-53.5 18.20807-14.08756 40.6825-21.53198 63.70001-21.10001m-373.70001 185.10001c2.90002 1.39999 4.70001 3.70001 7 6l2.79999 2.89999 1.5 1.5q6.59997 6.79999 14 13 3.5 3.29999 6.90002 6.79999 4.79999 4.60001 9.79999 8.79999c-3.4602 4.28051-7.31006 8.23077-11.5 11.80002l-9.90002 9q-7.70002 7.39999-15.5 14.29998l-4.20002 4.10001c-1.89996 1.80002-1.89996 1.80002-3.89996 1.80002-4-4.5-4-4.5-4-7l-2 0 0-2-1.90002-0.70001c-2.5-1.5-3-2.70002-4.09998-5.29999 6.94958-7.20252 14.29425-14.013 22-20.4l3-2.6c-0.5-3.9-2-5.20001-5-7.60001l-4-3.39999 0-2-1.70001-0.70001c-2.55524-1.52649-4.85071-3.45063-6.79999-5.69999-2.07074-2.30206-4.3468-4.41079-6.79999-6.30001l-1.70001-1.29999 0-2c5.5-5 5.5-5 8-5l0.79999-1.70001c3.40002-6.20002 3.40002-6.20002 7.09997-6.4m-60.90002 0.10001l1.29999 1.1 9 7.60001q3 2.5 5.70001 5.29999l-2.59998 1.6c-3.09815 2.18277-5.94843 4.69773-8.49993 7.5q-3 3-5.90003 5.4-5.79999 5-11 10.5c9.40002 9.5 9.40002 9.5 19.29999 18.5q4 3.70001 7.70001 7.5c-1.29999 3.6-3.5 5.29999-6.40002 7.6-2.59998 2.20002-4.5 4.79999-6.59998 7.4-8.28333-7.01813-16.28943-14.35703-24-22l-4.70001-4.20001-2.60001-2.4-2.70001-2.39999-5.60001-5-2.6-2.29999-1.79999-1.70001c1.29999-3.79999 3-4.70001 6-7.20001q6.5-5 12.10001-10.9 3.79999-3.70001 8-7.20001 3.70001-3.39999 7.20001-7 4.09998-4 8.70001-7.70001"
              />
            </svg>
          </button>
          <div className="h-5 w-px bg-border" />
          <ProjectSelector
            selectedId={selectedProject?.id ?? null}
            onSelect={onSelectProject}
            onDeselect={onDeselectProject}
          />
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenCommandPalette}
            className="hidden gap-1 font-mono text-2xs text-muted-foreground md:inline-flex"
            aria-label="Open command palette"
          >
            <Command className="h-3.5 w-3.5" />K
          </Button>

          <div className="hidden h-8 border border-border bg-card md:flex">
            {(["kanban", "list"] as const).map((mode, i) => (
              <Button
                key={mode}
                variant="ghost"
                size="xs"
                onClick={() => onViewModeChange(mode)}
                className={cn(
                  "h-full rounded-none border-0 px-2 font-mono",
                  i > 0 && "border-l border-border",
                  viewMode === mode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {mode.toUpperCase()}
              </Button>
            ))}
          </div>

          <div className="hidden h-8 border border-border bg-card md:flex">
            {(["comfortable", "compact"] as const).map((d, i) => (
              <Button
                key={d}
                variant="ghost"
                size="xs"
                onClick={() => onDensityChange(d)}
                className={cn(
                  "h-full rounded-none border-0 px-2 font-mono",
                  i > 0 && "border-l border-border",
                  density === d
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {d === "comfortable" ? "COMFY" : "COMPACT"}
              </Button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setRoadmapOpen((v) => !v)}
            disabled={!selectedProject}
            className="gap-1 font-mono text-3xs"
            aria-label="Generate roadmap tasks"
          >
            <Map className="h-3.5 w-3.5" />
            <span className="hidden md:inline">ROADMAP</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMetricsOpen((v) => !v)}
            className="gap-1 font-mono text-3xs"
            aria-label="Task metrics"
          >
            <ChartColumn className="h-3.5 w-3.5" />
            <span className="hidden md:inline">METRICS</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleRuntimeProfiles}
            disabled={!selectedProject}
            className={cn(
              "gap-1 font-mono text-3xs",
              runtimeProfilesOpen && "border-primary/70 bg-primary/10",
            )}
            aria-label="Runtime profiles"
            title={
              selectedProject
                ? `Current runtime profile: ${currentRuntimeLabel}`
                : "Select project first"
            }
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>RUNTIME</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setGlobalSettingsOpen((v) => !v)}
            className="h-8 w-8"
            aria-label="Global settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setSettingsOpen((v) => !v)}
            className="h-8 w-8"
            aria-label="Notification settings"
          >
            <Bell className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={toggleTheme}
            className="h-8 w-8"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <NotificationsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <MetricsDialog
        open={metricsOpen}
        onOpenChange={setMetricsOpen}
        taskMetrics={taskMetrics}
        project={selectedProject}
        aggregateTotals={aggregateTotals}
      />
      <RoadmapDialog
        open={roadmapOpen}
        onOpenChange={setRoadmapOpen}
        project={selectedProject}
        onImportComplete={onRoadmapImportComplete}
      />
      <GlobalSettingsDialog
        open={globalSettingsOpen}
        onOpenChange={setGlobalSettingsOpen}
        projectId={selectedProject?.id ?? null}
      />
    </header>
  );
}
