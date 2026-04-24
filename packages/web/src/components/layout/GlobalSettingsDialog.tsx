import { useEffect, useMemo, useState } from "react";
import { Loader2, Check, Cpu, X as XIcon } from "lucide-react";
import type { RuntimeProfile } from "@aif/shared/browser";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { ConfigEditor } from "@/components/settings/ConfigEditor";
import { RuntimeProfileForm } from "@/components/settings/RuntimeProfileForm";
import {
  useAppRuntimeDefaults,
  useCreateRuntimeProfile,
  useDeleteRuntimeProfile,
  useGlobalRuntimeProfiles,
  useRuntimes,
  useUpdateAppRuntimeDefaults,
  useUpdateRuntimeProfile,
  useValidateRuntimeProfile,
} from "@/hooks/useRuntimeProfiles";
import { api } from "@/lib/api";
import { formatRuntimeProfileOptionLabel } from "@/lib/runtimeProfiles";
import type { AifConfig } from "@/lib/api";

interface McpRuntimeStatus {
  runtimeId: string;
  installed: boolean;
}

interface GlobalSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}

export function GlobalSettingsDialog({ open, onOpenChange, projectId }: GlobalSettingsDialogProps) {
  const [mcpInstalled, setMcpInstalled] = useState<boolean | null>(null);
  const [mcpRuntimes, setMcpRuntimes] = useState<McpRuntimeStatus[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [configExists, setConfigExists] = useState<boolean | null>(null);
  const [configData, setConfigData] = useState<AifConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [taskDefaultIdDraft, setTaskDefaultIdDraft] = useState<string | null>(null);
  const [planDefaultIdDraft, setPlanDefaultIdDraft] = useState<string | null>(null);
  const [reviewDefaultIdDraft, setReviewDefaultIdDraft] = useState<string | null>(null);
  const [chatDefaultIdDraft, setChatDefaultIdDraft] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<RuntimeProfile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<RuntimeProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusVariant, setStatusVariant] = useState<"success" | "error" | "neutral">("neutral");

  const { data: globalProfiles = [], isLoading: profilesLoading } = useGlobalRuntimeProfiles(open);
  const { data: runtimes = [] } = useRuntimes(open);
  const { data: appRuntimeDefaults } = useAppRuntimeDefaults(open);
  const updateAppDefaults = useUpdateAppRuntimeDefaults();
  const createProfile = useCreateRuntimeProfile();
  const updateProfile = useUpdateRuntimeProfile();
  const deleteProfile = useDeleteRuntimeProfile();
  const validateProfile = useValidateRuntimeProfile();

  const enabledGlobalProfiles = useMemo(
    () => globalProfiles.filter((profile) => profile.enabled),
    [globalProfiles],
  );
  const enabledGlobalProfileIds = useMemo(
    () => new Set(enabledGlobalProfiles.map((profile) => profile.id)),
    [enabledGlobalProfiles],
  );

  useEffect(() => {
    if (!open) return;
    api.getMcpStatus().then(
      (res) => {
        setMcpInstalled(res.installed);
        setMcpRuntimes(
          (res.runtimes ?? []).map(
            (runtime: { runtimeId: string; success?: boolean; installed?: boolean }) => ({
              runtimeId: runtime.runtimeId,
              installed: runtime.installed ?? runtime.success ?? false,
            }),
          ),
        );
      },
      () => setMcpInstalled(null),
    );
    if (projectId) {
      api.getConfigStatus(projectId).then(
        (res) => {
          setConfigExists(res.exists);
          if (res.exists) {
            setConfigLoading(true);
            api.getConfig(projectId).then(
              (result) => {
                setConfigData(result.config);
                setConfigLoading(false);
              },
              () => setConfigLoading(false),
            );
          }
        },
        () => setConfigExists(false),
      );
    }
  }, [open, projectId]);

  const normalizeDefaultId = (runtimeProfileId: string | null | undefined) =>
    runtimeProfileId && enabledGlobalProfileIds.has(runtimeProfileId) ? runtimeProfileId : "";

  const hasUnavailablePersistedDefault = useMemo(() => {
    if (!open || !appRuntimeDefaults || profilesLoading) return false;
    return [
      appRuntimeDefaults.defaultTaskRuntimeProfileId,
      appRuntimeDefaults.defaultPlanRuntimeProfileId,
      appRuntimeDefaults.defaultReviewRuntimeProfileId,
      appRuntimeDefaults.defaultChatRuntimeProfileId,
    ].some(
      (runtimeProfileId) => runtimeProfileId && !enabledGlobalProfileIds.has(runtimeProfileId),
    );
  }, [appRuntimeDefaults, enabledGlobalProfileIds, open, profilesLoading]);

  const taskDefaultId =
    taskDefaultIdDraft ?? normalizeDefaultId(appRuntimeDefaults?.defaultTaskRuntimeProfileId);
  const planDefaultId =
    planDefaultIdDraft ?? normalizeDefaultId(appRuntimeDefaults?.defaultPlanRuntimeProfileId);
  const reviewDefaultId =
    reviewDefaultIdDraft ?? normalizeDefaultId(appRuntimeDefaults?.defaultReviewRuntimeProfileId);
  const chatDefaultId =
    chatDefaultIdDraft ?? normalizeDefaultId(appRuntimeDefaults?.defaultChatRuntimeProfileId);

  const visibleStatusMessage =
    statusMessage ??
    (hasUnavailablePersistedDefault
      ? "One or more disabled app defaults are no longer selectable and will be cleared on save."
      : null);
  const visibleStatusVariant = statusMessage ? statusVariant : "neutral";

  const runtimeOptions = useMemo(() => {
    return enabledGlobalProfiles.map((profile) => ({
      id: profile.id,
      label: formatRuntimeProfileOptionLabel(profile),
    }));
  }, [enabledGlobalProfiles]);

  const handleMcpInstall = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const res = await api.installMcp();
      setMcpInstalled(res.success);
      setMcpRuntimes(
        (res.runtimes ?? []).map(
          (runtime: { runtimeId: string; success?: boolean; installed?: boolean }) => ({
            runtimeId: runtime.runtimeId,
            installed: runtime.installed ?? runtime.success ?? false,
          }),
        ),
      );
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "Failed to install");
    } finally {
      setMcpLoading(false);
    }
  };

  const handleMcpRemove = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      await api.removeMcp();
      setMcpInstalled(false);
      setMcpRuntimes((prev) => prev.map((runtime) => ({ ...runtime, installed: false })));
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setMcpLoading(false);
    }
  };

  const handleSaveDefaults = async () => {
    setStatusMessage(null);
    setStatusVariant("neutral");
    const sanitizeDefaultId = (runtimeProfileId: string) =>
      runtimeProfileId && enabledGlobalProfileIds.has(runtimeProfileId) ? runtimeProfileId : null;

    try {
      await updateAppDefaults.mutateAsync({
        defaultTaskRuntimeProfileId: sanitizeDefaultId(taskDefaultId),
        defaultPlanRuntimeProfileId: sanitizeDefaultId(planDefaultId),
        defaultReviewRuntimeProfileId: sanitizeDefaultId(reviewDefaultId),
        defaultChatRuntimeProfileId: sanitizeDefaultId(chatDefaultId),
      });
      setStatusMessage("Global runtime defaults saved.");
      setStatusVariant("success");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save defaults");
      setStatusVariant("error");
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setMcpInstalled(null);
      setMcpRuntimes([]);
      setMcpLoading(false);
      setMcpError(null);
      setConfigExists(null);
      setConfigData(null);
      setConfigLoading(false);
      setTaskDefaultIdDraft(null);
      setPlanDefaultIdDraft(null);
      setReviewDefaultIdDraft(null);
      setChatDefaultIdDraft(null);
      setEditingProfile(null);
      setDeletingProfile(null);
      setCreating(false);
      setStatusMessage(null);
      setStatusVariant("neutral");
    }
    onOpenChange(nextOpen);
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
    await createProfile.mutateAsync({ ...input, projectId: null });
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
      input: { ...input, projectId: null },
    });
    setEditingProfile(null);
  };

  const handleCopyProfileToProject = async (profile: RuntimeProfile) => {
    if (!projectId) return;
    setStatusMessage(null);
    setStatusVariant("neutral");
    try {
      await createProfile.mutateAsync({
        projectId,
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
      setStatusMessage(`Copied "${profile.name}" into the current project.`);
      setStatusVariant("success");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to copy profile into the project",
      );
      setStatusVariant("error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogClose onClose={() => handleDialogOpenChange(false)} />
        <DialogHeader>
          <DialogTitle>Global Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="border border-border bg-card/50 px-3 py-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-medium">Global Runtime Profiles</p>
                <p className="text-xs text-muted-foreground">
                  Reusable profiles and app-wide defaults for task, plan, review, and chat flows.
                </p>
                {projectId && (
                  <p className="text-[11px] text-muted-foreground">
                    Copy a global profile into the current project when you need a local fork.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Implementation</p>
                <Select
                  value={taskDefaultId}
                  onChange={(e) => setTaskDefaultIdDraft(e.target.value)}
                  placeholder="(env fallback)"
                  options={[
                    { value: "", label: "(env fallback)" },
                    ...runtimeOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Planning</p>
                <Select
                  value={planDefaultId}
                  onChange={(e) => setPlanDefaultIdDraft(e.target.value)}
                  placeholder="(inherit from task default)"
                  options={[
                    { value: "", label: "(inherit from task default)" },
                    ...runtimeOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Review</p>
                <Select
                  value={reviewDefaultId}
                  onChange={(e) => setReviewDefaultIdDraft(e.target.value)}
                  placeholder="(inherit from task default)"
                  options={[
                    { value: "", label: "(inherit from task default)" },
                    ...runtimeOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Chat</p>
                <Select
                  value={chatDefaultId}
                  onChange={(e) => setChatDefaultIdDraft(e.target.value)}
                  placeholder="(env fallback)"
                  options={[
                    { value: "", label: "(env fallback)" },
                    ...runtimeOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </div>
            </div>

            <p className="mt-2 text-[11px] text-muted-foreground">
              Resolution order: task override or project default, then app default, then environment
              fallback.
            </p>

            <div className="mt-3">
              <Button size="sm" onClick={handleSaveDefaults} disabled={updateAppDefaults.isPending}>
                {updateAppDefaults.isPending ? "Saving..." : "Save Runtime Defaults"}
              </Button>
            </div>

            <div className="mt-3 space-y-2 border-t border-border pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Global Profiles
              </p>

              {creating ? (
                <RuntimeProfileForm
                  mode="create"
                  projectId={null}
                  runtimes={runtimes}
                  onSubmit={handleCreateProfile}
                  onCancel={() => setCreating(false)}
                />
              ) : (
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  onClick={() => setCreating(true)}
                >
                  + New Global Profile
                </Button>
              )}

              {editingProfile && (
                <RuntimeProfileForm
                  key={editingProfile.id}
                  mode="edit"
                  projectId={null}
                  runtimes={runtimes}
                  initial={editingProfile}
                  onSubmit={handleUpdateProfile}
                  onCancel={() => setEditingProfile(null)}
                />
              )}

              {profilesLoading ? (
                <p className="text-xs text-muted-foreground">Loading global runtime profiles...</p>
              ) : globalProfiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No global runtime profiles configured.
                </p>
              ) : (
                <div className="space-y-1">
                  {globalProfiles.map((profile) => (
                    <div
                      key={profile.id}
                      className="flex items-center justify-between rounded border border-border bg-background/40 px-2 py-1.5"
                    >
                      <div>
                        <p className="text-xs font-medium">
                          {formatRuntimeProfileOptionLabel(profile)}
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
                        {projectId && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleCopyProfileToProject(profile)}
                            disabled={createProfile.isPending}
                          >
                            Copy to Project
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingProfile(profile)}
                        >
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

              {visibleStatusMessage && (
                <p
                  className={`text-xs ${
                    visibleStatusVariant === "error"
                      ? "text-red-500"
                      : visibleStatusVariant === "success"
                        ? "text-green-500"
                        : "text-muted-foreground"
                  }`}
                >
                  {visibleStatusMessage}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between border border-border bg-card/50 px-3 py-2">
            <div className="mr-3 flex-1">
              <p className="text-sm font-medium">MCP Handoff Server</p>
              <p className="text-xs text-muted-foreground">
                Enables AI runtimes to read and sync tasks via MCP tools
              </p>
              {mcpInstalled === null && !mcpError && (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking...
                </p>
              )}
              {mcpRuntimes.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {mcpRuntimes.map((runtime) => (
                    <p
                      key={runtime.runtimeId}
                      className={`flex items-center gap-1 text-xs ${runtime.installed ? "text-green-400" : "text-muted-foreground"}`}
                    >
                      {runtime.installed ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <XIcon className="h-3 w-3" />
                      )}
                      {runtime.runtimeId}: {runtime.installed ? "installed" : "not configured"}
                    </p>
                  ))}
                </div>
              )}
              {mcpInstalled === false && mcpRuntimes.length === 0 && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-400">
                  <XIcon className="h-3 w-3" />
                  Not configured
                </p>
              )}
              {mcpError && <p className="mt-1 text-xs text-destructive">{mcpError}</p>}
            </div>
            <div>
              {mcpInstalled === false && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void handleMcpInstall()}
                  disabled={mcpLoading}
                  className="min-w-20 gap-1"
                >
                  {mcpLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Install"}
                </Button>
              )}
              {mcpInstalled === true && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void handleMcpRemove()}
                  disabled={mcpLoading}
                  className="min-w-20 gap-1 text-destructive hover:border-destructive/70"
                >
                  {mcpLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Remove"}
                </Button>
              )}
            </div>
          </div>

          {configExists && (
            <div className="border border-border bg-card/50 px-3 py-2">
              <p className="mb-0.5 text-sm font-medium">AI Factory Config</p>
              <p className="mb-3 text-xs text-muted-foreground">.ai-factory/config.yaml</p>
              {configLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : configData ? (
                <ConfigEditor
                  config={configData}
                  onConfigChange={setConfigData}
                  projectId={projectId!}
                />
              ) : null}
            </div>
          )}
        </div>

        <ConfirmDialog
          open={deletingProfile !== null}
          onOpenChange={(next) => {
            if (!next) setDeletingProfile(null);
          }}
          title="Delete Global Runtime Profile"
          description={`Delete "${deletingProfile?.name}"? Projects using this profile will fall back to project, app, or environment defaults.`}
          confirmLabel="Delete"
          variant="destructive"
          disabled={deleteProfile.isPending}
          onConfirm={() => {
            if (!deletingProfile) return;
            void deleteProfile.mutateAsync(deletingProfile.id).then(() => setDeletingProfile(null));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
