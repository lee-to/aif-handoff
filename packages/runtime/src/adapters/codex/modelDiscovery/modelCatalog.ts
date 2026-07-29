import type { RuntimeModel } from "../../../types.js";
import { normalizeModelEffort, normalizeModelEffortLevels } from "../../../modelEffort.js";

const DEFAULT_CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

const DEFAULT_CODEX_MODELS: RuntimeModel[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: [...DEFAULT_CODEX_EFFORT_LEVELS],
    },
  },
];

const KNOWN_CODEX_MODELS = new Map(
  DEFAULT_CODEX_MODELS.map((model) => [model.id.toLowerCase(), cloneRuntimeModel(model)]),
);

export function getDefaultCodexModels(): RuntimeModel[] {
  return DEFAULT_CODEX_MODELS.map(cloneRuntimeModel);
}

export function enrichCodexDiscoveredModels(models: RuntimeModel[]): RuntimeModel[] {
  const enriched: RuntimeModel[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const id = readString(candidate.id);
    if (!id) {
      continue;
    }

    const normalizedId = id.toLowerCase();
    if (seen.has(normalizedId)) {
      continue;
    }
    seen.add(normalizedId);

    const known = KNOWN_CODEX_MODELS.get(normalizedId);
    const metadata = mergeModelMetadata(known?.metadata, candidate.metadata);
    enriched.push({
      id,
      label: candidate.label ?? known?.label,
      supportsStreaming: candidate.supportsStreaming ?? known?.supportsStreaming ?? true,
      ...(metadata ? { metadata } : {}),
    });
  }

  return enriched;
}

export function parseCodexRuntimeModel(value: unknown): RuntimeModel | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const model = value as Record<string, unknown>;
  const id = readString(model.model) ?? readString(model.id);
  if (!id) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  const description = readString(model.description);
  if (description) {
    metadata.description = description;
  }

  const supportedEffortLevels = normalizeSupportedReasoningEfforts(model.supportedReasoningEfforts);
  if (supportedEffortLevels) {
    metadata.supportsEffort = true;
    metadata.supportedEffortLevels = supportedEffortLevels;
  } else if (Array.isArray(model.supportedReasoningEfforts)) {
    metadata.supportsEffort = false;
  }

  const defaultEffort = normalizeModelEffort(model.defaultReasoningEffort);
  if (defaultEffort) {
    metadata.supportsEffort = true;
    metadata.defaultEffort = defaultEffort;
  }

  if (typeof model.hidden === "boolean") {
    metadata.hidden = model.hidden;
  }
  if (typeof model.isDefault === "boolean") {
    metadata.isDefault = model.isDefault;
  }
  if (typeof model.supportsPersonality === "boolean") {
    metadata.supportsPersonality = model.supportsPersonality;
  }
  if (Array.isArray(model.inputModalities)) {
    metadata.inputModalities = model.inputModalities.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (readString(model.upgrade)) {
    metadata.upgrade = model.upgrade;
  }
  if (model.upgradeInfo && typeof model.upgradeInfo === "object") {
    metadata.upgradeInfo = model.upgradeInfo;
  }
  if (model.availabilityNux && typeof model.availabilityNux === "object") {
    metadata.availabilityNux = model.availabilityNux;
  }

  return {
    id,
    label: readString(model.displayName) ?? undefined,
    supportsStreaming: true,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function cloneRuntimeModel(model: RuntimeModel): RuntimeModel {
  return {
    ...model,
    ...(model.metadata ? { metadata: structuredCloneCompatible(model.metadata) } : {}),
  };
}

function structuredCloneCompatible(value: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = Array.isArray(entry) ? [...entry] : entry;
  }
  return cloned;
}

function mergeModelMetadata(
  known: Record<string, unknown> | undefined,
  discovered: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...(known ? structuredCloneCompatible(known) : {}),
    ...(discovered ? structuredCloneCompatible(discovered) : {}),
  };

  if (merged.supportsEffort === false) {
    delete merged.supportedEffortLevels;
  } else {
    const supportedEffortLevels =
      normalizeModelEffortLevels(merged.supportedEffortLevels) ??
      normalizeSupportedReasoningEfforts(merged.supportedReasoningEfforts);
    if (supportedEffortLevels) {
      merged.supportedEffortLevels = supportedEffortLevels;
      merged.supportsEffort = true;
    } else {
      delete merged.supportedEffortLevels;
      if (merged.supportsEffort !== true) {
        delete merged.supportsEffort;
      }
    }
  }

  const defaultEffort =
    normalizeModelEffort(merged.defaultEffort) ??
    normalizeModelEffort(merged.defaultReasoningEffort);
  if (defaultEffort) {
    merged.defaultEffort = defaultEffort;
  } else {
    delete merged.defaultEffort;
  }
  delete merged.defaultReasoningEffort;
  delete merged.supportedReasoningEfforts;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeSupportedReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const unique = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = normalizeModelEffort((entry as Record<string, unknown>).reasoningEffort);
    if (normalized) {
      unique.add(normalized);
    }
  }

  return unique.size > 0 ? [...unique] : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
