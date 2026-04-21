import { findRuntimeProfileById } from "@aif/data";

type RuntimeProfileSelectionMap = Record<string, string | null | undefined>;

type ValidationFailure = {
  error: string;
  fieldErrors: Record<string, string[]>;
};

function addFieldError(
  fieldErrors: Record<string, string[]>,
  field: string,
  message: string,
): void {
  const existing = fieldErrors[field] ?? [];
  existing.push(message);
  fieldErrors[field] = existing;
}

export function validateProjectScopedRuntimeProfileSelections(input: {
  projectId?: string | null;
  selections: RuntimeProfileSelectionMap;
}): ValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(input.selections)) {
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    const isEnabled = profile != null && profile.enabled !== false;
    const isVisible =
      profile != null &&
      (profile.projectId == null ||
        (input.projectId != null && profile.projectId === input.projectId));

    if (!isVisible || !isEnabled) {
      addFieldError(
        fieldErrors,
        field,
        input.projectId == null
          ? "Must reference an enabled global runtime profile"
          : "Must reference an enabled global or same-project runtime profile",
      );
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null;
  }

  return {
    error: "Invalid runtime profile selection",
    fieldErrors,
  };
}

export function validateAppRuntimeDefaultSelections(
  selections: RuntimeProfileSelectionMap,
): ValidationFailure | null {
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, runtimeProfileId] of Object.entries(selections)) {
    if (runtimeProfileId === undefined || runtimeProfileId === null) continue;

    const profile = findRuntimeProfileById(runtimeProfileId);
    const isEligible = profile != null && profile.projectId == null && profile.enabled;

    if (!isEligible) {
      addFieldError(fieldErrors, field, "Must reference an enabled global runtime profile");
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null;
  }

  return {
    error: "Invalid app runtime defaults",
    fieldErrors,
  };
}
