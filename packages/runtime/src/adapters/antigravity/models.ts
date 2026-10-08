import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { RuntimeModel } from "../../types.js";
import { createRuntimeMemoryCache } from "../../cache.js";

const execFileAsync = promisify(execFile);

/**
 * Official models available in Google Antigravity CLI (`agy models`).
 * Verified directly against the installed agy.exe binary.
 */
export const ANTIGRAVITY_MODELS: RuntimeModel[] = [
  // Gemini 3.8 Flash (Primary fast workhorse)
  {
    id: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash (High)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.8-flash-medium",
    label: "Gemini 3.8 Flash (Medium)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.8-flash-low",
    label: "Gemini 3.8 Flash (Low)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },

  // Gemini 3.7 Flash
  {
    id: "gemini-3.7-flash-high",
    label: "Gemini 3.7 Flash (High)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.7-flash-medium",
    label: "Gemini 3.7 Flash (Medium)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.7-flash-low",
    label: "Gemini 3.7 Flash (Low)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },

  // Gemini 3.6 Flash
  {
    id: "gemini-3.6-flash-high",
    label: "Gemini 3.6 Flash (High)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.6-flash-medium",
    label: "Gemini 3.6 Flash (Medium)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },
  {
    id: "gemini-3.6-flash-low",
    label: "Gemini 3.6 Flash (Low)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      contextWindow: 1048576,
    },
  },

  // Gemini 3.1 Pro (Deep context & complex reasoning: High and Low only)
  {
    id: "gemini-3.1-pro-high",
    label: "Gemini 3.1 Pro (High)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      contextWindow: 2097152,
    },
  },
  {
    id: "gemini-3.1-pro-low",
    label: "Gemini 3.1 Pro (Low)",
    supportsStreaming: true,
    metadata: {
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      contextWindow: 2097152,
    },
  },

  // Partner Models in Antigravity Gateway
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (Thinking)",
    supportsStreaming: true,
    metadata: {
      contextWindow: 200000,
    },
  },
  {
    id: "claude-opus-4-6-thinking",
    label: "Claude Opus 4.6 (Thinking)",
    supportsStreaming: true,
    metadata: {
      contextWindow: 200000,
    },
  },
  {
    id: "gpt-oss-120b-medium",
    label: "GPT-OSS 120B (Medium)",
    supportsStreaming: true,
    metadata: {
      contextWindow: 131072,
    },
  },
];

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.8-flash-high";
export const LIGHT_ANTIGRAVITY_MODEL = "gemini-3.8-flash-low";

export function normalizeCacheKey(cliPath: string, platform: string = process.platform): string {
  const trimmed = cliPath.trim();
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathModule.normalize(trimmed);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

const discoveredModelsCache = createRuntimeMemoryCache<RuntimeModel[]>({
  defaultTtlMs: 5 * 60 * 1000,
});

export interface DiscoverAntigravityModelsOptions {
  cliPath?: string;
  timeoutMs?: number;
  forceRefresh?: boolean;
}

/**
 * Dynamically discover models from `agy models` with in-memory caching and
 * static fallback to ANTIGRAVITY_MODELS.
 */
export async function discoverAntigravityModels(
  options: DiscoverAntigravityModelsOptions = {},
): Promise<RuntimeModel[]> {
  const cliPath = options.cliPath?.trim();
  if (!cliPath) {
    return ANTIGRAVITY_MODELS;
  }

  const cacheKey = normalizeCacheKey(cliPath);
  if (!options.forceRefresh) {
    const cached = discoveredModelsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    const timeoutMs = options.timeoutMs ?? 3_000;
    const { stdout } = await execFileAsync(cliPath, ["models"], {
      timeout: timeoutMs,
      encoding: "utf8",
      windowsHide: true,
    });

    const parsed: RuntimeModel[] = [];
    const lines = stdout.split(/\r?\n/);
    const knownMap = new Map(ANTIGRAVITY_MODELS.map((m) => [m.id, m]));

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("Fetching available models")) {
        continue;
      }
      const parts = line.split("\t");
      if (parts.length >= 1) {
        const id = parts[0].trim();
        const label = parts[1]?.trim() || id;
        if (!id) continue;

        const known = knownMap.get(id);
        parsed.push({
          id,
          label: known?.label ?? label,
          supportsStreaming: true,
          metadata: known?.metadata ?? {
            contextWindow: 1048576,
          },
        });
      }
    }

    if (parsed.length > 0) {
      discoveredModelsCache.set(cacheKey, parsed);
      return parsed;
    }
  } catch {
    // If agy models fails or CLI is unreachable, fall back safely to static registry without poisoning cache
  }

  return ANTIGRAVITY_MODELS;
}

export function clearDiscoveredModelsCache(cliPath?: string): void {
  const trimmed = cliPath?.trim();
  if (trimmed) {
    discoveredModelsCache.delete(normalizeCacheKey(trimmed));
  } else {
    discoveredModelsCache.clear();
  }
}
