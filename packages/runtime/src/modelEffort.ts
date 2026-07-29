import type { RuntimeModel, RuntimeRunInput } from "./types.js";

export const CLAUDE_MODEL_EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export const CODEX_MODEL_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const OPENCODE_MODEL_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const OPENROUTER_MODEL_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const OPENROUTER_GATEWAY_MODEL_EFFORT_LEVELS = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

const CLAUDE_NUMERIC_MODEL_EFFORT_LEVELS: Record<number, string> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "max",
};

export interface RuntimeModelEffortConfig {
  optionKey: "effort" | "modelReasoningEffort" | "reasoningEffort";
  fallbackLevels: readonly string[];
}

export interface RuntimeModelEffortValidation {
  input: RuntimeRunInput;
  configuredEffort: string | null;
  acceptedEffort: string | null;
  allowedEffortLevels: string[];
  source: "discovery" | "fallback" | "none";
  reasonCode: "unsupported_model_effort" | null;
}

const MODEL_EFFORT_CONFIGS = new Map<string, RuntimeModelEffortConfig>([
  [
    "claude",
    {
      optionKey: "effort",
      fallbackLevels: CLAUDE_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "codex",
    {
      optionKey: "modelReasoningEffort",
      fallbackLevels: CODEX_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "opencode",
    {
      optionKey: "reasoningEffort",
      fallbackLevels: OPENCODE_MODEL_EFFORT_LEVELS,
    },
  ],
  [
    "openrouter",
    {
      optionKey: "effort",
      fallbackLevels: OPENROUTER_MODEL_EFFORT_LEVELS,
    },
  ],
]);

const VALIDATED_MODEL_EFFORT = Symbol("validated-model-effort");

interface ValidatedModelEffortMarker {
  optionKey: RuntimeModelEffortConfig["optionKey"];
  value: string;
}

type ModelEffortOptions = Record<string, unknown> & {
  [VALIDATED_MODEL_EFFORT]?: ValidatedModelEffortMarker;
};

export function normalizeModelEffort(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function hasConfiguredModelEffort(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value != null;
}

export function normalizeConfiguredModelEffort(runtimeId: string, value: unknown): string | null {
  if (
    runtimeId.trim().toLowerCase() === "claude" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return CLAUDE_NUMERIC_MODEL_EFFORT_LEVELS[Math.floor(value)] ?? null;
  }
  return normalizeModelEffort(value);
}

export function normalizeModelEffortLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeModelEffort(entry);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return unique.size > 0 ? [...unique] : undefined;
}

export function getRuntimeModelEffortConfig(runtimeId: string): RuntimeModelEffortConfig | null {
  return MODEL_EFFORT_CONFIGS.get(runtimeId.trim().toLowerCase()) ?? null;
}

export function isModelEffortLevel<T extends string>(
  value: string | null,
  levels: readonly T[],
): value is T {
  return value !== null && levels.some((level) => level === value);
}

export function resolveModelEffortOption(
  options: Record<string, unknown>,
  optionKey: RuntimeModelEffortConfig["optionKey"],
  fallbackLevels: readonly string[],
): string | null {
  const normalized = normalizeModelEffort(options[optionKey]);
  if (!normalized) {
    return null;
  }
  if (fallbackLevels.some((level) => level === normalized)) {
    return normalized;
  }

  const marker = (options as ModelEffortOptions)[VALIDATED_MODEL_EFFORT];
  return marker?.optionKey === optionKey && marker.value === normalized ? normalized : null;
}

export function validateRuntimeModelEffort(
  input: RuntimeRunInput,
  models: RuntimeModel[] | null,
): RuntimeModelEffortValidation {
  const config = getRuntimeModelEffortConfig(input.runtimeId);
  const options = input.options ?? {};
  const rawEffort = config ? options[config.optionKey] : null;
  const hasConfiguredEffort = config ? hasConfiguredModelEffort(rawEffort) : false;
  const configuredEffort = config
    ? normalizeConfiguredModelEffort(input.runtimeId, rawEffort)
    : null;

  if (!config || !hasConfiguredEffort) {
    return {
      input,
      configuredEffort,
      acceptedEffort: configuredEffort,
      allowedEffortLevels: [],
      source: "none",
      reasonCode: null,
    };
  }

  if (!configuredEffort) {
    const sanitizedOptions = { ...options };
    delete sanitizedOptions[config.optionKey];
    return {
      input: {
        ...input,
        options: sanitizedOptions,
      },
      configuredEffort,
      acceptedEffort: null,
      allowedEffortLevels: [...config.fallbackLevels],
      source: "fallback",
      reasonCode: "unsupported_model_effort",
    };
  }

  const selectedModel = input.model
    ? (models?.find((model) => model.id === input.model) ?? null)
    : null;
  const discoveredLevels = normalizeModelEffortLevels(
    selectedModel?.metadata?.supportedEffortLevels,
  );
  const hasDiscoveryPolicy =
    selectedModel?.metadata?.supportsEffort === false || discoveredLevels !== undefined;
  const allowedEffortLevels =
    selectedModel?.metadata?.supportsEffort === false
      ? []
      : (discoveredLevels ?? [...config.fallbackLevels]);
  const source = hasDiscoveryPolicy ? "discovery" : "fallback";

  if (allowedEffortLevels.some((level) => level === configuredEffort)) {
    const markedOptions: ModelEffortOptions = {
      ...options,
      [config.optionKey]: configuredEffort,
      [VALIDATED_MODEL_EFFORT]: {
        optionKey: config.optionKey,
        value: configuredEffort,
      },
    };
    return {
      input: {
        ...input,
        options: markedOptions,
      },
      configuredEffort,
      acceptedEffort: configuredEffort,
      allowedEffortLevels,
      source,
      reasonCode: null,
    };
  }

  const sanitizedOptions = { ...options };
  delete sanitizedOptions[config.optionKey];

  return {
    input: {
      ...input,
      options: sanitizedOptions,
    },
    configuredEffort,
    acceptedEffort: null,
    allowedEffortLevels,
    source,
    reasonCode: "unsupported_model_effort",
  };
}

export function stripRuntimeModelEffortMetadata(models: RuntimeModel[]): RuntimeModel[] {
  return models.map((model) => {
    if (!model.metadata) {
      return model;
    }

    const metadata = { ...model.metadata };
    delete metadata.supportsEffort;
    delete metadata.supportedEffortLevels;
    delete metadata.defaultEffort;

    return {
      ...model,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  });
}
