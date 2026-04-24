import type { RuntimeProfile } from "@aif/shared/browser";

export function isGlobalRuntimeProfile(profile: Pick<RuntimeProfile, "projectId">): boolean {
  return profile.projectId == null;
}

export function getRuntimeProfileScopeLabel(
  profile: Pick<RuntimeProfile, "projectId">,
): "Global" | "Project" {
  return isGlobalRuntimeProfile(profile) ? "Global" : "Project";
}

export function formatRuntimeProfileName(
  profile: Pick<RuntimeProfile, "name" | "projectId">,
): string {
  return `${profile.name} [${getRuntimeProfileScopeLabel(profile)}]`;
}

export function formatRuntimeProfileOptionLabel(
  profile: Pick<RuntimeProfile, "name" | "projectId" | "runtimeId" | "providerId">,
): string {
  return `${formatRuntimeProfileName(profile)} (${profile.runtimeId}/${profile.providerId})`;
}
