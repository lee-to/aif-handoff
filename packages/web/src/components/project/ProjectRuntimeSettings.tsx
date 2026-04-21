import { useMemo, useState } from "react";
import type { Project, RuntimeProfile } from "@aif/shared/browser";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { useUpdateProject } from "@/hooks/useProjects";
import {
  useAppRuntimeDefaults,
  useCreateRuntimeProfile,
  useDeleteRuntimeProfile,
  useProjectRuntimeProfiles,
  useRuntimes,
  useRuntimeProfiles,
  useUpdateRuntimeProfile,
  useValidateRuntimeProfile,
} from "@/hooks/useRuntimeProfiles";
import { RuntimeProfileForm } from "@/components/settings/RuntimeProfileForm";
import { formatRuntimeProfileOptionLabel } from "@/lib/runtimeProfiles";

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
  const [planDefaultId, setPlanDefaultId] = useState(
    () => project.defaultPlanRuntimeProfileId ?? "",
  );
  const [reviewDefaultId, setReviewDefaultId] = useState(
    () => project.defaultReviewRuntimeProfileId ?? "",
  );
  const [chatDefaultId, setChatDefaultId] = useState(
    () => project.defaultChatRuntimeProfileId ?? "",
  );
  const [editingProfile, setEditingProfile] = useState<RuntimeProfile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<RuntimeProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusVariant, setStatusVariant] = useState<"success" | "error" | "neutral">("neutral");

  const updateProject = useUpdateProject();
  const createProfile = useCreateRuntimeProfile();
  const updateProfile = useUpdateRuntimeProfile();
  const deleteProfile = useDeleteRuntimeProfile();
  const validateProfile = useValidateRuntimeProfile();
  const { data: runtimes = [] } = useRuntimes();
  const { data: appRuntimeDefaults } = useAppRuntimeDefaults(isOpen);
  const { data: profiles = [], isLoading } = useRuntimeProfiles(project.id, true, isOpen);
  const { data: projectProfiles = [], isLoading: projectProfilesLoading } =
    useProjectRuntimeProfiles(project.id, isOpen);
  const globalProfiles = useMemo(
    () => profiles.filter((profile) => profile.projectId == null),
    [profiles],
  );

  const runtimeOptions = useMemo(() => {
    return profiles
      .filter((profile) => profile.enabled !== false)
      .map((profile) => ({
        id: profile.id,
        label: formatRuntimeProfileOptionLabel(profile),
      }));
  }, [profiles]);

  const taskDefaultEmptyLabel = appRuntimeDefaults?.resolvedDefaultTaskRuntimeProfileId
    ? "(app default)"
    : "(env fallback)";
  const planDefaultEmptyLabel =
    taskDefaultId ||
    appRuntimeDefaults?.resolvedDefaultPlanRuntimeProfileId ||
    appRuntimeDefaults?.resolvedDefaultTaskRuntimeProfileId
      ? taskDefaultId
        ? "(inherit from project task default)"
        : "(app default)"
      : "(env fallback)";
  const reviewDefaultEmptyLabel =
    taskDefaultId ||
    appRuntimeDefaults?.resolvedDefaultReviewRuntimeProfileId ||
    appRuntimeDefaults?.resolvedDefaultTaskRuntimeProfileId
      ? taskDefaultId
        ? "(inherit from project task default)"
        : "(app default)"
      : "(env fallback)";
  const chatDefaultEmptyLabel = appRuntimeDefaults?.resolvedDefaultChatRuntimeProfileId
    ? "(app default)"
    : "(env fallback)";
  const deletingProfileIsGlobal = deletingProfile?.projectId == null;

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
          defaultPlanRuntimeProfileId: planDefaultId || null,
          defaultReviewRuntimeProfileId: reviewDefaultId || null,
          defaultChatRuntimeProfileId: chatDefaultId || null,
        },
      });
      setStatusMessage("Project runtime defaults saved.");
      setStatusVariant("success");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save defaults");
      setStatusVariant("error");
    }
  };

  const handleValidateProfile = async (profileId: string) => {
    setStatusMessage(null);
    setStatusVariant("neutral");
    try {
      const result = await validateProfile.mutateAsync({ profileId, forceRefresh: true });
      const expectedEnvVar =
        result.details && typeof result.details.expectedEnvVar === "string"
          ? result.details.expectedEnvVar
          : null;
      if (result.ok) {
        setStatusMessage(`Validation OK: ${result.message}`);
        setStatusVariant("success");
        return;
      }
      const envHint = expectedEnvVar ? ` (expected env var: ${expectedEnvVar})` : "";
      setStatusMessage(`Validation failed: ${result.message}${envHint}`);
      setStatusVariant("error");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Validation failed");
      setStatusVariant("error");
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
    await updateProfile.mutateAsync({
      id: editingProfile.id,
      input: { ...input, projectId: project.id },
    });
    setEditingProfile(null);
  };

  const handleMakeProfileGlobal = async (profile: RuntimeProfile) => {
    setStatusMessage(null);
    setStatusVariant("neutral");
    try {
      await updateProfile.mutateAsync({
        id: profile.id,
        input: { projectId: null },
      });
      if (editingProfile?.id === profile.id) {
        setEditingProfile(null);
      }
      setStatusMessage(`"${profile.name}" is now available to all projects.`);
      setStatusVariant("success");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to make profile global");
      setStatusVariant("error");
    }
  };

  const handleCopyGlobalProfile = async (profile: RuntimeProfile) => {
    setStatusMessage(null);
    setStatusVariant("neutral");
    try {
      await createProfile.mutateAsync({
        projectId: project.id,
        name: profile.name,
        runtimeId: profile.runtimeId,
        providerId: profile.providerId,
        transport: profile.transport ?? null,
        baseUrl: profile.baseUrl ?? null,
        apiKeyEnvVar: profile.apiKeyEnvVar ?? null,
        defaultModel: profile.defaultModel ?? null,
        headers: profile.headers ?? {},
        options: profile.options ?? {},
        enabled: profile.enabled,
      });
      setStatusMessage(`Copied "${profile.name}" into this project.`);
      setStatusVariant("success");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to copy global profile into project",
      );
      setStatusVariant("error");
    }
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
          <p className="text-xs text-muted-foreground">Implementation (default)</p>
          <Select
            value={taskDefaultId}
            onChange={(e) => setTaskDefaultId(e.target.value)}
            placeholder={taskDefaultEmptyLabel}
            options={[
              { value: "", label: taskDefaultEmptyLabel },
              ...runtimeOptions.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Planning</p>
          <Select
            value={planDefaultId}
            onChange={(e) => setPlanDefaultId(e.target.value)}
            placeholder={planDefaultEmptyLabel}
            options={[
              { value: "", label: planDefaultEmptyLabel },
              ...runtimeOptions.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Review</p>
          <Select
            value={reviewDefaultId}
            onChange={(e) => setReviewDefaultId(e.target.value)}
            placeholder={reviewDefaultEmptyLabel}
            options={[
              { value: "", label: reviewDefaultEmptyLabel },
              ...runtimeOptions.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Chat</p>
          <Select
            value={chatDefaultId}
            onChange={(e) => setChatDefaultId(e.target.value)}
            placeholder={chatDefaultEmptyLabel}
            options={[
              { value: "", label: chatDefaultEmptyLabel },
              ...runtimeOptions.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
        </div>
      </div>

      <div>
        <Button size="sm" onClick={handleSaveDefaults} disabled={updateProject.isPending}>
          {updateProject.isPending ? "Saving..." : "Save Project Defaults"}
        </Button>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Project Profiles
        </p>
        <p className="text-[11px] text-muted-foreground">
          Project profiles are local to this project. Use Make Global to reuse one everywhere.
        </p>

        {creating ? (
          <RuntimeProfileForm
            mode="create"
            projectId={project.id}
            runtimes={runtimes}
            onSubmit={handleCreateProfile}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Button className="w-full" size="sm" variant="outline" onClick={() => setCreating(true)}>
            + New Project Profile
          </Button>
        )}

        {editingProfile && (
          <RuntimeProfileForm
            key={editingProfile.id}
            mode="edit"
            projectId={editingProfile.projectId}
            runtimes={runtimes}
            initial={editingProfile}
            onSubmit={handleUpdateProfile}
            onCancel={() => setEditingProfile(null)}
          />
        )}

        {isLoading || projectProfilesLoading ? (
          <p className="text-xs text-muted-foreground">Loading project runtime profiles...</p>
        ) : projectProfiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No project-specific runtime profiles configured.
          </p>
        ) : (
          <div className="space-y-1">
            {projectProfiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5"
              >
                <div>
                  <p className="text-xs font-medium">{formatRuntimeProfileOptionLabel(profile)}</p>
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleMakeProfileGlobal(profile)}
                    disabled={updateProfile.isPending}
                  >
                    Make Global
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingProfile(profile)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDeletingProfile(profile)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Global Profiles
        </p>
        <p className="text-[11px] text-muted-foreground">
          Available to this project by default. Copy one to create a project-local fork.
        </p>

        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading global runtime profiles...</p>
        ) : globalProfiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No global runtime profiles available.</p>
        ) : (
          <div className="space-y-1">
            {globalProfiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5"
              >
                <div>
                  <p className="text-xs font-medium">{formatRuntimeProfileOptionLabel(profile)}</p>
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCopyGlobalProfile(profile)}
                    disabled={createProfile.isPending}
                  >
                    Copy to Project
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDeletingProfile(profile)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {statusMessage && (
          <p
            className={`mt-2 text-xs ${
              statusVariant === "error"
                ? "text-red-500"
                : statusVariant === "success"
                  ? "text-green-500"
                  : "text-muted-foreground"
            }`}
          >
            {statusMessage}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={deletingProfile !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingProfile(null);
        }}
        title={deletingProfileIsGlobal ? "Delete Global Runtime Profile" : "Delete Runtime Profile"}
        description={
          deletingProfileIsGlobal
            ? `Delete "${deletingProfile?.name}" globally? Projects using this profile will fall back to project, app, or environment defaults.`
            : `Delete "${deletingProfile?.name}"? Tasks and projects using this profile will fall back to defaults.`
        }
        confirmLabel="Delete"
        variant="destructive"
        disabled={deleteProfile.isPending}
        onConfirm={() => {
          if (!deletingProfile) return;
          void deleteProfile.mutateAsync(deletingProfile.id).then(() => setDeletingProfile(null));
        }}
      />
    </div>
  );
}
