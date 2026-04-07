import { useEffect, useState } from "react";
import { Loader2, Check, X as XIcon } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfigEditor } from "@/components/settings/ConfigEditor";
import { api } from "@/lib/api";
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

  useEffect(() => {
    if (!open) return;
    setMcpError(null);
    setMcpInstalled(null);
    setMcpRuntimes([]);
    setMcpLoading(false);
    api.getMcpStatus().then(
      (res) => {
        setMcpInstalled(res.installed);
        setMcpRuntimes(
          (res.runtimes ?? []).map(
            (r: { runtimeId: string; success?: boolean; installed?: boolean }) => ({
              runtimeId: r.runtimeId,
              installed: r.installed ?? r.success ?? false,
            }),
          ),
        );
      },
      () => setMcpInstalled(null),
    );
    setConfigData(null);
    if (projectId) {
      api.getConfigStatus(projectId).then(
        (res) => {
          setConfigExists(res.exists);
          if (res.exists) {
            setConfigLoading(true);
            api.getConfig(projectId).then(
              (r) => {
                setConfigData(r.config);
                setConfigLoading(false);
              },
              () => setConfigLoading(false),
            );
          }
        },
        () => setConfigExists(false),
      );
    } else {
      setConfigExists(false);
    }
  }, [open, projectId]);

  const handleMcpInstall = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const res = await api.installMcp();
      setMcpInstalled(res.success);
      setMcpRuntimes(
        (res.runtimes ?? []).map(
          (r: { runtimeId: string; success?: boolean; installed?: boolean }) => ({
            runtimeId: r.runtimeId,
            installed: r.installed ?? r.success ?? false,
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
      setMcpRuntimes((prev) => prev.map((r) => ({ ...r, installed: false })));
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setMcpLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader>
          <DialogTitle>Global Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between border border-border bg-card/50 px-3 py-2">
            <div className="flex-1 mr-3">
              <p className="text-sm font-medium">MCP Handoff Server</p>
              <p className="text-xs text-muted-foreground">
                Enables AI runtimes to read and sync tasks via MCP tools
              </p>
              {mcpInstalled === null && !mcpError && (
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking...
                </p>
              )}
              {mcpRuntimes.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {mcpRuntimes.map((rt) => (
                    <p
                      key={rt.runtimeId}
                      className={`text-xs flex items-center gap-1 ${rt.installed ? "text-green-400" : "text-muted-foreground"}`}
                    >
                      {rt.installed ? <Check className="h-3 w-3" /> : <XIcon className="h-3 w-3" />}
                      {rt.runtimeId}: {rt.installed ? "installed" : "not configured"}
                    </p>
                  ))}
                </div>
              )}
              {mcpInstalled === false && mcpRuntimes.length === 0 && (
                <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                  <XIcon className="h-3 w-3" />
                  Not configured
                </p>
              )}
              {mcpError && <p className="text-xs text-destructive mt-1">{mcpError}</p>}
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
              <p className="text-sm font-medium mb-0.5">AI Factory Config</p>
              <p className="text-xs text-muted-foreground mb-3">.ai-factory/config.yaml</p>
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
      </DialogContent>
    </Dialog>
  );
}
