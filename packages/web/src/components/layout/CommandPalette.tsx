import { useMemo, useState, useRef, useEffect, type KeyboardEvent } from "react";
import type { Project, TaskListItem } from "@aif/shared/browser";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ListButton } from "@/components/ui/list-button";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  tasks: TaskListItem[];
  selectedProjectId: string | null;
  density: "comfortable" | "compact";
  theme: "dark" | "light";
  onSelectProject: (project: Project) => void;
  onOpenTask: (taskId: string) => void;
  onToggleTheme: () => void;
  onToggleDensity: () => void;
}

type PaletteAction = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  tasks,
  selectedProjectId,
  density,
  theme,
  onSelectProject,
  onOpenTask,
  onToggleTheme,
  onToggleDensity,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const actions = useMemo<PaletteAction[]>(() => {
    const baseActions: PaletteAction[] = [
      {
        id: "toggle-theme",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        hint: "Theme",
        run: () => {
          onToggleTheme();
          onOpenChange(false);
        },
      },
      {
        id: "toggle-density",
        label: `Switch to ${density === "comfortable" ? "compact" : "comfortable"} density`,
        hint: "Layout",
        run: () => {
          onToggleDensity();
          onOpenChange(false);
        },
      },
    ];

    const projectActions = projects.map((project) => ({
      id: `project-${project.id}`,
      label:
        project.id === selectedProjectId
          ? `Project: ${project.name} (current)`
          : `Project: ${project.name}`,
      hint: "Project",
      run: () => {
        onSelectProject(project);
        onOpenChange(false);
      },
    }));

    const taskActions = tasks.slice(0, 60).map((task) => ({
      id: `task-${task.id}`,
      label: `Task: ${task.title}`,
      hint: task.status,
      run: () => {
        onOpenTask(task.id);
        onOpenChange(false);
      },
    }));

    return [...baseActions, ...projectActions, ...taskActions];
  }, [
    density,
    onOpenChange,
    onOpenTask,
    onSelectProject,
    onToggleDensity,
    onToggleTheme,
    projects,
    selectedProjectId,
    tasks,
    theme,
  ]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        action.hint.toLowerCase().includes(normalized),
    );
  }, [actions, query]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedItem = itemsRef.current[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selectedIndex]?.run();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setQuery("");
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl p-0">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader className="mb-0 border-b border-border p-4">
          <DialogTitle>Command Palette</DialogTitle>
        </DialogHeader>

        <div className="border-b border-border p-3">
          <Input
            placeholder="Search tasks, projects, or commands..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2" role="listbox">
          {filtered.length === 0 ? (
            <div className="border border-dashed border-border p-4 text-sm text-muted-foreground">
              No matching commands
            </div>
          ) : (
            filtered.map((action, index) => (
              <ListButton
                ref={(el) => {
                  itemsRef.current[index] = el;
                }}
                key={action.id}
                active={index === selectedIndex}
                className="mb-1 justify-between border border-transparent px-3 py-2 hover:border-border hover:bg-accent/40"
                onClick={action.run}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span className="truncate">{action.label}</span>
                <span className="ml-3 shrink-0 font-mono text-3xs uppercase tracking-wider text-muted-foreground">
                  {action.hint}
                </span>
              </ListButton>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
