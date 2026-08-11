import { useState, type FormEvent } from "react";
import { KeyRound, Plus, UserX } from "lucide-react";
import type { Participant, ParticipantRole } from "@aif/shared/browser";
import { AlertBox } from "@/components/ui/alert-box";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableHeaderCell } from "@/components/ui/table-header-cell";
import {
  useCreateParticipant,
  useDeactivateParticipant,
  useParticipants,
  useResetParticipantPassword,
  useUpdateParticipant,
} from "@/hooks/useParticipants";

interface ParticipantManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentParticipantId: string;
}

const ROLE_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ParticipantManagementDialog({
  open,
  onOpenChange,
  currentParticipantId,
}: ParticipantManagementDialogProps) {
  const participantsQuery = useParticipants(open);
  const createParticipant = useCreateParticipant();
  const updateParticipant = useUpdateParticipant();
  const deactivateParticipant = useDeactivateParticipant();
  const resetPassword = useResetParticipantPassword();
  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ParticipantRole>("member");
  const [createError, setCreateError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<Participant | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Participant | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeCreate = () => {
    setCreateOpen(false);
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("member");
    setCreateError(null);
  };

  const closeReset = () => {
    setResetTarget(null);
    setResetValue("");
    setResetError(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    try {
      await createParticipant.mutateAsync({
        username: username.trim(),
        displayName: displayName.trim(),
        password,
        role,
      });
      closeCreate();
    } catch (error) {
      setCreateError(errorMessage(error, "Failed to create participant"));
    } finally {
      setPassword("");
    }
  };

  const handleReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetTarget) return;
    setResetError(null);
    try {
      await resetPassword.mutateAsync({
        id: resetTarget.id,
        input: { password: resetValue },
      });
      closeReset();
    } catch (error) {
      setResetError(errorMessage(error, "Failed to reset password"));
    } finally {
      setResetValue("");
    }
  };

  const handleRoleChange = async (participant: Participant, nextRole: ParticipantRole) => {
    if (participant.role === nextRole) return;
    setActionError(null);
    try {
      await updateParticipant.mutateAsync({
        id: participant.id,
        input: { role: nextRole },
      });
    } catch (error) {
      setActionError(errorMessage(error, "Failed to update participant role"));
    }
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setActionError(null);
    try {
      await deactivateParticipant.mutateAsync(deactivateTarget.id);
      setDeactivateTarget(null);
    } catch (error) {
      setActionError(errorMessage(error, "Failed to deactivate participant"));
      setDeactivateTarget(null);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closeCreate();
      closeReset();
      setDeactivateTarget(null);
      setActionError(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-5xl">
          <DialogClose onClose={() => handleOpenChange(false)} />
          <DialogHeader className="pr-8">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <DialogTitle>Participants</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  Create accounts, change roles, reset passwords, and revoke access.
                </p>
              </div>
              <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Create participant
              </Button>
            </div>
          </DialogHeader>

          {actionError && (
            <AlertBox variant="error" className="mb-4">
              {actionError}
            </AlertBox>
          )}
          {participantsQuery.isError && (
            <AlertBox variant="error">
              {errorMessage(participantsQuery.error, "Failed to load participants")}
            </AlertBox>
          )}

          <div className="overflow-x-auto border border-border">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="border-b border-border bg-muted">
                <tr>
                  <TableHeaderCell>Participant</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell className="text-right">Actions</TableHeaderCell>
                </tr>
              </thead>
              <tbody>
                {participantsQuery.isLoading && (
                  <tr>
                    <td className="px-3 py-6 text-muted-foreground" colSpan={4}>
                      Loading participants...
                    </td>
                  </tr>
                )}
                {participantsQuery.data?.map((participant) => (
                  <tr key={participant.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <p className="font-medium text-foreground">{participant.displayName}</p>
                      <p className="font-mono text-3xs text-muted-foreground">
                        @{participant.username}
                        {participant.id === currentParticipantId ? " · you" : ""}
                      </p>
                    </td>
                    <td className="w-36 px-3 py-2">
                      <Select
                        value={participant.role}
                        options={[...ROLE_OPTIONS]}
                        onChange={(event) =>
                          void handleRoleChange(participant, event.target.value as ParticipantRole)
                        }
                        selectSize="sm"
                        disabled={!participant.active || updateParticipant.isPending}
                      />
                    </td>
                    <td className="w-28 px-3 py-2">
                      <Badge size="sm" variant={participant.active ? "default" : "secondary"}>
                        {participant.active ? "ACTIVE" : "INACTIVE"}
                      </Badge>
                    </td>
                    <td className="w-56 px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="gap-1"
                          disabled={!participant.active}
                          onClick={() => setResetTarget(participant)}
                        >
                          <KeyRound className="h-3 w-3" />
                          Reset
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="gap-1 text-destructive"
                          disabled={
                            !participant.active ||
                            participant.id === currentParticipantId ||
                            deactivateParticipant.isPending
                          }
                          title={
                            participant.id === currentParticipantId
                              ? "You cannot deactivate your active account"
                              : "Deactivate participant"
                          }
                          onClick={() => setDeactivateTarget(participant)}
                        >
                          <UserX className="h-3 w-3" />
                          Deactivate
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!participantsQuery.isLoading && participantsQuery.data?.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-muted-foreground" colSpan={4}>
                      No participants found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      <FormDialog
        open={createOpen}
        onOpenChange={(nextOpen) => (nextOpen ? setCreateOpen(true) : closeCreate())}
        title="Create participant"
        error={createError ?? undefined}
        className="max-w-md"
        actions={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-participant-form"
              size="sm"
              disabled={
                createParticipant.isPending ||
                !username.trim() ||
                !displayName.trim() ||
                password.length < 12
              }
            >
              {createParticipant.isPending ? "Creating..." : "Create"}
            </Button>
          </>
        }
      >
        <form id="create-participant-form" className="space-y-4" onSubmit={handleCreate}>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Username</span>
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Display name</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Temporary password</span>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
            <span className="block text-xs font-normal text-muted-foreground">
              At least 12 characters.
            </span>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Role</span>
            <Select
              value={role}
              options={[...ROLE_OPTIONS]}
              onChange={(event) => setRole(event.target.value as ParticipantRole)}
            />
          </label>
        </form>
      </FormDialog>

      <FormDialog
        open={resetTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeReset();
        }}
        title={`Reset password${resetTarget ? ` for ${resetTarget.displayName}` : ""}`}
        error={resetError ?? undefined}
        className="max-w-md"
        actions={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={closeReset}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="reset-participant-password-form"
              size="sm"
              disabled={resetPassword.isPending || resetValue.length < 12}
            >
              {resetPassword.isPending ? "Resetting..." : "Reset password"}
            </Button>
          </>
        }
      >
        <form id="reset-participant-password-form" onSubmit={handleReset}>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>New password</span>
            <Input
              type="password"
              value={resetValue}
              onChange={(event) => setResetValue(event.target.value)}
              autoComplete="new-password"
              autoFocus
            />
            <span className="block text-xs font-normal text-muted-foreground">
              At least 12 characters. Existing sessions will be revoked.
            </span>
          </label>
        </form>
      </FormDialog>

      <ConfirmDialog
        open={deactivateTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeactivateTarget(null);
        }}
        title="Deactivate participant"
        description={`Deactivate ${deactivateTarget?.displayName ?? "this participant"}? Their sessions and task assignments will be revoked.`}
        confirmLabel={deactivateParticipant.isPending ? "Deactivating..." : "Deactivate"}
        variant="destructive"
        disabled={deactivateParticipant.isPending}
        onConfirm={() => void handleDeactivate()}
      />
    </>
  );
}
