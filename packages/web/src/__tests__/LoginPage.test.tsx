import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginPage } from "@/components/auth/LoginPage";

describe("LoginPage", () => {
  it("submits credentials and clears the password field", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginPage onLogin={onLogin} isPending={false} />);

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({
        username: "ada",
        password: "correct horse battery staple",
      }),
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("shows authentication failures without retaining the password", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("Invalid username or password"));
    render(<LoginPage onLogin={onLogin} isPending={false} />);

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid username or password")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
});
