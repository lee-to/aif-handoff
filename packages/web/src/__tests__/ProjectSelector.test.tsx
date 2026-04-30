import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mockUseQuery = vi.fn();
const mutateCreateProject = vi.fn();
const mutateUpdateProject = vi.fn();
const mutateDeleteProject = vi.fn();
const mutateSetAutoQueue = vi.fn();
const mockToast = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    data: [
      {
        id: "p-1",
        name: "Alpha",
        rootPath: "/tmp/alpha",
        plannerMaxBudgetUsd: null,
        planCheckerMaxBudgetUsd: null,
        implementerMaxBudgetUsd: null,
        reviewSidecarMaxBudgetUsd: null,
      },
    ],
  }),
  useCreateProject: () => ({
    mutate: mutateCreateProject,
    isPending: false,
  }),
  useUpdateProject: () => ({
    mutate: mutateUpdateProject,
    isPending: false,
  }),
  useDeleteProject: () => ({
    mutate: mutateDeleteProject,
  }),
  useSetAutoQueueMode: () => ({
    mutate: mutateSetAutoQueue,
    isPending: false,
  }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { ProjectSelector } = await import("@/components/project/ProjectSelector");

describe("ProjectSelector", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mutateCreateProject.mockReset();
    mutateUpdateProject.mockReset();
    mutateDeleteProject.mockReset();
    mutateSetAutoQueue.mockReset();
    mockToast.mockReset();
  });

  it("shows MCP servers in edit modal", () => {
    mockUseQuery.mockImplementation((options: { enabled?: boolean }) => {
      if (!options.enabled) {
        return { data: undefined, isLoading: false };
      }

      return {
        data: { mcpServers: { github: {}, postgres: {} } },
        isLoading: false,
      };
    });

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByTitle("Edit"));

    expect(screen.getByText("Edit Project")).toBeDefined();
    expect(screen.getByText("MCP Servers")).toBeDefined();
    expect(screen.getByText("github")).toBeDefined();
    expect(screen.getByText("postgres")).toBeDefined();
  });

  it("does not show MCP section in create modal", () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
    });

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByText("New project"));

    expect(screen.getByText("Create Project")).toBeDefined();
    expect(screen.queryByText("MCP Servers")).toBeNull();
  });

  it("shows error toast when project creation fails", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    mutateCreateProject.mockImplementation(
      (_input: unknown, options: { onError?: (error: Error) => void }) => {
        options.onError?.(new Error("Project initialization failed: ai-factory init not found"));
      },
    );

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);

    // Open create dialog
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByText("New project"));

    // Fill form
    fireEvent.change(screen.getByPlaceholderText("My Project"), {
      target: { value: "Test Project" },
    });
    fireEvent.change(screen.getByPlaceholderText("/Users/me/projects/my-project"), {
      target: { value: "/tmp/test-project" },
    });

    // Submit
    fireEvent.click(screen.getByText("Create"));

    expect(mockToast).toHaveBeenCalledWith(
      "Project initialization failed: ai-factory init not found",
      "error",
      8000,
    );
  });

  it("shows error toast when project update fails", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    mutateUpdateProject.mockImplementation(
      (_input: unknown, options: { onError?: (error: Error) => void }) => {
        options.onError?.(
          new Error("Parallel auto-queue with git.create_branches=true is not supported"),
        );
      },
    );

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByTitle("Edit"));
    fireEvent.click(screen.getByText("Save"));

    expect(mockToast).toHaveBeenCalledWith(
      "Parallel auto-queue with git.create_branches=true is not supported",
      "error",
      8000,
    );
  });

  describe("auto-queue toggle", () => {
    it("renders Auto-Queue Mode switch in create dialog", () => {
      mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
      render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
      fireEvent.click(screen.getByText("New project"));

      expect(screen.getByText("Auto-Queue Mode")).toBeDefined();
      expect(
        screen.getByText(
          /Sequential projects start the next task only after the previous reaches done/i,
        ),
      ).toBeDefined();
    });

    it("appears alongside Parallel Execution in the same dialog", () => {
      mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
      render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
      fireEvent.click(screen.getByText("New project"));

      expect(screen.getByText("Parallel Execution")).toBeDefined();
      expect(screen.getByText("Auto-Queue Mode")).toBeDefined();
    });

    it("shows the worktree rollout flag hint when parallel execution is enabled", () => {
      mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
      render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
      fireEvent.click(screen.getByText("New project"));

      fireEvent.click(screen.getAllByRole("switch")[0]);

      expect(screen.getByText(/AIF_TASK_WORKTREES_ENABLED=true/i)).toBeDefined();
    });

    it("shows error toast when enabling auto-queue fails after create", () => {
      mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
      mutateCreateProject.mockImplementation(
        (_input: unknown, options: { onSuccess?: (project: { id: string }) => void }) => {
          options.onSuccess?.({ id: "created-project" });
        },
      );
      mutateSetAutoQueue.mockImplementation(
        (_input: unknown, options: { onError?: (error: Error) => void }) => {
          options.onError?.(
            new Error("Parallel auto-queue with git.create_branches=true is not supported"),
          );
        },
      );

      render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
      fireEvent.click(screen.getByText("New project"));
      fireEvent.change(screen.getByPlaceholderText("My Project"), {
        target: { value: "Test Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/me/projects/my-project"), {
        target: { value: "/tmp/test-project" },
      });
      fireEvent.click(screen.getAllByRole("switch")[1]);
      fireEvent.click(screen.getByText("Create"));

      expect(mockToast).toHaveBeenCalledWith(
        "Parallel auto-queue with git.create_branches=true is not supported",
        "error",
        8000,
      );
    });
  });
});
