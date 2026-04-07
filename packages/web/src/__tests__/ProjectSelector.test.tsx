import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mockUseQuery = vi.fn();
const mutateCreateProject = vi.fn();
const mutateUpdateProject = vi.fn();
const mutateDeleteProject = vi.fn();

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
}));

const { ProjectSelector } = await import("@/components/project/ProjectSelector");

describe("ProjectSelector", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mutateCreateProject.mockReset();
    mutateUpdateProject.mockReset();
    mutateDeleteProject.mockReset();
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
});
