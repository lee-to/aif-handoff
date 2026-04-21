import { describe, it, expect } from "vitest";
import { shouldRetryProjects, projectsRetryDelay } from "@/hooks/useProjects";
import { ApiError } from "@/lib/api";

describe("projectsRetryDelay", () => {
  it("uses exponential backoff starting at 2s", () => {
    expect(projectsRetryDelay(0)).toBe(2000);
    expect(projectsRetryDelay(1)).toBe(4000);
    expect(projectsRetryDelay(2)).toBe(8000);
  });

  it("caps delay at 15s", () => {
    expect(projectsRetryDelay(3)).toBe(15_000);
    expect(projectsRetryDelay(10)).toBe(15_000);
  });
});

describe("shouldRetryProjects", () => {
  it("retries network errors (non-ApiError)", () => {
    expect(shouldRetryProjects(0, new Error("network down"))).toBe(true);
    expect(shouldRetryProjects(3, new TypeError("fetch failed"))).toBe(true);
  });

  it("retries 5xx server errors", () => {
    expect(shouldRetryProjects(0, new ApiError("boom", 500))).toBe(true);
    expect(shouldRetryProjects(2, new ApiError("unavailable", 503))).toBe(true);
  });

  it("does not retry 4xx client errors", () => {
    expect(shouldRetryProjects(0, new ApiError("unauthorized", 401))).toBe(false);
    expect(shouldRetryProjects(0, new ApiError("forbidden", 403))).toBe(false);
    expect(shouldRetryProjects(0, new ApiError("not found", 404))).toBe(false);
    expect(shouldRetryProjects(0, new ApiError("bad request", 400))).toBe(false);
  });

  it("stops after max retries for transient errors", () => {
    const err = new ApiError("server error", 500);
    expect(shouldRetryProjects(7, err)).toBe(true);
    expect(shouldRetryProjects(8, err)).toBe(false);
    expect(shouldRetryProjects(100, err)).toBe(false);
  });

  it("treats unknown thrown values as retriable transient errors", () => {
    expect(shouldRetryProjects(0, "string error")).toBe(true);
    expect(shouldRetryProjects(0, undefined)).toBe(true);
  });
});
