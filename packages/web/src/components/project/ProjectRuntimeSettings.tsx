import { useMemo, useState } from "react";
import type { Project, RuntimeProfile } from "@aif/shared/browser";
import { Button } from "@/components/ui/button";
import { useUpdateProject } from "@/hooks/useProjects";
import {
  useCreateRuntimeProfile,
  useDeleteRuntimeProfile,
  useRuntimes,
  useRuntimeProfiles,
  useUpdateRuntimeProfile,
  useValidateRuntimeProfile,
} from "@/hooks/useRuntimeProfiles";
import { RuntimeProfileForm } from "@/components/settings/RuntimeProfileForm";

interface Props {
  project: Project;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

export function ProjectRuntimeSettings({
  project,
  open,
  onOpenChange,
  hideTrigger = false,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpenState = (next: boolean) => {
    onOpenChange?.(next);
    if (open === undefined) {
      setInternalOpen(next);
    }
  };
  const [taskDefaultId, setTaskDefaultId] = useState(
    () => project.defaultTaskRuntimeProfileId ?? "",
  );
  const [chatDefaultId, setChatDefaultId] = useState(
    () => project.defaultChatRuntimeProfileId ?? "",
  );
  const [editingProfile, setEditingProfile] = useState<RuntimeProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const updateProject = useUpdateProject();
  const createProfile = useCreateRuntimeProfile();
  const updateProfile = useUpdateRuntimeProfile();
  const deleteProfile = useDeleteRuntimeProfile();
  const validateProfile = useValidateRuntimeProfile();
  const { data: runtimes = [] } = useRuntimes();
  const { data: profiles = [], isLoading } = useRuntimeProfiles(project.id, true);

  const runtimeOptions = useMemo(() => {
    return profiles.map((profile) => ({
      id: profile.id,
      label: `${profile.name} (${profile.runtimeId}/${profile.providerId})`,
    }));
  }, [profiles]);

  const handleSaveDefaults = async () => {
    setStatusMessage(null);
    try {
      await updateProject.mutateAsync({
        id: project.id,
        input: {
          name: project.name,
          rootPath: project.rootPath,
          plannerMaxBudgetUsd: project.plannerMaxBudgetUsd ?? undefined,
          planCheckerMaxBudgetUsd: project.planCheckerMaxBudgetUsd ?? undefined,
          implementerMaxBudgetUsd: project.implementerMaxBudgetUsd ?? undefined,
          reviewSidecarMaxBudgetUsd: project.reviewSidecarMaxBudgetUsd ?? undefined,
          parallelEnabled: project.parallelEnabled,
          defaultTaskRuntimeProfileId: taskDefaultId || null,
          defaultChatRuntimeProfileId: chatDefaultId || null,
        },
      });
      setStatusMessage("Project runtime defaults saved.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save defaults");
    }
  };

  const handleValidateProfile = async (profileId: string) => {
    setStatusMessage(null);
    try {
      const result = await validateProfile.mutateAsync({ profileId, forceRefresh: true });
      const expectedEnvVar =
        result.details && typeof result.details.expectedEnvVar === "string"
          ? result.details.expectedEnvVar
          : null;
      if (result.ok) {
        setStatusMessage(`Validation OK: ${result.message}`);
        return;
      }
      const envHint = expectedEnvVar ? ` (expected env var: ${expectedEnvVar})` : "";
      setStatusMessage(`Validation failed: ${result.message}${envHint}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Validation failed");
    }
  };

  const handleCreateProfile = async (input: {
    projectId?: string | null;
    name: string;
    runtimeId: string;
    providerId: string;
    transport?: string | null;
    baseUrl?: string | null;
    apiKeyEnvVar?: string | null;
    defaultModel?: string | null;
    headers?: Record<string, string>;
    options?: Record<string, unknown>;
    enabled?: boolean;
  }) => {
    await createProfile.mutateAsync({ ...input, projectId: project.id });
    setCreating(false);
  };

  const handleUpdateProfile = async (input: {
    projectId?: string | null;
    name: string;
    runtimeId: string;
    providerId: string;
    transport?: string | null;
    baseUrl?: string | null;
    apiKeyEnvVar?: string | null;
    defaultModel?: string | null;
    headers?: Record<string, string>;
    options?: Record<string, unknown>;
    enabled?: boolean;
  }) => {
    if (!editingProfile) return;
    await updateProfile.mutateAsync({ id: editingProfile.id, input });
    setEditingProfile(null);
  };

  if (!isOpen) {
    if (hideTrigger) return null;
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpenState(true)}>
        Runtime Profiles
      </Button>
    );
  }

  return (
    <div className="mb-4 space-y-3 border border-border bg-card/50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Runtime Profiles</h3>
        <Button size="sm" variant="ghost" onClick={() => setOpenState(false)}>
          Close
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Default task runtime profile</p>
          <select
            className="h-9 w-full rounded border border-input bg-background px-2 text-sm"
            value={taskDefaultId}
            onChange={(e) => setTaskDefaultId(e.target.value)}
          >
            <option value="">(none)</option>
            {runtimeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Default chat runtime profile</p>
          <select
            className="h-9 w-full rounded border border-input bg-background px-2 text-sm"
            value={chatDefaultId}
            onChange={(e) => setChatDefaultId(e.target.value)}
          >
            <option value="">(none)</option>
            {runtimeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Button size="sm" onClick={handleSaveDefaults} disabled={updateProject.isPending}>
          {updateProject.isPending ? "Saving..." : "Save Project Defaults"}
        </Button>
      </div>

      {statusMessage && <p className="text-xs text-muted-foreground">{statusMessage}</p>}

      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Profiles
          </p>
          <Button size="sm" variant="outline" onClick={() => setCreating((value) => !value)}>
            {creating ? "Hide Form" : "New Profile"}
          </Button>
        </div>

        {creating && (
          <RuntimeProfileForm
            mode="create"
            projectId={project.id}
            runtimes={runtimes}
            onSubmit={handleCreateProfile}
            onCancel={() => setCreating(false)}
          />
        )}

        {editingProfile && (
          <RuntimeProfileForm
            mode="edit"
            projectId={editingProfile.projectId}
            runtimes={runtimes}
            initial={editingProfile}
            onSubmit={handleUpdateProfile}
            onCancel={() => setEditingProfile(null)}
          />
        )}

        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading runtime profiles...</p>
        ) : profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runtime profiles configured.</p>
        ) : (
          <div className="space-y-1">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5"
              >
                <div>
                  <p className="text-xs font-medium">
                    {profile.name}{" "}
                    <span className="text-muted-foreground">
                      ({profile.runtimeId}/{profile.providerId})
                    </span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    transport={profile.transport ?? "default"} model=
                    {profile.defaultModel ?? "auto"} {profile.enabled ? "" : "disabled"}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleValidateProfile(profile.id)}
                    disabled={validateProfile.isPending}
                  >
                    Validate
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingProfile(profile)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void deleteProfile.mutateAsync(profile.id)}
                    disabled={deleteProfile.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
