import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ParticipantManagementDialog } from "@/components/participants/ParticipantManagementDialog";

const participantMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/hooks/useParticipants", () => ({
  useParticipants: () => ({
    data: [
      {
        id: "admin-1",
        username: "ada",
        displayName: "Ada",
        role: "admin",
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deactivatedAt: null,
      },
      {
        id: "member-1",
        username: "grace",
        displayName: "Grace",
        role: "member",
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deactivatedAt: null,
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreateParticipant: () => ({
    mutateAsync: participantMocks.create,
    isPending: false,
  }),
  useUpdateParticipant: () => ({
    mutateAsync: participantMocks.update,
    isPending: false,
  }),
  useDeactivateParticipant: () => ({
    mutateAsync: participantMocks.deactivate,
    isPending: false,
  }),
  useResetParticipantPassword: () => ({
    mutateAsync: participantMocks.reset,
    isPending: false,
  }),
}));

describe("ParticipantManagementDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    participantMocks.create.mockResolvedValue(undefined);
    participantMocks.update.mockResolvedValue(undefined);
    participantMocks.deactivate.mockResolvedValue(undefined);
    participantMocks.reset.mockResolvedValue(undefined);
  });

  it("creates participants and clears rejected password values", async () => {
    participantMocks.create.mockRejectedValueOnce(new Error("Username already exists"));
    render(
      <ParticipantManagementDialog open onOpenChange={vi.fn()} currentParticipantId="admin-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create participant" }));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "new-user" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "New User" } });
    fireEvent.change(screen.getByLabelText(/^Temporary password/), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Username already exists")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Temporary password/)).toHaveValue("");
    expect(participantMocks.create).toHaveBeenCalledWith({
      username: "new-user",
      displayName: "New User",
      password: "temporary-password",
      role: "member",
    });
  });

  it("prevents self-deactivation and confirms deactivation for another participant", async () => {
    render(
      <ParticipantManagementDialog open onOpenChange={vi.fn()} currentParticipantId="admin-1" />,
    );

    const deactivateButtons = screen.getAllByRole("button", { name: "Deactivate" });
    expect(deactivateButtons[0]).toBeDisabled();
    fireEvent.click(deactivateButtons[1]!);
    const confirmationButtons = screen.getAllByRole("button", { name: "Deactivate" });
    fireEvent.click(confirmationButtons.at(-1)!);

    await waitFor(() => expect(participantMocks.deactivate).toHaveBeenCalledWith("member-1"));
  });

  it("clears reset-password values after a failed submission", async () => {
    participantMocks.reset.mockRejectedValueOnce(new Error("Password rejected"));
    render(
      <ParticipantManagementDialog open onOpenChange={vi.fn()} currentParticipantId="admin-1" />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[1]!);
    fireEvent.change(screen.getByLabelText(/^New password/), {
      target: { value: "replacement-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Password rejected")).toBeInTheDocument();
    expect(screen.getByLabelText(/^New password/)).toHaveValue("");
  });
});
