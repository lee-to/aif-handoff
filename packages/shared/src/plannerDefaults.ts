export type PlannerMode = "full" | "fast";

export interface PlannerFlagDefaults {
  skipReview: boolean;
  planDocs: boolean;
  planTests: boolean;
}

export function defaultsForMode(mode: PlannerMode): PlannerFlagDefaults {
  return mode === "full"
    ? { skipReview: false, planDocs: true, planTests: true }
    : { skipReview: true, planDocs: false, planTests: false };
}
