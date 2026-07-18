import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateProjectTaskOverviews } from "@/hooks/useProjects";

/**
 * Regression for the WS overview-invalidation gap (#143 review, must-fix #2).
 *
 * `project:runtime_limit_updated` fires when persisted runtime-limit / last
 * usage state changes. The overview aggregates token/cost fields, so this
 * event must invalidate the `["projectTaskOverviews"]` query — otherwise the
 * dashboard header and project cards show stale token/cost after usage
 * updates. The useWebSocket handler calls `invalidateProjectTaskOverviews`
 * (from useProjects) in that branch; this test pins that helper so a future
 * change that drops or renames the query key surfaces immediately.
 */
describe("invalidateProjectTaskOverviews (WS runtime_limit_updated branch)", () => {
  it("invalidates the projectTaskOverviews query", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    invalidateProjectTaskOverviews(queryClient);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projectTaskOverviews"] });
  });
});
