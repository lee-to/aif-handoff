import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CodexLoginCard } from "../CodexLoginCard";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    data?: unknown;
    constructor(message: string, status: number, data?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.data = data;
    }
  }
  return {
    ApiError,
    api: {
      getCodexLoginCapabilities: vi.fn(),
      getCodexLoginStatus: vi.fn(),
      startCodexLogin: vi.fn(),
      submitCodexCallback: vi.fn(),
      cancelCodexLogin: vi.fn(),
    },
  };
});

function renderCard(): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CodexLoginCard />
    </QueryClientProvider>,
  );
}

describe("CodexLoginCard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.getCodexLoginCapabilities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      loginProxyEnabled: true,
      loopbackPort: 1455,
    });
    (api.getCodexLoginStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
    });
  });

  it("renders initial idle state with a Start button", () => {
    renderCard();
    expect(screen.getByText(/Codex OAuth login/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Codex login/i })).toBeInTheDocument();
  });

  it("drives the wizard: start → paste → submit → success", async () => {
    (api.startCodexLogin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "s-1",
      authUrl: "https://chatgpt.com/auth/authorize?state=S",
      startedAt: new Date().toISOString(),
    });
    (api.submitCodexCallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      exitCode: 0,
    });

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Start Codex login/i }));

    const urlBox = await screen.findByDisplayValue("https://chatgpt.com/auth/authorize?state=S");
    expect(urlBox).toBeInTheDocument();

    const pasteBox = screen.getByPlaceholderText(/http:\/\/localhost:1455/i);
    fireEvent.change(pasteBox, { target: { value: "http://localhost:1455/?code=c&state=S" } });

    fireEvent.click(screen.getByRole("button", { name: /Submit callback/i }));

    await waitFor(() =>
      expect(screen.getByText(/Codex is now authenticated/i)).toBeInTheDocument(),
    );
    expect(api.submitCodexCallback).toHaveBeenCalledWith("http://localhost:1455/?code=c&state=S");
  });

  it("shows an error message when start fails", async () => {
    (api.startCodexLogin as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("broker_unreachable"),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Start Codex login/i }));
    await waitFor(() => expect(screen.getByText(/broker_unreachable/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("shows error but keeps the wizard alive when callback fails", async () => {
    (api.startCodexLogin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessionId: "s-1",
      authUrl: "https://chatgpt.com/auth/authorize?state=S",
      startedAt: new Date().toISOString(),
    });
    (api.submitCodexCallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("invalid_callback_url"),
    );

    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Start Codex login/i }));
    const pasteBox = await screen.findByPlaceholderText(/http:\/\/localhost:1455/i);
    fireEvent.change(pasteBox, { target: { value: "http://localhost:1455/?code=c&state=S" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit callback/i }));

    await waitFor(() => expect(screen.getByText(/invalid_callback_url/i)).toBeInTheDocument());
    // Paste-step controls still visible
    expect(screen.getByRole("button", { name: /Submit callback/i })).toBeInTheDocument();
  });
});
