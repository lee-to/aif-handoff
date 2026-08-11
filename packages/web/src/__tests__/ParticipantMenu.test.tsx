import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ParticipantMenu } from "@/components/participants/ParticipantMenu";

const admin = {
  id: "participant-admin",
  displayName: "Ada Lovelace",
  role: "admin" as const,
  active: true,
};

describe("ParticipantMenu", () => {
  it("shows participant administration only to administrators", () => {
    const onManageParticipants = vi.fn();
    render(
      <ParticipantMenu
        participant={admin}
        onManageParticipants={onManageParticipants}
        onLogout={vi.fn()}
        isLoggingOut={false}
        onChangePassword={vi.fn()}
        isChangingPassword={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Participant menu for Ada Lovelace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage participants" }));

    expect(onManageParticipants).toHaveBeenCalledTimes(1);
  });

  it("hides participant administration from members and supports logout", () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(
      <ParticipantMenu
        participant={{ ...admin, id: "participant-member", role: "member" }}
        onManageParticipants={vi.fn()}
        onLogout={onLogout}
        isLoggingOut={false}
        onChangePassword={vi.fn()}
        isChangingPassword={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Participant menu for Ada Lovelace" }));

    expect(screen.queryByRole("menuitem", { name: "Manage participants" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Change password" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("changes the current participant password", async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    render(
      <ParticipantMenu
        participant={{ ...admin, id: "participant-member", role: "member" }}
        onManageParticipants={vi.fn()}
        onLogout={vi.fn()}
        isLoggingOut={false}
        onChangePassword={onChangePassword}
        isChangingPassword={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Participant menu for Ada Lovelace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change password" }));
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "old secure password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new secure password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new secure password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(onChangePassword).toHaveBeenCalledWith({
        currentPassword: "old secure password",
        newPassword: "new secure password",
      }),
    );
  });
});
