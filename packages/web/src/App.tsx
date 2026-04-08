import { useState, useCallback, useEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "./components/layout/Header";
import { Board } from "./components/kanban/Board";
import { TaskDetail } from "./components/task/TaskDetail";
import { CommandPalette } from "./components/layout/CommandPalette";
import { useWebSocket } from "./hooks/useWebSocket";
import { useProjects } from "./hooks/useProjects";
import { useTasks } from "./hooks/useTasks";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";
import { ChatBubble } from "./components/chat/ChatBubble";
import { ChatPanel } from "./components/chat/ChatPanel";
import { Button } from "./components/ui/button";
import { calculateTaskMetrics } from "./lib/taskMetrics";
import { readStorage, writeStorage, removeStorage } from "./lib/storage";
import { STORAGE_KEYS } from "./lib/storageKeys";
import type { Project } from "@aif/shared/browser";
import { ProjectRuntimeSettings } from "./components/project/ProjectRuntimeSettings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true,
    },
  },
});

function AppContent() {
  useWebSocket();
  const { theme, toggleTheme } = useTheme();
  const { data: projects } = useProjects();
  const [project, setProject] = useState<Project | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">(() => {
    const saved = readStorage(STORAGE_KEYS.DENSITY);
    return saved === "compact" ? "compact" : "comfortable";
  });
  const [viewMode, setViewMode] = useState<"kanban" | "list">(() => {
    const saved = readStorage(STORAGE_KEYS.VIEW_MODE);
    return saved === "list" ? "list" : "kanban";
  });
  const { data: projectTasks } = useTasks(project?.id ?? null);
  const taskMetrics = useMemo(() => calculateTaskMetrics(projectTasks ?? []), [projectTasks]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.DENSITY, density);
  }, [density]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.VIEW_MODE, viewMode);
  }, [viewMode]);

  // Restore state from URL or localStorage on initial load
  useEffect(() => {
    if (!projects?.length) return;
    if (project) return;

    const match = window.location.pathname.match(/^\/project\/([^/]+)(?:\/task\/([^/]+))?/);
    if (match) {
      const urlProjectId = match[1];
      const urlTaskId = match[2] ?? null;
      const found = projects.find((p) => p.id === urlProjectId);
      if (found) {
        queueMicrotask(() => {
          setProject(found);
          writeStorage(STORAGE_KEYS.SELECTED_PROJECT, found.id);
          if (urlTaskId) setSelectedTaskId(urlTaskId);
        });
        return;
      }
    }

    const savedId = readStorage(STORAGE_KEYS.SELECTED_PROJECT);
    if (savedId) {
      const found = projects.find((p) => p.id === savedId);
      if (found) {
        queueMicrotask(() => {
          setProject(found);
        });
      }
    }
  }, [projects, project]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const match = window.location.pathname.match(/^\/project\/([^/]+)(?:\/task\/([^/]+))?/);
      if (match) {
        const urlProjectId = match[1];
        const urlTaskId = match[2] ?? null;
        const found = projects?.find((p) => p.id === urlProjectId);
        if (found) {
          setProject(found);
          setSelectedTaskId(urlTaskId);
          return;
        }
      }
      setSelectedTaskId(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [projects]);

  const toggleCommandPalette = useCallback(() => setCommandOpen((prev) => !prev), []);
  const dispatchCreateTask = useCallback(
    () => window.dispatchEvent(new CustomEvent("task:create")),
    [],
  );
  useKeyboardShortcut({ key: "KeyK", meta: true }, toggleCommandPalette);
  useKeyboardShortcut({ key: "KeyN", meta: true }, dispatchCreateTask);

  const handleSelectProject = useCallback((p: Project) => {
    setProject(p);
    setRuntimeSettingsOpen(false);
    writeStorage(STORAGE_KEYS.SELECTED_PROJECT, p.id);
    window.history.pushState(null, "", `/project/${p.id}`);
  }, []);

  const handleTaskOpen = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      if (project) {
        window.history.pushState(null, "", `/project/${project.id}/task/${taskId}`);
      }
    },
    [project],
  );

  const toggleDensity = useCallback(() => {
    setDensity((prev) => (prev === "comfortable" ? "compact" : "comfortable"));
  }, []);

  return (
    <div className="app-pattern-bg min-h-screen text-foreground">
      <Header
        selectedProject={project}
        onSelectProject={handleSelectProject}
        onDeselectProject={() => {
          setProject(null);
          setSelectedTaskId(null);
          setRuntimeSettingsOpen(false);
          removeStorage(STORAGE_KEYS.SELECTED_PROJECT);
          window.history.pushState(null, "", "/");
        }}
        onOpenCommandPalette={() => setCommandOpen(true)}
        density={density}
        onDensityChange={setDensity}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        taskMetrics={taskMetrics}
        runtimeProfilesOpen={runtimeSettingsOpen}
        onToggleRuntimeProfiles={() => setRuntimeSettingsOpen((value) => !value)}
      />

      <main className={`mx-auto w-full ${density === "compact" ? "p-4 md:p-5" : "p-6 md:p-8"}`}>
        {project && (
          <ProjectRuntimeSettings
            key={project.id}
            project={project}
            open={runtimeSettingsOpen}
            onOpenChange={setRuntimeSettingsOpen}
            hideTrigger
          />
        )}
        {project ? (
          <Board
            projectId={project.id}
            onTaskClick={handleTaskOpen}
            density={density}
            viewMode={viewMode}
          />
        ) : (
          <div className="flex h-[64vh] items-center justify-center">
            <div className="w-full max-w-xl border border-border bg-card/80 p-8 text-center">
              <p className="text-base font-semibold tracking-tight">// no project selected</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Select or create a project to get started.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Don&apos;t forget to configure runtime profiles in project settings.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button size="sm" onClick={() => setCommandOpen(true)}>
                  Open command palette
                </Button>
                <Button size="sm" variant="outline" onClick={toggleDensity}>
                  Toggle density
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>

      <TaskDetail
        taskId={selectedTaskId}
        onClose={() => {
          setSelectedTaskId(null);
          if (project) {
            window.history.pushState(null, "", `/project/${project.id}`);
          } else {
            window.history.pushState(null, "", "/");
          }
        }}
      />

      {project && (
        <>
          <ChatPanel
            isOpen={chatOpen}
            projectId={project.id}
            taskId={selectedTaskId}
            onClose={() => setChatOpen(false)}
            onOpenTask={(id) => {
              setSelectedTaskId(id);
              setChatOpen(false);
            }}
          />
          <ChatBubble
            isOpen={chatOpen}
            onToggle={() => {
              setChatOpen((prev) => {
                const next = !prev;
                console.debug("[app] Chat", next ? "opened" : "closed");
                return next;
              });
            }}
          />
        </>
      )}

      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        projects={projects ?? []}
        tasks={projectTasks ?? []}
        selectedProjectId={project?.id ?? null}
        density={density}
        theme={theme}
        onSelectProject={handleSelectProject}
        onOpenTask={handleTaskOpen}
        onToggleTheme={toggleTheme}
        onToggleDensity={toggleDensity}
      />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
