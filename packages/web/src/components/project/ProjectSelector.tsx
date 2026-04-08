import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@/hooks/useOutsideClick";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Plus, ChevronDown, Pencil, Trash2, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ListButton } from "@/components/ui/list-button";
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
} from "@/hooks/useProjects";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { Project } from "@aif/shared/browser";

interface Props {
  selectedId: string | null;
  onSelect: (project: Project) => void;
  onDeselect: () => void;
}

type DialogMode = "create" | "edit";

export function ProjectSelector({ selectedId, onSelect, onDeselect }: Props) {
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [plannerMaxBudgetUsd, setPlannerMaxBudgetUsd] = useState("");
  const [planCheckerMaxBudgetUsd, setPlanCheckerMaxBudgetUsd] = useState("");
  const [implementerMaxBudgetUsd, setImplementerMaxBudgetUsd] = useState("");
  const [reviewSidecarMaxBudgetUsd, setReviewSidecarMaxBudgetUsd] = useState("");
  const [parallelEnabled, setParallelEnabled] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  const selected = projects?.find((p) => p.id === selectedId);
  const isEditDialogOpen = dialogOpen && dialogMode === "edit" && !!editingId;
  const { data: mcpData, isLoading: isMcpLoading } = useQuery({
    queryKey: ["project-mcp", editingId],
    queryFn: () => api.getProjectMcp(editingId!),
    enabled: isEditDialogOpen,
    staleTime: 30_000,
  });
  const mcpServers = mcpData?.mcpServers ? Object.keys(mcpData.mcpServers) : [];

  const openCreate = () => {
    setDialogMode("create");
    setEditingId(null);
    setName("");
    setRootPath("");
    setPlannerMaxBudgetUsd("");
    setPlanCheckerMaxBudgetUsd("");
    setImplementerMaxBudgetUsd("");
    setReviewSidecarMaxBudgetUsd("");
    setParallelEnabled(false);
    setDropdownOpen(false);
    setDialogOpen(true);
  };

  const openEdit = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setDialogMode("edit");
    setEditingId(p.id);
    setName(p.name);
    setRootPath(p.rootPath);
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
    setDropdownOpen(false);
    setDialogOpen(true);
  };

  const handleDelete = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${p.name}"?`)) return;
    deleteProject.mutate(p.id, {
      onSuccess: () => {
        if (selectedId === p.id) onDeselect();
      },
    });
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
            onSelect(project);
            setDialogOpen(false);
          },
          onError: (error) => {
            toast(
              error instanceof Error ? error.message : "Failed to create project",
              "error",
              8000,
            );
          },
        },
      );
    } else if (editingId) {
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
          onSuccess: (project) => {
            if (selectedId === editingId) onSelect(project);
            setDialogOpen(false);
          },
        },
      );
    }
  };

  const isPending = createProject.isPending || updateProject.isPending;

  const closeDropdown = useCallback(() => setDropdownOpen(false), []);
  useOutsideClick(selectorRef, closeDropdown, dropdownOpen);

  return (
    <>
      <div className="relative" ref={selectorRef}>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 border-border bg-card/80 hover:bg-accent/60"
          onClick={() => setDropdownOpen(!dropdownOpen)}
        >
          <FolderOpen className="h-4 w-4" />
          {selected?.name ?? "Select project"}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>

        {dropdownOpen && (
          <div className="absolute left-0 top-full z-dropdown mt-2 min-w-[280px] border border-border bg-popover p-1.5">
            {projects?.map((p) => (
              <div
                key={p.id}
                className={`group flex items-center gap-1 text-sm hover:bg-accent ${
                  p.id === selectedId ? "bg-accent" : ""
                }`}
              >
                <ListButton
                  active={p.id === selectedId}
                  className="flex-1 flex-col items-start px-3 py-2"
                  onClick={() => {
                    onSelect(p);
                    setDropdownOpen(false);
                  }}
                >
                  <div className="font-medium tracking-tight">{p.name}</div>
                  <div className="truncate text-2xs text-muted-foreground">{p.rootPath}</div>
                </ListButton>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 border-0 opacity-0 group-hover:opacity-70 hover:!opacity-100"
                  onClick={(e) => openEdit(p, e)}
                  title="Edit"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 border-0 text-destructive opacity-0 group-hover:opacity-70 hover:!opacity-100"
                  onClick={(e) => handleDelete(p, e)}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}

            {projects?.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">// no projects yet</div>
            )}

            <div className="mt-1 border-t border-border pt-1">
              <ListButton onClick={openCreate} className="gap-2 px-3 py-2">
                <Plus className="h-3 w-3" />
                New project
              </ListButton>
            </div>
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
                Absolute path where agents will create files
              </p>
            </div>
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
              </div>
              <Switch checked={parallelEnabled} onCheckedChange={setParallelEnabled} />
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
