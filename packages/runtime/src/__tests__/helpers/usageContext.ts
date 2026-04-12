import { UsageSource, type RuntimeUsageContext } from "../../types.js";

/**
 * Shared test-only usage context. Lets test fixtures build valid
 * `RuntimeRunInput` objects without repeating the boilerplate in every file.
 *
 * Use as:
 * ```ts
 * const input: RuntimeRunInput = {
 *   runtimeId: "claude",
 *   prompt: "...",
 *   usageContext: TEST_USAGE_CONTEXT,
 * };
 * ```
 */
export const TEST_USAGE_CONTEXT: RuntimeUsageContext = {
  source: UsageSource.TEST,
};
