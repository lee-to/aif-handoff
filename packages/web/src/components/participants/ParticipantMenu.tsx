import { useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, LogOut, Users } from "lucide-react";
import type { ParticipantSummary } from "@aif/shared/browser";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ParticipantMenuProps {
  participant: ParticipantSummary;
  onManageParticipants: () => void;
  onLogout: () => Promise<unknown>;
  isLoggingOut: boolean;
  onChangePassword: (input: { currentPassword: string; newPassword: string }) => Promise<unknown>;
  isChangingPassword: boolean;
}

export function ParticipantMenu({
  participant,
  onManageParticipants,
  onLogout,
  isLoggingOut,
  onChangePassword,
  isChangingPassword,
}: ParticipantMenuProps) {
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const closePasswordDialog = () => {
    setPasswordOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  };

  const handlePasswordChange = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }
    setPasswordError(null);
    try {
      await onChangePassword({ currentPassword, newPassword });
      closePasswordDialog();
    } catch (error) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(error instanceof Error ? error.message : "Password change failed.");
    }
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 px-2"
            aria-label={`Participant menu for ${participant.displayName}`}
          >
            <Avatar name={participant.displayName} size="sm" />
            <span className="hidden max-w-36 truncate font-mono text-2xs md:inline">
              {participant.displayName}
            </span>
            <Badge size="xs" variant={participant.role === "admin" ? "default" : "secondary"}>
              {participant.role.toUpperCase()}
            </Badge>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="border-b border-border px-2 py-2">
            <p className="truncate text-sm font-medium text-popover-foreground">
              {participant.displayName}
            </p>
            <p className="font-mono text-3xs uppercase text-muted-foreground">Active participant</p>
          </div>
          {participant.role === "admin" && (
            <DropdownMenuItem onClick={onManageParticipants}>
              <Users className="h-4 w-4" />
              Manage participants
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setPasswordOpen(true)}>
            <KeyRound className="h-4 w-4" />
            Change password
          </DropdownMenuItem>
          <DropdownMenuItem destructive disabled={isLoggingOut} onClick={() => void onLogout()}>
            <LogOut className="h-4 w-4" />
            {isLoggingOut ? "Signing out..." : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FormDialog
        open={passwordOpen}
        onOpenChange={(nextOpen) => (nextOpen ? setPasswordOpen(true) : closePasswordDialog())}
        title="Change password"
        error={passwordError ?? undefined}
        className="max-w-md"
        actions={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={closePasswordDialog}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="change-participant-password-form"
              size="sm"
              disabled={
                isChangingPassword ||
                !currentPassword ||
                newPassword.length < 12 ||
                !confirmPassword
              }
            >
              {isChangingPassword ? "Changing..." : "Change password"}
            </Button>
          </>
        }
      >
        <form
          id="change-participant-password-form"
          className="space-y-4"
          onSubmit={(event) => void handlePasswordChange(event)}
        >
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Current password</span>
            <Input
              type="password"
              aria-label="Current password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>New password</span>
            <Input
              type="password"
              aria-label="New password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={12}
            />
            <span className="block text-xs font-normal text-muted-foreground">
              At least 12 characters. Other sessions will be signed out.
            </span>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>Confirm new password</span>
            <Input
              type="password"
              aria-label="Confirm new password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={12}
            />
          </label>
        </form>
      </FormDialog>
    </>
  );
}
