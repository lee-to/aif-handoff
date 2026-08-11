import { useState, useCallback, useEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "./components/layout/Header";
import { Board } from "./components/kanban/Board";
import { TaskDetail } from "./components/task/TaskDetail";
import { CommandPalette } from "./components/layout/CommandPalette";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCommitToasts } from "./hooks/useCommitToasts";
import { useProjectTaskOverviews, useProjects } from "./hooks/useProjects";
import { useTasks } from "./hooks/useTasks";
import { useAuth } from "./hooks/useAuth";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";
import { ChatBubble } from "./components/chat/ChatBubble";
import { ChatPanel } from "./components/chat/ChatPanel";
import { calculateOverviewMetrics, calculateTaskMetrics } from "./lib/taskMetrics";
import { readStorage, writeStorage, removeStorage } from "./lib/storage";
import { STORAGE_KEYS } from "./lib/storageKeys";
import type { AuthSessionState, Project } from "@aif/shared/browser";
import { ProjectRuntimeSettings } from "./components/project/ProjectRuntimeSettings";
import { ProjectsOverview } from "./components/project/ProjectsOverview";
import { ToastProvider } from "./components/ui/toast";
import { LoginPage } from "./components/auth/LoginPage";
import { ParticipantManagementDialog } from "./components/participants/ParticipantManagementDialog";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true,
    },
  },
});

const PROJECT_ROUTE_PATTERN = /^\/project\/([^/]+)(?:\/task\/([^/]+))?/;

function readInitialSelection(): { projectId: string | null; taskId: string | null } {
  const match = window.location.pathname.match(PROJECT_ROUTE_PATTERN);
  if (match) {
    return { projectId: match[1] ?? null, taskId: match[2] ?? null };
  }

  return {
    projectId: readStorage(STORAGE_KEYS.SELECTED_PROJECT),
    taskId: null,
  };
}

interface AppContentProps {
  authSession: AuthSessionState;
  onLogout: () => Promise<unknown>;
  isLoggingOut: boolean;
  onChangePassword: (input: { currentPassword: string; newPassword: string }) => Promise<unknown>;
  isChangingPassword: boolean;
}

