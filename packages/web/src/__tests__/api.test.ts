import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([])),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires projectId for task list requests", async () => {
    await api.listTasks("project 1");

    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/tasks?projectId=project%201");
    expect(String(url)).not.toBe("/tasks");
  });

  it("uses explicit project overview endpoint", async () => {
    await api.listProjectTaskOverviews();

    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/projects/overview");
  });

  it("updates project organization with PATCH", async () => {
    await api.updateProjectOrganization("project 1", { pinned: true, groupName: "Platform" });

    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/projects/project%201/organization");
    expect(init?.method).toBe("PATCH");
  });
});
