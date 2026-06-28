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
});
