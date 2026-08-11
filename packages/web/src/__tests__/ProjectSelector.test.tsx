import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@aif/shared/browser";

const mockUseQuery = vi.fn();
const mutateCreateProject = vi.fn();
const mutateUpdateProject = vi.fn();
const mutateDeleteProject = vi.fn();
const mutateSetAutoQueue = vi.fn();
const mutateUpdateOrganization = vi.fn();
const mutateConnectGitHub = vi.fn();
const mutateDisconnectGitHub = vi.fn();
const mutateSyncGitHub = vi.fn();
const mockToast = vi.fn();
let mockGitHubIssuePrEnabled = true;
let mockProjects = [
  {
    id: "p-1",
    name: "Alpha",
    rootPath: "/tmp/alpha",
    plannerMaxBudgetUsd: null,
    planCheckerMaxBudgetUsd: null,
    implementerMaxBudgetUsd: null,
    reviewSidecarMaxBudgetUsd: null,
    pinnedAt: null as string | null,
    groupName: null as string | null,
  },
];

Element.prototype.scrollIntoView = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    data: mockProjects,
  }),
  useProjectTaskOverviews: () => ({ data: [], isLoading: false }),
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
  useUpdateProjectOrganization: () => ({
    mutate: mutateUpdateOrganization,
    isPending: false,
  }),
  useProjectGitHub: () => ({ data: { connection: null, issues: [] }, isLoading: false }),
  useConnectProjectGitHub: () => ({ mutate: mutateConnectGitHub, isPending: false }),
  useDisconnectProjectGitHub: () => ({ mutate: mutateDisconnectGitHub, isPending: false }),
  useSyncProjectGitHub: () => ({ mutate: mutateSyncGitHub, isPending: false }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: { githubIssuePrEnabled: mockGitHubIssuePrEnabled } }),
}));

const { ProjectSelector } = await import("@/components/project/ProjectSelector");

