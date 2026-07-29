import { describe, expect, it } from "vitest";
import {
  getRuntimeModelEffortConfig,
  normalizeModelEffortLevels,
  resolveModelEffortOption,
  stripRuntimeModelEffortMetadata,
  validateRuntimeModelEffort,
} from "../modelEffort.js";
import type { RuntimeRunInput } from "../types.js";
import { RuntimeTransport } from "../types.js";
import { TEST_USAGE_CONTEXT } from "./helpers/usageContext.js";

function createInput(runtimeId: string, optionKey: string, effort: unknown): RuntimeRunInput {
  return {
    runtimeId,
    providerId: "provider",
    profileId: "profile-1",
    transport: RuntimeTransport.API,
    prompt: "run",
    model: "model-1",
    options: { [optionKey]: effort },
    usageContext: TEST_USAGE_CONTEXT,
  };
}

describe("runtime model effort policy", () => {
  it("normalizes and deduplicates provider effort metadata", () => {
    expect(normalizeModelEffortLevels([" Low ", "low", "MAX", "", null])).toEqual(["low", "max"]);
    expect(normalizeModelEffortLevels([])).toBeUndefined();
  });

  it.each([
    { runtimeId: "claude", optionKey: "effort", accepted: "max" },
    { runtimeId: "codex", optionKey: "modelReasoningEffort", accepted: "xhigh" },
    { runtimeId: "opencode", optionKey: "reasoningEffort", accepted: "none" },
    { runtimeId: "openrouter", optionKey: "effort", accepted: "high" },
  ])("retains the $runtimeId fallback allowlist", ({ runtimeId, optionKey, accepted }) => {
    const config = getRuntimeModelEffortConfig(runtimeId);
    const acceptedValidation = validateRuntimeModelEffort(
      createInput(runtimeId, optionKey, accepted),
      null,
    );
    const rejectedValidation = validateRuntimeModelEffort(
      createInput(runtimeId, optionKey, "bogus"),
      null,
    );

    expect(config).not.toBeNull();
    if (!config) {
      throw new Error(`Missing effort config for ${runtimeId}`);
    }
    expect(acceptedValidation.acceptedEffort).toBe(accepted);
    expect(
      resolveModelEffortOption(
        acceptedValidation.input.options ?? {},
        config.optionKey,
        config.fallbackLevels,
      ),
    ).toBe(accepted);
    expect(rejectedValidation.reasonCode).toBe("unsupported_model_effort");
    expect(rejectedValidation.input.options).not.toHaveProperty(optionKey);
  });

  it.each([
    { runtimeId: "claude", optionKey: "effort" },
    { runtimeId: "codex", optionKey: "modelReasoningEffort" },
    { runtimeId: "opencode", optionKey: "reasoningEffort" },
    { runtimeId: "openrouter", optionKey: "effort" },
  ])(
    "accepts only selected-model metadata for $runtimeId dynamic effort",
    ({ runtimeId, optionKey }) => {
      const config = getRuntimeModelEffortConfig(runtimeId);
      if (!config) {
        throw new Error(`Missing effort config for ${runtimeId}`);
      }
      const validation = validateRuntimeModelEffort(createInput(runtimeId, optionKey, " Ultra "), [
        {
          id: "other-model",
          metadata: {
            supportsEffort: true,
            supportedEffortLevels: ["low"],
          },
        },
        {
          id: "model-1",
          metadata: {
            supportsEffort: true,
            supportedEffortLevels: ["ultra"],
          },
        },
      ]);

      expect(validation.source).toBe("discovery");
      expect(validation.acceptedEffort).toBe("ultra");
      expect(
        resolveModelEffortOption(
          validation.input.options ?? {},
          config.optionKey,
          config.fallbackLevels,
        ),
      ).toBe("ultra");
    },
  );

  it("rejects effort when the selected model explicitly does not support it", () => {
    const validation = validateRuntimeModelEffort(createInput("openrouter", "effort", "high"), [
      {
        id: "model-1",
        metadata: { supportsEffort: false },
      },
    ]);

    expect(validation.source).toBe("discovery");
    expect(validation.allowedEffortLevels).toEqual([]);
    expect(validation.input.options).not.toHaveProperty("effort");
  });

  it.each(["max", "none"])(
    "accepts OpenRouter gateway effort %s only when model discovery advertises it",
    (effort) => {
      const fallbackValidation = validateRuntimeModelEffort(
        createInput("openrouter", "effort", effort),
        null,
      );
      const discoveredValidation = validateRuntimeModelEffort(
        createInput("openrouter", "effort", effort),
        [
          {
            id: "model-1",
            metadata: {
              supportsEffort: true,
              supportedEffortLevels: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
            },
          },
        ],
      );

      expect(fallbackValidation.reasonCode).toBe("unsupported_model_effort");
      expect(fallbackValidation.input.options).not.toHaveProperty("effort");
      expect(discoveredValidation.source).toBe("discovery");
      expect(discoveredValidation.acceptedEffort).toBe(effort);
      expect(discoveredValidation.input.options).toHaveProperty("effort", effort);
    },
  );

  it("normalizes legacy numeric Claude effort before validating model metadata", () => {
    const accepted = validateRuntimeModelEffort(createInput("claude", "effort", 4), null);
    const rejected = validateRuntimeModelEffort(createInput("claude", "effort", 4), [
      {
        id: "model-1",
        metadata: { supportsEffort: false },
      },
    ]);

    expect(accepted.acceptedEffort).toBe("max");
    expect(accepted.input.options).toHaveProperty("effort", "max");
    expect(rejected.reasonCode).toBe("unsupported_model_effort");
    expect(rejected.input.options).not.toHaveProperty("effort");
  });

  it("removes malformed non-empty effort values", () => {
    const validation = validateRuntimeModelEffort(
      createInput("codex", "modelReasoningEffort", { value: "high" }),
      null,
    );

    expect(validation.reasonCode).toBe("unsupported_model_effort");
    expect(validation.input.options).not.toHaveProperty("modelReasoningEffort");
  });

  it("removes effort metadata while preserving unrelated model metadata", () => {
    expect(
      stripRuntimeModelEffortMetadata([
        {
          id: "model-1",
          metadata: {
            supportsEffort: true,
            supportedEffortLevels: ["low", "high"],
            defaultEffort: "high",
            contextLength: 200_000,
          },
        },
        {
          id: "model-2",
          metadata: {
            supportsEffort: false,
          },
        },
      ]),
    ).toEqual([
      {
        id: "model-1",
        metadata: { contextLength: 200_000 },
      },
      {
        id: "model-2",
        metadata: undefined,
      },
    ]);
  });
});
