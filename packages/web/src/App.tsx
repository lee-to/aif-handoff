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
import { ChatBubble } from "./components/chat/ChatBubble";
import { ChatPanel } from "./components/chat/ChatPanel";
import { Button } from "./components/ui/button";
import { calculateTaskMetrics } from "./lib/taskMetrics";
import { api } from "./lib/api";
import { readStorage, writeStorage, removeStorage } from "./lib/storage";
import { STORAGE_KEYS } from "./lib/storageKeys";
import type { Project } from "@aif/shared/browser";

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
  const [agentReadiness, setAgentReadiness] = useState<{
    ready: boolean;
    hasApiKey: boolean;
    hasClaudeAuth: boolean;
    authSource: "api_key" | "claude_profile" | "both" | "none";
    detectedPath: string | null;
    message: string;
    checkedAt: string;
  } | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyK") {
        event.preventDefault();
        setCommandOpen((prev) => !prev);
      }
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyN") {
        event.preventDefault();
        // Dispatch custom event to trigger task creation
        window.dispatchEvent(new CustomEvent("task:create"));
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchReadiness = async () => {
      try {
        const status = await api.getAgentReadiness();
        if (cancelled) return;
        setAgentReadiness(status);
      } catch (error) {
        if (cancelled) return;
        setAgentReadiness(null);
        console.debug("[app] Agent readiness check failed:", error);
      }
    };

    void fetchReadiness();
    const intervalId = window.setInterval(fetchReadiness, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const handleSelectProject = useCallback((p: Project) => {
    setProject(p);
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
          removeStorage(STORAGE_KEYS.SELECTED_PROJECT);
          window.history.pushState(null, "", "/");
        }}
        onOpenCommandPalette={() => setCommandOpen(true)}
        density={density}
        onDensityChange={setDensity}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        taskMetrics={taskMetrics}
      />

      <main
        className={`mx-auto w-full max-w-[1680px] ${density === "compact" ? "p-4 md:p-5" : "p-6 md:p-8"}`}
      >
        {agentReadiness && !agentReadiness.ready ? (
          <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">
            Claude auth is not configured. Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code>{" "}
            or sign in via Claude Code profile (<code>~/.claude</code>) to run AI stages.
          </div>
        ) : null}
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
                Select or create a project to get started
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