function AppContent({
  authSession,
  onLogout,
  isLoggingOut,
  onChangePassword,
  isChangingPassword,
}: AppContentProps) {
  useWebSocket(true);
  useCommitToasts();
  const { theme, toggleTheme } = useTheme();
  const { data: projects } = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => readInitialSelection().projectId,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => readInitialSelection().taskId,
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [density, setDensity] = useState<"comfortable" | "compact">(() => {
    const saved = readStorage(STORAGE_KEYS.DENSITY);
    return saved === "compact" ? "compact" : "comfortable";
  });
  const [viewMode, setViewMode] = useState<"kanban" | "list">(() => {
    const saved = readStorage(STORAGE_KEYS.VIEW_MODE);
    return saved === "list" ? "list" : "kanban";
  });
  const project = useMemo(
    () => projects?.find((candidate) => candidate.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const canManageConfiguration =
    !authSession.participantsModeEnabled || authSession.participant?.role === "admin";
  const { data: projectTasks } = useTasks(selectedProjectId);
  const { data: projectTaskOverviews } = useProjectTaskOverviews(!selectedProjectId);
  const taskMetrics = useMemo(
    () =>
      selectedProjectId
        ? calculateTaskMetrics(projectTasks ?? [])
        : calculateOverviewMetrics(projectTaskOverviews ?? []),
    [projectTaskOverviews, projectTasks, selectedProjectId],
  );
  const aggregateProjectTotals = useMemo(() => {
    if (selectedProjectId || !projects?.length) return null;
    return projects.reduce(
      (acc, p) => ({
        tokenInput: acc.tokenInput + (p.tokenInput ?? 0),
        tokenOutput: acc.tokenOutput + (p.tokenOutput ?? 0),
        tokenTotal: acc.tokenTotal + (p.tokenTotal ?? 0),
        costUsd: acc.costUsd + (p.costUsd ?? 0),
      }),
      { tokenInput: 0, tokenOutput: 0, tokenTotal: 0, costUsd: 0 },
    );
  }, [projects, selectedProjectId]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.DENSITY, density);
  }, [density]);

  useEffect(() => {
    writeStorage(STORAGE_KEYS.VIEW_MODE, viewMode);
  }, [viewMode]);

  // Validate restored state after projects load.
  useEffect(() => {
    if (!projects || !selectedProjectId) return;

    const found = projects.find((p) => p.id === selectedProjectId);
    if (found) {
      writeStorage(STORAGE_KEYS.SELECTED_PROJECT, found.id);
      return;
    }

    console.debug("[app] Clearing stale selected project", {
      selectedProjectId,
      reason: "missing_from_projects",
    });

    const clearTimer = window.setTimeout(() => {
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      removeStorage(STORAGE_KEYS.SELECTED_PROJECT);
    }, 0);

    return () => window.clearTimeout(clearTimer);
  }, [projects, selectedProjectId]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const match = window.location.pathname.match(PROJECT_ROUTE_PATTERN);
      if (match) {
        const urlProjectId = match[1];
        const urlTaskId = match[2] ?? null;
        setSelectedProjectId(urlProjectId);
        setSelectedTaskId(urlTaskId);
        return;
      }
      setSelectedProjectId(null);
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
    setSelectedProjectId(p.id);
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
          setSelectedProjectId(null);
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
        aggregateTotals={aggregateProjectTotals}
        runtimeProfilesOpen={runtimeSettingsOpen}
        onToggleRuntimeProfiles={() => setRuntimeSettingsOpen((value) => !value)}
        canManageConfiguration={canManageConfiguration}
        participant={authSession.participant}
        onManageParticipants={() => setParticipantsOpen(true)}
        onLogout={onLogout}
        isLoggingOut={isLoggingOut}
        onChangePassword={onChangePassword}
        isChangingPassword={isChangingPassword}
      />

      <main className={`mx-auto w-full ${density === "compact" ? "p-4 md:p-5" : "p-6 md:p-8"}`}>
        {project && canManageConfiguration && (
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
          <ProjectsOverview projects={projects ?? []} onSelectProject={handleSelectProject} />
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
            key={project.id}
            isOpen={chatOpen}
            projectId={project.id}
            projectName={project.name}
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
        selectedProjectId={selectedProjectId}
        density={density}
        theme={theme}
        onSelectProject={handleSelectProject}
        onOpenTask={handleTaskOpen}
        onToggleTheme={toggleTheme}
        onToggleDensity={toggleDensity}
      />

      {authSession.participant?.role === "admin" && (
        <ParticipantManagementDialog
          open={participantsOpen}
          onOpenChange={setParticipantsOpen}
          currentParticipantId={authSession.participant.id}
        />
      )}
    </div>
  );
}

function AuthenticatedApp() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <main className="app-pattern-bg flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading session...
      </main>
    );
  }

  if (auth.isError) {
    return (
      <main className="app-pattern-bg flex min-h-screen items-center justify-center p-6 text-foreground">
        <Card className="w-full max-w-md space-y-4 p-6">
          <h1 className="font-mono text-lg font-semibold">Session check failed</h1>
          <p className="text-sm text-muted-foreground">
            {auth.error instanceof Error ? auth.error.message : "Authentication is unavailable."}
          </p>
          <Button onClick={() => void auth.refetch()}>Retry</Button>
        </Card>
      </main>
    );
  }

  if (!auth.session) {
    return null;
  }

  if (auth.session.participantsModeEnabled && !auth.session.authenticated) {
    return <LoginPage onLogin={auth.login} isPending={auth.isLoggingIn} />;
  }

  return (
    <AppContent
      authSession={auth.session}
      onLogout={auth.logout}
      isLoggingOut={auth.isLoggingOut}
      onChangePassword={auth.changePassword}
      isChangingPassword={auth.isChangingPassword}
    />
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthenticatedApp />
      </ToastProvider>
    </QueryClientProvider>
  );
}
