import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, onAuthenticationRequired } from "@/lib/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const disabledSession = {
  participantsModeEnabled: false,
  authenticated: false,
  participant: null,
  csrfToken: null,
  expiresAt: null,
};

const authenticatedSession = {
  participantsModeEnabled: true,
  authenticated: true,
  participant: {
    id: "participant-1",
    displayName: "Ada",
    role: "admin" as const,
    active: true,
  },
  csrfToken: "csrf-old",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/auth/session") ? jsonResponse(disabledSession) : jsonResponse([]),
      ),
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
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("uses explicit project overview endpoint", async () => {
    await api.listProjectTaskOverviews();

    const fetchMock = vi.mocked(fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/projects/overview");
  });

  it("updates project organization with PATCH", async () => {
    await api.getAuthSession();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    await api.updateProjectOrganization("project 1", { pinned: true, groupName: "Platform" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/projects/project%201/organization");
    expect(init?.method).toBe("PATCH");
  });

  it("acquires and refreshes CSRF tokens before retrying a rejected mutation", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(authenticatedSession));
    await api.getAuthSession();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: "Invalid CSRF token", code: "invalid_csrf" }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ ...authenticatedSession, csrfToken: "csrf-new" }))
      .mockResolvedValueOnce(jsonResponse({ id: "project-1" }));

    await api.updateProjectOrganization("project-1", { pinned: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("X-CSRF-Token")).toBe("csrf-old");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/auth/session");
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Headers).get("X-CSRF-Token")).toBe("csrf-new");
  });

  it("notifies the authenticated shell when a session expires", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(authenticatedSession));
    await api.getAuthSession();
    const listener = vi.fn();
    const unsubscribe = onAuthenticationRequired(listener);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Authentication required", code: "authentication_required" }, 401),
    );

    await expect(
      api.updateProjectOrganization("project-1", { pinned: true }),
    ).rejects.toMatchObject({
      status: 401,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("never writes credentials to centralized request logs", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(authenticatedSession));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await api.login({ username: "secret-user", password: "super-secret-password" });

    const logged = JSON.stringify(debugSpy.mock.calls);
    expect(logged).not.toContain("secret-user");
    expect(logged).not.toContain("super-secret-password");
    expect(logged).toContain("/auth/login");
    debugSpy.mockRestore();
  });

  it("changes a password with the authenticated CSRF token without logging secrets", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(authenticatedSession));
    await api.getAuthSession();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, revokedSessionCount: 1 }));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await api.changeParticipantPassword({
      currentPassword: "old secret password",
      newPassword: "new secret password",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/auth/change-password");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Headers).get("X-CSRF-Token")).toBe("csrf-old");
    const logged = JSON.stringify(debugSpy.mock.calls);
    expect(logged).not.toContain("old secret password");
    expect(logged).not.toContain("new secret password");
    debugSpy.mockRestore();
  });
});
