import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TfApiError, loadTfSession, logoutTfSession, startTfLogin } from "@/lib/tf-session-client";
import { TfAuthProvider, useTfAuth } from "./tf-auth";
import { TfSessionBoundary } from "./TfSessionBoundary";

vi.mock("@/lib/tf-session-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tf-session-client")>();
  return {
    ...actual,
    loadTfSession: vi.fn(),
    logoutTfSession: vi.fn(),
    startTfLogin: vi.fn(),
  };
});

const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2026-07-25T12:00:00.000Z",
  csrfToken: "csrf-canary",
};

const loadTfSessionMock = vi.mocked(loadTfSession);
const logoutTfSessionMock = vi.mocked(logoutTfSession);
const startTfLoginMock = vi.mocked(startTfLogin);

function ProtectedCanary() {
  const { logout } = useTfAuth();

  return (
    <div>
      <div data-testid="protected-canary">protected player</div>
      <button onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

function renderAuth(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TfAuthProvider>
        <TfSessionBoundary>
          <ProtectedCanary />
        </TfSessionBoundary>
      </TfAuthProvider>
    </QueryClientProvider>,
  );

  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TF auth boundary", () => {
  it("does not mount protected children before /auth/me succeeds", async () => {
    let resolveSession: (value: typeof session) => void;
    loadTfSessionMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveSession = resolve;
    }));

    renderAuth();

    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();

    resolveSession!(session);
    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
  });

  it("shows sign in after a 401 and navigates through /auth/start", async () => {
    loadTfSessionMock.mockRejectedValueOnce(new TfApiError(401, "unauthorized", "unauthenticated"));
    const user = userEvent.setup();

    renderAuth();

    await user.click(await screen.findByRole("button", { name: "Войти" }));

    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(startTfLoginMock).toHaveBeenCalledOnce();
  });

  it.each([
    new TfApiError(503, "policy_unavailable", "unavailable"),
    new Error("network unavailable"),
  ])("shows retry after a 503 or transport failure", async (error) => {
    loadTfSessionMock.mockRejectedValueOnce(error);

    renderAuth();

    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("shows module locked when tf.search is absent", async () => {
    loadTfSessionMock.mockResolvedValueOnce({ ...session, entitlements: ["tf.downloads"] });

    renderAuth();

    expect(await screen.findByText("Модуль недоступен")).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("clears query data and protected UI after logout", async () => {
    loadTfSessionMock.mockResolvedValueOnce(session);
    logoutTfSessionMock.mockResolvedValueOnce();
    const { queryClient } = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    queryClient.setQueryData(["protected"], "cached");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    });
  });
});
