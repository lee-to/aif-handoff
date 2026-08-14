import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@aif/shared/browser";

const mockCreateProject = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, createProject: mockCreateProject } };
});

const { useCreateProject } = await import("@/hooks/useProjects");

describe("useCreateProject", () => {
  it("adds the created project to the projects cache before selection", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const project = {
      id: "created-project",
      name: "Created project",
      rootPath: "/tmp/created-project",
    } as Project;
    queryClient.setQueryData<Project[]>(["projects"], []);
    mockCreateProject.mockResolvedValueOnce(project);

    const { result } = renderHook(() => useCreateProject(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await act(() => result.current.mutateAsync({ name: project.name, rootPath: project.rootPath }));

    expect(queryClient.getQueryData(["projects"])).toEqual([project]);
  });
});
