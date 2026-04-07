import { findRuntimeProfileById, resolveEffectiveRuntimeProfile } from "@aif/data";
import { validationError } from "../middleware/errorHandler.js";

export interface TaskEffectiveRuntimeMetadata {
  source: string;
  profileId: string | null;
  runtimeId: string | null;
  providerId: string | null;
  profileName: string | null;
}

interface RuntimeProfileValidationLogger {
  warn: (context: Record<string, unknown>, message: string) => void;
}

export function assertRuntimeProfileSelection(input: {
  toolName: string;
  projectId: string;
  runtimeProfileId: string | null | undefined;
  log: RuntimeProfileValidationLogger;
}): void {
  const runtimeProfileId = input.runtimeProfileId;
  if (!runtimeProfileId) return;

  const profile = findRuntimeProfileById(runtimeProfileId);
  if (!profile) {
    input.log.warn(
      { toolName: input.toolName, projectId: input.projectId, runtimeProfileId },
      "WARN [mcp:tool:*] Rejected unknown runtime profile",
    );
    throw validationError(`Runtime profile not found: ${runtimeProfileId}`, {
      runtimeProfileId: ["Runtime profile does not exist"],
    });
  }

  if (!profile.enabled) {
    input.log.warn(
      {
        toolName: input.toolName,
        projectId: input.projectId,
        runtimeProfileId,
      },
      "WARN [mcp:tool:*] Rejected disabled runtime profile",
    );
    throw validationError(`Runtime profile is disabled: ${runtimeProfileId}`, {
      runtimeProfileId: ["Runtime profile is disabled"],
    });
  }

  if (profile.projectId && profile.projectId !== input.projectId) {
    input.log.warn(
      {
        toolName: input.toolName,
        projectId: input.projectId,
        runtimeProfileId,
        profileProjectId: profile.projectId,
      },
      "WARN [mcp:tool:*] Rejected cross-project runtime profile",
    );
    throw validationError(
      `Runtime profile ${runtimeProfileId} does not belong to project ${input.projectId}`,
      {
        runtimeProfileId: ["Runtime profile belongs to another project"],
      },
    );
  }
}

export function buildEffectiveTaskRuntimeMetadata(
  taskId: string,
  projectId: string,
): TaskEffectiveRuntimeMetadata {
  const effective = resolveEffectiveRuntimeProfile({
    taskId,
    projectId,
    mode: "task",
    systemDefaultRuntimeProfileId: null,
  });

  return {
    source: effective.source,
    profileId: effective.profile?.id ?? null,
    runtimeId: effective.profile?.runtimeId ?? null,
    providerId: effective.profile?.providerId ?? null,
    profileName: effective.profile?.name ?? null,
  };
}
