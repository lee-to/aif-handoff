import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useOutsideClick } from "@/hooks/useOutsideClick";
import { useQuery } from "@tanstack/react-query";
import {
  FolderOpen,
  Plus,
  ChevronDown,
  Pencil,
  Trash2,
  Plug,
  Pin,
  GitPullRequest,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ListButton } from "@/components/ui/list-button";
import { ScrollableContainer } from "@/components/ui/scrollable-container";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useProjects,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useSetAutoQueueMode,
  useProjectTaskOverviews,
  useUpdateProjectOrganization,
  useProjectGitHub,
  useConnectProjectGitHub,
  useDisconnectProjectGitHub,
  useSyncProjectGitHub,
} from "@/hooks/useProjects";
import { useToast } from "@/components/ui/toast";
import { useSettings } from "@/hooks/useSettings";
import { api } from "@/lib/api";
import type { Project } from "@aif/shared/browser";
import { PROJECT_SORT_OPTIONS, sortProjects, type ProjectSort } from "@/lib/projectSorting";

interface Props {
  selectedId: string | null;
  onSelect: (project: Project) => void;
  onDeselect: () => void;
  canManage?: boolean;
}

type DialogMode = "create" | "edit";

export function ProjectSelector({ selectedId, onSelect, onDeselect, canManage = true }: Props) {
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const setAutoQueue = useSetAutoQueueMode();
  const updateOrganization = useUpdateProjectOrganization();
  const connectGitHub = useConnectProjectGitHub();
  const disconnectGitHub = useDisconnectProjectGitHub();
  const syncGitHub = useSyncProjectGitHub();
  const { toast } = useToast();
  const { data: settings } = useSettings();
  const githubIssuePrEnabled = settings?.githubIssuePrEnabled ?? false;

  const showMutationError = (error: unknown, fallback: string) => {
    toast(error instanceof Error ? error.message : fallback, "error", 8000);
  };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("name");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [groupName, setGroupName] = useState("");
  const [plannerMaxBudgetUsd, setPlannerMaxBudgetUsd] = useState("");
  const [planCheckerMaxBudgetUsd, setPlanCheckerMaxBudgetUsd] = useState("");
  const [implementerMaxBudgetUsd, setImplementerMaxBudgetUsd] = useState("");
  const [reviewSidecarMaxBudgetUsd, setReviewSidecarMaxBudgetUsd] = useState("");
  const [parallelEnabled, setParallelEnabled] = useState(false);
  const [autoQueueMode, setAutoQueueModeState] = useState(false);
  const [githubRepository, setGitHubRepository] = useState("");
  const [githubTokenEnvVar, setGitHubTokenEnvVar] = useState("GITHUB_TOKEN");
  const [githubLabels, setGitHubLabels] = useState("");
  const [githubAssignee, setGitHubAssignee] = useState("");
  const [githubMilestone, setGitHubMilestone] = useState("");
  const selectorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const projectItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listboxId = useId();

  const selected = projects?.find((p) => p.id === selectedId);
  const { data: projectTaskOverviews } = useProjectTaskOverviews(dropdownOpen);
  const overviewByProjectId = useMemo(
    () => new Map((projectTaskOverviews ?? []).map((overview) => [overview.projectId, overview])),
    [projectTaskOverviews],
  );
  const filteredProjects = useMemo(() => {
    const normalizedQuery = projectQuery.trim().toLocaleLowerCase();
    const matchingProjects = normalizedQuery
      ? (projects ?? []).filter((project) =>
          `${project.name} ${project.rootPath}`.toLocaleLowerCase().includes(normalizedQuery),
        )
      : (projects ?? []);
    return sortProjects(matchingProjects, projectSort, overviewByProjectId);
  }, [overviewByProjectId, projectQuery, projectSort, projects]);
  const projectSections = useMemo(() => {
    const pinned = filteredProjects.filter((project) => project.pinnedAt != null);
    const unpinned = filteredProjects.filter((project) => project.pinnedAt == null);
    const grouped = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const project of unpinned) {
      const normalizedGroup = project.groupName?.trim();
      if (!normalizedGroup) {
        ungrouped.push(project);
        continue;
      }
      const group = grouped.get(normalizedGroup) ?? [];
      group.push(project);
      grouped.set(normalizedGroup, group);
    }

    return [
      ...(pinned.length > 0 ? [{ key: "system:pinned", label: "Pinned", projects: pinned }] : []),
      ...[...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" }))
        .map(([label, groupProjects]) => ({
          key: `group:${label}`,
          label,
          projects: groupProjects,
        })),
      ...(ungrouped.length > 0
        ? [
            {
              key: "system:ungrouped",
              label: grouped.size > 0 ? "Other" : null,
              projects: ungrouped,
            },
          ]
        : []),
    ];
  }, [filteredProjects]);
  const visibleProjects = useMemo(
    () => projectSections.flatMap((section) => section.projects),
    [projectSections],
  );
  const projectIndexById = useMemo(
    () => new Map(visibleProjects.map((project, index) => [project.id, index])),
    [visibleProjects],
  );
  const storedActiveProjectIndex =
    activeProjectId == null ? undefined : projectIndexById.get(activeProjectId);
  const fallbackActiveProjectId = visibleProjects[0]?.id ?? null;
  const activeProjectIndex = storedActiveProjectIndex ?? (visibleProjects.length > 0 ? 0 : -1);
  const activeProject = activeProjectIndex >= 0 ? visibleProjects[activeProjectIndex] : undefined;
  if (activeProjectId !== null && storedActiveProjectIndex === undefined) {
    setActiveProjectId(fallbackActiveProjectId);
  }
  const projectOptionId = (projectId: string) => `${listboxId}-option-${projectId}`;
  const isEditDialogOpen = dialogOpen && dialogMode === "edit" && !!editingId;
  const { data: githubData, isLoading: isGitHubLoading } = useProjectGitHub(
    editingId,
    isEditDialogOpen && githubIssuePrEnabled,
  );
  const { data: mcpData, isLoading: isMcpLoading } = useQuery({
    queryKey: ["project-mcp", editingId],
    queryFn: () => api.getProjectMcp(editingId!),
    enabled: isEditDialogOpen,
    staleTime: 30_000,
  });
  const mcpServers = mcpData?.mcpServers ? Object.keys(mcpData.mcpServers) : [];
  const githubConnection = githubData?.connection ?? null;

  useEffect(() => {
    if (!isEditDialogOpen || !githubData) return;
    const connection = githubData.connection;
    const timeout = window.setTimeout(() => {
      setGitHubRepository(connection ? `${connection.owner}/${connection.name}` : "");
      setGitHubTokenEnvVar(connection?.tokenEnvVar ?? "GITHUB_TOKEN");
      setGitHubLabels(connection?.eligibility.labels.join(", ") ?? "");
      setGitHubAssignee(connection?.eligibility.assignee ?? "");
      setGitHubMilestone(connection?.eligibility.milestone ?? "");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [githubData, isEditDialogOpen]);

  const openCreate = () => {
    if (!canManage) return;
    setDialogMode("create");
    setEditingId(null);
    setName("");
    setRootPath("");
    setGroupName("");
    setPlannerMaxBudgetUsd("");
    setPlanCheckerMaxBudgetUsd("");
    setImplementerMaxBudgetUsd("");
    setReviewSidecarMaxBudgetUsd("");
    setParallelEnabled(false);
    setAutoQueueModeState(false);
    setGitHubRepository("");
    setGitHubTokenEnvVar("GITHUB_TOKEN");
    setGitHubLabels("");
    setGitHubAssignee("");
    setGitHubMilestone("");
    setDropdownOpen(false);
    setProjectQuery("");
    setActiveProjectId(null);
    setDialogOpen(true);
  };

  const openEdit = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canManage) return;
    setDialogMode("edit");
    setEditingId(p.id);
    setName(p.name);
    setRootPath(p.rootPath);
    setGroupName(p.groupName ?? "");
    setPlannerMaxBudgetUsd(p.plannerMaxBudgetUsd == null ? "" : String(p.plannerMaxBudgetUsd));
    setPlanCheckerMaxBudgetUsd(
      p.planCheckerMaxBudgetUsd == null ? "" : String(p.planCheckerMaxBudgetUsd),
    );
    setImplementerMaxBudgetUsd(
      p.implementerMaxBudgetUsd == null ? "" : String(p.implementerMaxBudgetUsd),
    );
    setReviewSidecarMaxBudgetUsd(
      p.reviewSidecarMaxBudgetUsd == null ? "" : String(p.reviewSidecarMaxBudgetUsd),
    );
    setParallelEnabled(p.parallelEnabled ?? false);
    setAutoQueueModeState(p.autoQueueMode ?? false);
    setGitHubRepository("");
    setGitHubTokenEnvVar("GITHUB_TOKEN");
    setGitHubLabels("");
    setGitHubAssignee("");
    setGitHubMilestone("");
    setDropdownOpen(false);
    setProjectQuery("");
    setActiveProjectId(null);
    setDialogOpen(true);
  };

  const handleDelete = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canManage) return;
    if (!confirm(`Delete project "${p.name}"?`)) return;
    deleteProject.mutate(p.id, {
      onSuccess: () => {
        if (selectedId === p.id) onDeselect();
      },
    });
  };

  const handleConnectGitHub = () => {
    if (!editingId || !githubRepository.trim() || !githubTokenEnvVar.trim()) return;
    connectGitHub.mutate(
      {
        id: editingId,
        input: {
          repository: githubRepository.trim(),
          tokenEnvVar: githubTokenEnvVar.trim(),
          enabled: true,
          eligibility: {
            labels: githubLabels
              .split(",")
              .map((label) => label.trim())
              .filter(Boolean),
            assignee: githubAssignee.trim() || null,
            milestone: githubMilestone.trim() || null,
          },
        },
      },
      {
        onSuccess: () => toast("GitHub repository connected", "success"),
        onError: (error) => showMutationError(error, "Failed to connect GitHub repository"),
      },
    );
  };

  const handleSyncGitHub = () => {
    if (!editingId) return;
    syncGitHub.mutate(editingId, {
      onSuccess: (result) =>
        toast(
          `GitHub sync complete: ${result.imported} imported, ${result.updated} updated`,
          "success",
        ),
      onError: (error) => showMutationError(error, "Failed to synchronize GitHub repository"),
    });
  };

  const handleDisconnectGitHub = () => {
    if (!editingId) return;
    disconnectGitHub.mutate(editingId, {
      onSuccess: () => toast("GitHub repository disconnected", "success"),
      onError: (error) => showMutationError(error, "Failed to disconnect GitHub repository"),
    });
  };

  const handlePin = (project: Project, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!canManage) return;
    updateOrganization.mutate(
      { id: project.id, input: { pinned: project.pinnedAt == null } },
      {
        onError: (error) => showMutationError(error, "Failed to update project pin"),
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    const parsedPlannerBudget = plannerMaxBudgetUsd.trim()
      ? Number(plannerMaxBudgetUsd)
      : undefined;
    const parsedPlanCheckerBudget = planCheckerMaxBudgetUsd.trim()
      ? Number(planCheckerMaxBudgetUsd)
      : undefined;
    const parsedImplementerBudget = implementerMaxBudgetUsd.trim()
      ? Number(implementerMaxBudgetUsd)
      : undefined;
    const parsedBudget = reviewSidecarMaxBudgetUsd.trim()
      ? Number(reviewSidecarMaxBudgetUsd)
      : undefined;
    const invalidBudget = (value: number | undefined) =>
      value !== undefined && (!Number.isFinite(value) || value <= 0);
    if (
      invalidBudget(parsedPlannerBudget) ||
      invalidBudget(parsedPlanCheckerBudget) ||
      invalidBudget(parsedImplementerBudget) ||
      invalidBudget(parsedBudget)
    ) {
      return;
    }

    if (dialogMode === "create") {
      createProject.mutate(
        {
          name: name.trim(),
          rootPath: rootPath.trim(),
          plannerMaxBudgetUsd: parsedPlannerBudget,
          planCheckerMaxBudgetUsd: parsedPlanCheckerBudget,
          implementerMaxBudgetUsd: parsedImplementerBudget,
          reviewSidecarMaxBudgetUsd: parsedBudget,
          parallelEnabled,
        },
        {
          onSuccess: (project) => {
            if (autoQueueMode) {
              setAutoQueue.mutate(
                { id: project.id, enabled: true },
                {
                  onError: (error) => showMutationError(error, "Failed to enable auto-queue mode"),
                },
              );
            }
            onSelect(project);
            setDialogOpen(false);
          },
          onError: (error) => {
            showMutationError(error, "Failed to create project");
          },
        },
      );
    } else if (editingId) {
      // Look up the project being edited, NOT the currently selected one —
      // edit dialog can be opened for a non-selected project from the picker.
      const editingProject = projects?.find((p) => p.id === editingId);
      const previousAutoQueue = editingProject?.autoQueueMode ?? false;
      updateProject.mutate(
        {
          id: editingId,
          input: {
            name: name.trim(),
            rootPath: rootPath.trim(),
            plannerMaxBudgetUsd: parsedPlannerBudget,
            planCheckerMaxBudgetUsd: parsedPlanCheckerBudget,
            implementerMaxBudgetUsd: parsedImplementerBudget,
            reviewSidecarMaxBudgetUsd: parsedBudget,
            parallelEnabled,
          },
        },
        {
          onSuccess: () => {
            const normalizedGroupName = groupName.trim() || null;
            const groupChanged = normalizedGroupName !== (editingProject?.groupName ?? null);
            if (groupChanged) {
              console.debug("[FIX:pr-150] Updating project group", {
                projectId: editingId,
                groupName: normalizedGroupName,
              });
              updateOrganization.mutate(
                { id: editingId, input: { groupName: normalizedGroupName } },
                {
                  onSuccess: () => {
                    console.debug("[FIX:pr-150] Project group updated without navigation", {
                      projectId: editingId,
                      groupName: normalizedGroupName,
                    });
                  },
                  onError: (error) => {
                    console.error("[FIX:pr-150] Failed to update project group", {
                      projectId: editingId,
                      groupName: normalizedGroupName,
                      error,
                    });
                    showMutationError(error, "Project saved, but its group could not be updated");
                  },
                },
              );
            }
            if (autoQueueMode !== previousAutoQueue) {
              setAutoQueue.mutate(
                { id: editingId, enabled: autoQueueMode },
                {
                  onError: (error) => showMutationError(error, "Failed to update auto-queue mode"),
                },
              );
            }
            setDialogOpen(false);
          },
          onError: (error) => {
            showMutationError(error, "Failed to update project");
          },
        },
      );
    }
  };

  const isPending =
    createProject.isPending || updateProject.isPending || updateOrganization.isPending;

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false);
    setProjectQuery("");
    setActiveProjectId(null);
  }, []);
  useOutsideClick(selectorRef, closeDropdown, dropdownOpen);

  const closeDropdownAndRestoreFocus = useCallback(() => {
    closeDropdown();
    triggerRef.current?.focus();
  }, [closeDropdown]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen || activeProjectIndex < 0) return;
    projectItemRefs.current[activeProjectIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeProject?.id, activeProjectIndex, dropdownOpen]);

  const selectProject = (project: Project) => {
    onSelect(project);
    closeDropdown();
  };

  const handleProjectSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDropdownAndRestoreFocus();
      return;
    }
    if (visibleProjects.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextProject = visibleProjects[(activeProjectIndex + 1) % visibleProjects.length];
      setActiveProjectId(nextProject.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previousIndex =
        (activeProjectIndex - 1 + visibleProjects.length) % visibleProjects.length;
      setActiveProjectId(visibleProjects[previousIndex].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeProject) selectProject(activeProject);
    }
  };

  const handleDropdownKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeDropdownAndRestoreFocus();
  };

  return (
    <>
      <div className="relative" ref={selectorRef}>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="gap-2 border-border bg-card/80 hover:bg-accent/60"
          aria-expanded={dropdownOpen}
          aria-haspopup="listbox"
          onClick={() => {
            if (dropdownOpen) closeDropdown();
            else setDropdownOpen(true);
          }}
        >
          <FolderOpen className="h-4 w-4" />
          {selected?.name ?? "Select project"}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>

        {dropdownOpen && (
          <div
            className="absolute left-0 top-full z-dropdown mt-2 w-[360px] max-w-[calc(100vw-2rem)] border border-border bg-popover p-1.5 text-popover-foreground"
            onKeyDown={handleDropdownKeyDown}
          >
            <div className="space-y-1.5 p-1">
              <Input
                ref={searchInputRef}
                value={projectQuery}
                onChange={(event) => {
                  setProjectQuery(event.target.value);
                }}
                onKeyDown={handleProjectSearchKeyDown}
                placeholder="Search projects or paths..."
                role="combobox"
                aria-label="Search projects"
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded={dropdownOpen}
                aria-activedescendant={
                  activeProject ? projectOptionId(activeProject.id) : undefined
                }
                inputSize="sm"
              />
              <Select
                value={projectSort}
                options={[...PROJECT_SORT_OPTIONS]}
                onChange={(event) => {
                  setProjectSort(event.target.value as ProjectSort);
                }}
                selectSize="sm"
                className="w-full"
              />
            </div>

            <ScrollableContainer maxHeight="max-h-[60vh]" className="mt-1">
              <div id={listboxId} role="listbox" aria-label="Projects">
                {projectSections.map((section) => (
                  <div key={section.key}>
                    {section.label && (
                      <div className="px-3 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.label}
                      </div>
                    )}
                    {section.projects.map((project) => {
                      const projectIndex = projectIndexById.get(project.id) ?? 0;
                      const isKeyboardSelected = project.id === activeProject?.id;
                      return (
                        <div
                          key={project.id}
                          className={`group flex items-center gap-1 text-sm hover:bg-accent ${
                            project.id === selectedId ? "bg-accent" : ""
                          }`}
                        >
                          <ListButton
                            id={projectOptionId(project.id)}
                            ref={(element) => {
                              projectItemRefs.current[projectIndex] = element;
                            }}
                            active={project.id === selectedId || isKeyboardSelected}
                            className="min-w-0 flex-1 flex-col items-start px-3 py-2"
                            onClick={() => selectProject(project)}
                            role="option"
                            aria-selected={project.id === selectedId}
                            tabIndex={-1}
                          >
                            <div className="flex w-full items-center gap-1.5">
                              {project.pinnedAt && <Pin className="h-3 w-3 shrink-0" />}
                              <span className="truncate font-medium tracking-tight">
                                {project.name}
                              </span>
                            </div>
                            <div className="w-full truncate text-2xs text-muted-foreground">
                              {project.rootPath}
                            </div>
                          </ListButton>
                          {canManage && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={`h-6 w-6 border-0 hover:!opacity-100 ${
                                  project.pinnedAt
                                    ? "opacity-70"
                                    : "opacity-0 group-hover:opacity-70 group-focus-within:opacity-70"
                                }`}
                                onClick={(event) => handlePin(project, event)}
                                title={project.pinnedAt ? "Unpin" : "Pin"}
                                aria-pressed={project.pinnedAt != null}
                              >
                                <Pin className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 border-0 opacity-0 group-hover:opacity-70 group-focus-within:opacity-70 hover:!opacity-100"
                                onClick={(event) => openEdit(project, event)}
                                title="Edit"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 border-0 text-destructive opacity-0 group-hover:opacity-70 group-focus-within:opacity-70 hover:!opacity-100"
                                onClick={(event) => handleDelete(project, event)}
                                title="Delete"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                {filteredProjects.length === 0 && (
                  <div className="px-3 py-3 text-sm text-muted-foreground">
                    {projects?.length === 0 ? "// no projects yet" : "No matching projects"}
                  </div>
                )}
              </div>
            </ScrollableContainer>

            {canManage && (
              <div className="mt-1 border-t border-border pt-1">
                <ListButton onClick={openCreate} className="gap-2 px-3 py-2">
                  <Plus className="h-3 w-3" />
                  New project
                </ListButton>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogClose onClose={() => setDialogOpen(false)} />
          <DialogHeader>
            <DialogTitle>{dialogMode === "create" ? "Create Project" : "Edit Project"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="My Project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium">Root Path</label>
              <Input
                placeholder="/Users/me/projects/my-project"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Absolute path where agents will create files. In Docker, paths are stored under
                PROJECTS_MOUNT; host paths under PROJECTS_DIR use the same mount.
              </p>
            </div>
            {dialogMode === "edit" && githubIssuePrEnabled && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-sm font-medium">
                    <GitPullRequest className="h-3.5 w-3.5" />
                    GitHub Issue-to-PR
                  </label>
                  {githubConnection && (
                    <Badge variant="outline" size="sm">
                      {githubConnection.tokenConfigured ? "Connected" : "Token missing"}
                    </Badge>
                  )}
                </div>
                <div className="space-y-2 border border-border bg-card/50 p-3">
                  {isGitHubLoading ? (
                    <p className="text-xs text-muted-foreground">Loading GitHub settings...</p>
                  ) : (
                    <>
                      <Input
                        placeholder="owner/repository"
                        aria-label="GitHub repository"
                        value={githubRepository}
                        onChange={(event) => setGitHubRepository(event.target.value)}
                      />
                      <Input
                        placeholder="GITHUB_TOKEN"
                        aria-label="GitHub token environment variable"
                        className="font-mono text-sm"
                        value={githubTokenEnvVar}
                        onChange={(event) => setGitHubTokenEnvVar(event.target.value)}
                      />
                      <Input
                        placeholder="Required labels, comma-separated"
                        aria-label="GitHub issue labels"
                        value={githubLabels}
                        onChange={(event) => setGitHubLabels(event.target.value)}
                      />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          placeholder="Assignee (optional)"
                          aria-label="GitHub issue assignee"
                          value={githubAssignee}
                          onChange={(event) => setGitHubAssignee(event.target.value)}
                        />
                        <Input
                          placeholder="Milestone (optional)"
                          aria-label="GitHub issue milestone"
                          value={githubMilestone}
                          onChange={(event) => setGitHubMilestone(event.target.value)}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        The server reads the token from this environment variable; the token is
                        never stored in the database.
                      </p>
                      {githubConnection?.syncError && (
                        <p className="text-xs text-destructive">{githubConnection.syncError}</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleConnectGitHub}
                          disabled={
                            connectGitHub.isPending ||
                            !githubRepository.trim() ||
                            !githubTokenEnvVar.trim()
                          }
                        >
                          {connectGitHub.isPending
                            ? "Connecting..."
                            : githubConnection
                              ? "Update connection"
                              : "Connect"}
                        </Button>
                        {githubConnection && (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={handleSyncGitHub}
                              disabled={syncGitHub.isPending}
                            >
                              {syncGitHub.isPending ? "Syncing..." : "Sync now"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={handleDisconnectGitHub}
                              disabled={disconnectGitHub.isPending}
                            >
                              Disconnect
                            </Button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {dialogMode === "edit" && (
              <div>
                <label className="text-sm font-medium">Group</label>
                <Input
                  placeholder="Optional product or team"
                  value={groupName}
                  maxLength={100}
                  onChange={(event) => setGroupName(event.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Projects with the same group appear together in the picker.
                </p>
              </div>
            )}
            <div>
              <label className="text-sm font-medium">Planner Budget (USD)</label>
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Leave empty for unlimited"
                value={plannerMaxBudgetUsd}
                onChange={(e) => setPlannerMaxBudgetUsd(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Plan Checker Budget (USD)</label>
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Leave empty for unlimited"
                value={planCheckerMaxBudgetUsd}
                onChange={(e) => setPlanCheckerMaxBudgetUsd(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Implementer Budget (USD)</label>
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Leave empty for unlimited"
                value={implementerMaxBudgetUsd}
                onChange={(e) => setImplementerMaxBudgetUsd(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Review Sidecar Budget (USD)</label>
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Leave empty for unlimited"
                value={reviewSidecarMaxBudgetUsd}
                onChange={(e) => setReviewSidecarMaxBudgetUsd(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Per-sidecar budget for review and security agents. Empty means unlimited.
              </p>
            </div>
            <div className="flex items-center justify-between border border-border bg-card/50 p-3">
              <div>
                <label className="text-sm font-medium">Parallel Execution</label>
                <p className="text-xs text-muted-foreground">
                  Experimental. Process multiple tasks per stage concurrently.
                </p>
                {parallelEnabled && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Branch-isolated projects need{" "}
                    <code className="font-mono">AIF_TASK_WORKTREES_ENABLED=true</code> on the server
                    to run parallel tasks in isolated worktrees.
                  </p>
                )}
              </div>
              <Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />
            </div>
            <div className="flex items-center justify-between border border-border bg-card/50 p-3">
              <div>
                <label className="text-sm font-medium">Auto-Queue Mode</label>
                <p className="text-xs text-muted-foreground">
                  When enabled, the coordinator advances backlog tasks (by position) into planning
                  automatically. Sequential projects start the next task only after the previous
                  reaches done. Parallel-enabled projects fill the pipeline up to the
                  parallel-execution cap.
                </p>
              </div>
              <Switch checked={autoQueueMode} onCheckedChange={setAutoQueueModeState} />
            </div>
            {dialogMode === "edit" && (
              <div>
                <label className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Plug className="h-3.5 w-3.5" />
                  MCP Servers
                </label>
                <div className="border border-border bg-card/50 p-2">
                  {isMcpLoading && (
                    <p className="text-xs text-muted-foreground">Loading MCP servers...</p>
                  )}
                  {!isMcpLoading && mcpServers.length === 0 && (
                    <p className="text-xs text-muted-foreground">No MCP servers configured.</p>
                  )}
                  {!isMcpLoading && mcpServers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {mcpServers.map((serverName) => (
                        <Badge key={serverName} variant="outline" size="sm">
                          {serverName}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <Button
              type="submit"
              disabled={
                !name.trim() ||
                !rootPath.trim() ||
                (plannerMaxBudgetUsd.trim() !== "" &&
                  (!Number.isFinite(Number(plannerMaxBudgetUsd)) ||
                    Number(plannerMaxBudgetUsd) <= 0)) ||
                (planCheckerMaxBudgetUsd.trim() !== "" &&
                  (!Number.isFinite(Number(planCheckerMaxBudgetUsd)) ||
                    Number(planCheckerMaxBudgetUsd) <= 0)) ||
                (implementerMaxBudgetUsd.trim() !== "" &&
                  (!Number.isFinite(Number(implementerMaxBudgetUsd)) ||
                    Number(implementerMaxBudgetUsd) <= 0)) ||
                (reviewSidecarMaxBudgetUsd.trim() !== "" &&
                  (!Number.isFinite(Number(reviewSidecarMaxBudgetUsd)) ||
                    Number(reviewSidecarMaxBudgetUsd) <= 0)) ||
                isPending
              }
            >
              {isPending
                ? dialogMode === "create"
                  ? "Creating..."
                  : "Saving..."
                : dialogMode === "create"
                  ? "Create"
                  : "Save"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