describe("ProjectSelector", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mutateCreateProject.mockReset();
    mutateUpdateProject.mockReset();
    mutateDeleteProject.mockReset();
    mutateSetAutoQueue.mockReset();
    mutateUpdateOrganization.mockReset();
    mutateConnectGitHub.mockReset();
    mutateDisconnectGitHub.mockReset();
    mutateSyncGitHub.mockReset();
    mockToast.mockReset();
    mockGitHubIssuePrEnabled = true;
    mockProjects = [
      {
        id: "p-1",
        name: "Alpha",
        rootPath: "/tmp/alpha",
        plannerMaxBudgetUsd: null,
        planCheckerMaxBudgetUsd: null,
        implementerMaxBudgetUsd: null,
        reviewSidecarMaxBudgetUsd: null,
        pinnedAt: null as string | null,
        groupName: null as string | null,
      },
    ];
  });

  it("searches projects by name and root path in a bounded dropdown", async () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      ...mockProjects,
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Translator Android",
        rootPath: "/workspace/mobile/android",
      },
      {
        ...mockProjects[0],
        id: "p-3",
        name: "Storage Radar",
        rootPath: "/workspace/storage/mac",
      },
    ];

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

    const search = screen.getByRole("combobox", { name: "Search projects" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByRole("listbox").parentElement?.className).toContain("max-h-[60vh]");
    expect(screen.getByRole("listbox").parentElement?.className).toContain("overflow-y-auto");

    fireEvent.change(search, { target: { value: "translator" } });
    expect(screen.getByText("Translator Android")).toBeDefined();
    expect(screen.queryByText("Storage Radar")).toBeNull();

    fireEvent.change(search, { target: { value: "/storage/mac" } });
    expect(screen.getByText("Storage Radar")).toBeDefined();
    expect(screen.queryByText("Translator Android")).toBeNull();
  });

  it("selects filtered projects with arrow keys and Enter, and closes with Escape", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      ...mockProjects,
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
      },
    ];
    const onSelect = vi.fn();

    render(<ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    const search = screen.getByRole("combobox", { name: "Search projects" });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p-2" }));
    expect(screen.queryByRole("combobox", { name: "Search projects" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search projects" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("combobox", { name: "Search projects" })).toBeNull();
  });

  it("navigates projects in their rendered group order", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      {
        ...mockProjects[0],
        groupName: "Zulu",
      },
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
        groupName: "Alpha",
      },
    ];
    const onSelect = vi.fn();

    render(<ProjectSelector selectedId={null} onSelect={onSelect} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /select project/i }));

    const search = screen.getByRole("combobox", { name: "Search projects" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Beta/tmp/beta",
      "Alpha/tmp/alpha",
    ]);

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1" }));
  });

  it("hides project configuration actions from members", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    render(
      <ProjectSelector
        selectedId="p-1"
        onSelect={() => {}}
        onDeselect={() => {}}
        canManage={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

    expect(screen.queryByText("New project")).toBeNull();
    expect(screen.queryByTitle("Edit")).toBeNull();
    expect(screen.queryByTitle("Delete")).toBeNull();
    expect(screen.queryByTitle("Pin")).toBeNull();
  });

  it("uses collision-free section keys for groups named after built-in sections", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      {
        ...mockProjects[0],
        pinnedAt: "2026-07-15T00:00:00.000Z",
      },
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
        groupName: "Pinned",
      },
      {
        ...mockProjects[0],
        id: "p-3",
        name: "Gamma",
        rootPath: "/tmp/gamma",
        groupName: "Other",
      },
      {
        ...mockProjects[0],
        id: "p-4",
        name: "Delta",
        rootPath: "/tmp/delta",
      },
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

      expect(screen.getAllByText("Pinned")).toHaveLength(2);
      expect(screen.getAllByText("Other")).toHaveLength(2);
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((argument) => String(argument).includes("same key")),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("exposes an active descendant while preserving the actual selected option", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      ...mockProjects,
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
      },
    ];

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

    const search = screen.getByRole("combobox", { name: "Search projects" });
    const listbox = screen.getByRole("listbox", { name: "Projects" });
    const alphaOption = screen.getByRole("option", { name: /alpha/i });
    const betaOption = screen.getByRole("option", { name: /beta/i });

    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(search).toHaveAttribute("aria-activedescendant", alphaOption.id);
    expect(alphaOption).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(search, { key: "ArrowDown" });

    expect(search).toHaveAttribute("aria-activedescendant", betaOption.id);
    expect(alphaOption).toHaveAttribute("aria-selected", "true");
    expect(betaOption).toHaveAttribute("aria-selected", "false");
  });

  it("preserves the active project when the visible list reorders", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      ...mockProjects,
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
      },
    ];
    const onSelect = vi.fn();
    const { rerender } = render(
      <ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));

    const search = screen.getByRole("combobox", { name: "Search projects" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const betaOptionId = screen.getByRole("option", { name: /beta/i }).id;
    expect(search).toHaveAttribute("aria-activedescendant", betaOptionId);

    mockProjects = mockProjects.map((project) =>
      project.id === "p-2" ? { ...project, pinnedAt: "2026-07-16T00:00:00.000Z" } : project,
    );
    rerender(<ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />);

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Beta/tmp/beta",
      "Alpha/tmp/alpha",
    ]);
    expect(search).toHaveAttribute("aria-activedescendant", betaOptionId);

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "p-2" }));
  });

  it("closes the picker with Escape from its action controls and restores trigger focus", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
    const trigger = screen.getByRole("button", { name: /alpha/i });
    fireEvent.click(trigger);
    const pinButton = screen.getByTitle("Pin");
    pinButton.focus();

    fireEvent.keyDown(pinButton, { key: "Escape" });

    expect(screen.queryByRole("combobox", { name: "Search projects" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not push history when saving a group for the selected project", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mutateUpdateProject.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (project: (typeof mockProjects)[number]) => void },
      ) => options.onSuccess?.(mockProjects[0]),
    );
    mutateUpdateOrganization.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (project: (typeof mockProjects)[number]) => void },
      ) => options.onSuccess?.({ ...mockProjects[0], groupName: "Platform" }),
    );
    const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    const onSelect = (project: Project) => {
      window.history.pushState(null, "", `/project/${project.id}`);
    };

    try {
      render(<ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
      fireEvent.click(screen.getByTitle("Edit"));
      fireEvent.change(screen.getByPlaceholderText("Optional product or team"), {
        target: { value: "Platform" },
      });
      fireEvent.click(screen.getByText("Save"));

      expect(mutateUpdateOrganization).toHaveBeenCalledWith(
        { id: "p-1", input: { groupName: "Platform" } },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      expect(pushState).not.toHaveBeenCalled();
    } finally {
      pushState.mockRestore();
    }
  });

  it("does not navigate when a delayed group update finishes after selection changes", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockProjects = [
      ...mockProjects,
      {
        ...mockProjects[0],
        id: "p-2",
        name: "Beta",
        rootPath: "/tmp/beta",
      },
    ];
    mutateUpdateProject.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (project: (typeof mockProjects)[number]) => void },
      ) => options.onSuccess?.(mockProjects[0]),
    );
    let finishOrganizationUpdate: ((project: (typeof mockProjects)[number]) => void) | undefined;
    mutateUpdateOrganization.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (project: (typeof mockProjects)[number]) => void },
      ) => {
        finishOrganizationUpdate = options.onSuccess;
      },
    );
    const onSelect = vi.fn();
    const { rerender } = render(
      <ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getAllByTitle("Edit")[0]);
    fireEvent.change(screen.getByPlaceholderText("Optional product or team"), {
      target: { value: "Platform" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(finishOrganizationUpdate).toEqual(expect.any(Function));
    expect(onSelect).not.toHaveBeenCalled();

    rerender(<ProjectSelector selectedId="p-2" onSelect={onSelect} onDeselect={() => {}} />);
    finishOrganizationUpdate?.({ ...mockProjects[0], groupName: "Platform" });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not navigate after saving an edit without an organization change", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });
    mutateUpdateProject.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (project: (typeof mockProjects)[number]) => void },
      ) => options.onSuccess?.(mockProjects[0]),
    );
    const onSelect = vi.fn();

    render(<ProjectSelector selectedId="p-1" onSelect={onSelect} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByTitle("Edit"));
    fireEvent.click(screen.getByText("Save"));

    expect(mutateUpdateOrganization).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("pins a project from the picker", () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByTitle("Pin"));

    expect(mutateUpdateOrganization).toHaveBeenCalledWith(
      { id: "p-1", input: { pinned: true } },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
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

  it("hides GitHub project controls while the rollout flag is disabled", () => {
    mockGitHubIssuePrEnabled = false;
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

    render(<ProjectSelector selectedId="p-1" onSelect={() => {}} onDeselect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/i }));
    fireEvent.click(screen.getByTitle("Edit"));

    expect(screen.queryByText("GitHub Issue-to-PR")).toBeNull();
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
