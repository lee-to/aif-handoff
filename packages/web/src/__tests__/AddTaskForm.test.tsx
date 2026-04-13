import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutateCreateTask = vi.fn();

const mockSettingsData = {
  data: { useSubagents: true, maxReviewIterations: 3 } as
    | { useSubagents: boolean; maxReviewIterations: number }
    | undefined,
};

const mockDefaultsData = {
  data: undefined as
    | { paths: { plan?: string; plans?: string }; workflow: Record<string, unknown> }
    | undefined,
};
const mockProjectsData = {
  data: [{ id: "p-1", parallelEnabled: false }] as Array<Record<string, unknown>>,
};
const mockRuntimeProfilesData = {
  data: [] as Array<Record<string, unknown>>,
};
const mockRuntimesData = {
  data: [] as Array<Record<string, unknown>>,
};

vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({ data: mockProjectsData.data }),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ data: mockSettingsData.data }),
  useProjectDefaults: () => ({ data: mockDefaultsData.data }),
}));

vi.mock("@/hooks/useRuntimeProfiles", () => ({
  useRuntimeProfiles: () => ({ data: mockRuntimeProfilesData.data }),
  useRuntimes: () => ({ data: mockRuntimesData.data }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useCreateTask: () => ({
    mutate: mutateCreateTask,
    isPending: false,
  }),
}));

const { AddTaskForm } = await import("@/components/kanban/AddTaskForm");

describe("AddTaskForm", () => {
  beforeEach(() => {
    mutateCreateTask.mockClear();
    mockSettingsData.data = { useSubagents: true, maxReviewIterations: 3 };
    mockDefaultsData.data = undefined;
    mockProjectsData.data = [{ id: "p-1", parallelEnabled: false }];
    mockRuntimeProfilesData.data = [];
    mockRuntimesData.data = [];
  });

  it("uses autoMode=true by default", () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Task with auto mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        title: "Task with auto mode",
        autoMode: true,
        isFix: false,
      }),
      expect.any(Object),
    );
  });

  it("submits autoMode=false when checkbox is unchecked", () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    const checkbox = screen.getByLabelText("Auto mode");
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Task manual mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        title: "Task manual mode",
        autoMode: false,
        isFix: false,
      }),
      expect.any(Object),
    );
  });

  it("submits isFix=true when Fix checkbox is checked", () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByLabelText("Fix"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Fix issue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        title: "Fix issue",
        isFix: true,
      }),
      expect.any(Object),
    );
  });

  it("resets and closes form on cancel", () => {
    const { container } = render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Will be cleared" },
    });
    fireEvent.change(screen.getByPlaceholderText("Description (optional)"), {
      target: { value: "Temp text" },
    });

    const buttons = container.querySelectorAll('button[type="button"]');
    const cancelButton = buttons[buttons.length - 1] as HTMLButtonElement;
    fireEvent.click(cancelButton);

    expect(screen.getByText("Add task")).toBeDefined();
    expect(screen.queryByPlaceholderText("Task title")).toBeNull();
  });

  it("runs submit onSuccess callback and closes form", async () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Success task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const options = mutateCreateTask.mock.calls[0][1] as { onSuccess?: () => void };
    await act(async () => {
      options.onSuccess?.();
    });

    await waitFor(() => {
      expect(screen.getByText("Add task")).toBeDefined();
      expect(screen.queryByPlaceholderText("Task title")).toBeNull();
    });
  });

  it("loads plan path default from project config", () => {
    mockDefaultsData.data = {
      paths: { plan: "custom/MY_PLAN.md" },
      workflow: {},
    };

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Planner settings" }));

    const planInput = screen.getByDisplayValue("custom/MY_PLAN.md");
    expect(planInput).toBeDefined();
  });

  it("loads plansDir from project config and uses it in full mode slug", () => {
    mockDefaultsData.data = {
      paths: { plan: "custom/PLAN.md", plans: "custom/plans/" },
      workflow: {},
    };

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Planner settings" }));
    fireEvent.click(screen.getByLabelText("Full"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "My feature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        planPath: "custom/plans/my-feature.md",
      }),
      expect.any(Object),
    );
  });

  it("keeps default plan path when config has no plan path", () => {
    mockDefaultsData.data = {
      paths: {},
      workflow: {},
    };

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Planner settings" }));

    const planInput = screen.getByDisplayValue(".ai-factory/PLAN.md");
    expect(planInput).toBeDefined();
  });

  it("keeps default plan path when project defaults fail", () => {
    // mockDefaultsData.data is already undefined (simulates failed/no data)

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Planner settings" }));

    const planInput = screen.getByDisplayValue(".ai-factory/PLAN.md");
    expect(planInput).toBeDefined();
  });

  it("handles create task error without crashing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Failing task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const options = mutateCreateTask.mock.calls[0][1] as { onError?: (e: Error) => void };
    await act(async () => {
      options.onError?.(new Error("server error"));
    });

    // Form should still be open after error
    expect(screen.getByPlaceholderText("Task title")).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("opens runtime override panel and submits with defaults", () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Runtime override" }));

    // Panel is open — select and model inputs are visible
    expect(screen.getByText("Runtime profile")).toBeDefined();
    expect(screen.getByPlaceholderText("runtime default")).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Task with runtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeProfileId: null,
        modelOverride: null,
      }),
      expect.any(Object),
    );
  });

  it("shows project-default runtime hint when project has default runtime profile", () => {
    mockProjectsData.data = [
      {
        id: "p-1",
        parallelEnabled: false,
        defaultTaskRuntimeProfileId: "rp-default",
      },
    ];

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Runtime override" }));

    expect(screen.getByText("(project default)")).toBeDefined();
  });

  it("submits selected runtime profile and trimmed model override", () => {
    mockRuntimeProfilesData.data = [
      {
        id: "rp-1",
        name: "OpenRouter fast",
        runtimeId: "openrouter",
        providerId: "openrouter",
      },
    ];
    mockRuntimesData.data = [
      {
        id: "openrouter",
        capabilities: { supportsAgentDefinitions: true },
      },
    ];

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Runtime override" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "rp-1" } });
    fireEvent.change(screen.getByPlaceholderText("runtime default"), {
      target: { value: "  openai/gpt-4o-mini  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Task with selected runtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeProfileId: "rp-1",
        modelOverride: "openai/gpt-4o-mini",
      }),
      expect.any(Object),
    );
  });

  it("shows subagent support warning for runtime without agent definitions", () => {
    mockRuntimeProfilesData.data = [
      {
        id: "rp-1",
        name: "OpenRouter profile",
        runtimeId: "openrouter",
        providerId: "openrouter",
      },
    ];
    mockRuntimesData.data = [
      {
        id: "openrouter",
        capabilities: { supportsAgentDefinitions: false },
      },
    ];

    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Runtime override" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "rp-1" } });

    expect(
      screen.getByText(
        "This runtime does not support subagents — skills mode will be used instead.",
      ),
    ).toBeDefined();
  });

  it("submits planner settings from advanced options", () => {
    render(<AddTaskForm projectId="p-1" />);

    fireEvent.click(screen.getByText("Add task"));
    fireEvent.click(screen.getByRole("button", { name: "Planner settings" }));
    // Toggle through both planner modes to cover both onChange branches
    fireEvent.click(screen.getByLabelText("Full"));
    fireEvent.click(screen.getByLabelText("Fast"));
    fireEvent.click(screen.getByLabelText("Docs"));
    fireEvent.click(screen.getByLabelText("Tests"));
    fireEvent.change(screen.getByPlaceholderText(".ai-factory/PLAN.md"), {
      target: { value: ".ai-factory/custom-plan.md" },
    });
    // Toggle skip review and use subagents
    const checkboxes = screen.getAllByRole("checkbox");
    const skipReviewCheckbox = checkboxes.find((cb) =>
      cb.closest("label")?.textContent?.includes("Skip review"),
    )!;
    const useSubagentsCheckbox = checkboxes.find((cb) =>
      cb.closest("label")?.textContent?.includes("Use subagents"),
    )!;
    fireEvent.click(skipReviewCheckbox);
    fireEvent.click(useSubagentsCheckbox);
    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Task with planner options" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(mutateCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        title: "Task with planner options",
        plannerMode: "fast",
        planPath: ".ai-factory/custom-plan.md",
        planDocs: true,
        planTests: true,
        skipReview: true,
        useSubagents: false,
      }),
      expect.any(Object),
    );
  });

  describe("priority picker", () => {
    it("defaults to None and creates with priority 0", () => {
      render(<AddTaskForm projectId="p-1" />);
      fireEvent.click(screen.getByText("Add task"));
      fireEvent.change(screen.getByPlaceholderText("Task title"), {
        target: { value: "Default priority" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(mutateCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 0 }),
        expect.any(Object),
      );
    });

    it("creates with the chosen priority value", () => {
      render(<AddTaskForm projectId="p-1" />);
      fireEvent.click(screen.getByText("Add task"));
      // Open the priority Select trigger (label "None") and pick "High"
      fireEvent.click(screen.getByText("None"));
      fireEvent.click(screen.getByText("High"));
      fireEvent.change(screen.getByPlaceholderText("Task title"), {
        target: { value: "High priority task" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(mutateCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: "High priority task", priority: 3 }),
        expect.any(Object),
      );
    });
  });
});
