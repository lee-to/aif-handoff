import { describe, expect, it } from "vitest";
import {
  enrichCodexDiscoveredModels,
  getDefaultCodexModels,
  parseCodexRuntimeModel,
} from "../adapters/codex/modelDiscovery/modelCatalog.js";

describe("codex model discovery model catalog", () => {
  it("returns cloned default models so callers cannot mutate shared metadata", () => {
    const first = getDefaultCodexModels();
    const second = getDefaultCodexModels();

    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(first[0]).not.toBe(second[0]);

    const mutatedLevels = first[0]?.metadata?.supportedEffortLevels as string[] | undefined;
    mutatedLevels?.splice(0, mutatedLevels.length, "low");

    const third = getDefaultCodexModels();
    expect(third[0]?.metadata?.supportedEffortLevels).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("deduplicates discovered models and preserves known metadata defaults", () => {
    const enriched = enrichCodexDiscoveredModels([
      {
        id: "GPT-5.4",
        supportsStreaming: false,
      },
      {
        id: "gpt-5.4",
        label: "Duplicate should be ignored",
      },
      {
        id: "custom-model",
        label: "Custom model",
        metadata: {
          supportedEffortLevels: [" low ", "", "high", "low"],
          supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
          defaultReasoningEffort: "medium",
          experimentalFeature: true,
        },
      },
      {
        id: "",
        label: "ignored-empty-id",
      },
    ]);

    expect(enriched).toHaveLength(2);

    const known = enriched.find((model) => model.id.toLowerCase() === "gpt-5.4");
    expect(known?.label).toBe("GPT-5.4");
    expect(known?.supportsStreaming).toBe(false);
    expect(known?.metadata).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    });

    const custom = enriched.find((model) => model.id === "custom-model");
    expect(custom?.label).toBe("Custom model");
    expect(custom?.metadata).toMatchObject({
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      defaultEffort: "medium",
      experimentalFeature: true,
    });
    expect((custom?.metadata as Record<string, unknown>).supportedReasoningEfforts).toBeUndefined();
    expect((custom?.metadata as Record<string, unknown>).defaultReasoningEffort).toBeUndefined();
  });

  it("parses runtime model payloads with effort metadata and optional fields", () => {
    const parsed = parseCodexRuntimeModel({
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "General purpose model",
      supportedReasoningEfforts: [
        { reasoningEffort: "minimal" },
        { reasoningEffort: "high" },
        { reasoningEffort: "max" },
        { reasoningEffort: "ultra" },
        { reasoningEffort: "   " },
      ],
      defaultReasoningEffort: "ultra",
      hidden: false,
      isDefault: true,
      supportsPersonality: true,
      inputModalities: ["text", 123, "image"],
      upgrade: "gpt-6",
      upgradeInfo: { target: "gpt-6" },
      availabilityNux: { title: "Try GPT-6" },
    });

    expect(parsed).toEqual({
      id: "gpt-5.4",
      label: "GPT-5.4",
      supportsStreaming: true,
      metadata: {
        description: "General purpose model",
        supportsEffort: true,
        supportedEffortLevels: ["minimal", "high", "max", "ultra"],
        defaultEffort: "ultra",
        hidden: false,
        isDefault: true,
        supportsPersonality: true,
        inputModalities: ["text", "image"],
        upgrade: "gpt-6",
        upgradeInfo: { target: "gpt-6" },
        availabilityNux: { title: "Try GPT-6" },
      },
    });
  });

  it("returns null for invalid model payloads", () => {
    expect(parseCodexRuntimeModel(null)).toBeNull();
    expect(parseCodexRuntimeModel("not-an-object")).toBeNull();
    expect(parseCodexRuntimeModel({})).toBeNull();
    expect(parseCodexRuntimeModel({ id: "   " })).toBeNull();
  });

  it("preserves explicit lack of Codex effort support", () => {
    const parsed = parseCodexRuntimeModel({
      model: "codex-basic",
      supportedReasoningEfforts: [],
    });

    expect(parsed?.metadata).toMatchObject({ supportsEffort: false });
  });
});
