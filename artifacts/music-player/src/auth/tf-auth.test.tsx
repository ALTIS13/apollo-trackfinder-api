import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  loadTfSession,
  logoutTfSession,
  reportTfAuthError,
  startTfLogin,
  tfFetch,
} from "@/lib/tf-session-client";
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
  expiresAt: "2099-01-01T00:00:00.000Z",
  csrfToken: "c".repeat(42) + "A",
};

const loadTfSessionMock = vi.mocked(loadTfSession);
const logoutTfSessionMock = vi.mocked(logoutTfSession);
const startTfLoginMock = vi.mocked(startTfLogin);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ProtectedCanary() {
  const { logout } = useTfAuth();

  return (
    <div>
      <div data-testid="protected-canary">protected player</div>
      <button onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

function LogoutActionProbe({ onReady }: { onReady: (logout: () => Promise<void>) => void }) {
  const { logout } = useTfAuth();
  useEffect(() => {
    onReady(logout);
  }, [logout, onReady]);

  return <div data-testid="protected-canary">protected player</div>;
}

function renderAuth(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
}), children = <ProtectedCanary />) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TfAuthProvider>
        <TfSessionBoundary>
          {children}
        </TfSessionBoundary>
      </TfAuthProvider>
    </QueryClientProvider>,
  );

  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
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

  it("does not mount protected UI when /auth/me validation fails", async () => {
    loadTfSessionMock.mockRejectedValueOnce(
      new TfApiError(200, "invalid_session", "invalid"),
    );

    renderAuth();

    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
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

  it("clears query data and unmounts protected UI after a runtime tfFetch 401", async () => {
    loadTfSessionMock.mockResolvedValueOnce(session);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )));
    const { queryClient } = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    queryClient.setQueryData(["protected"], "cached");

    await expect(tfFetch("/tracks/recommendations")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });

    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Требуется вход" })).toBeInTheDocument();
    });
    expect(loadTfSessionMock).toHaveBeenCalledOnce();
  });

  it("deduplicates policy refreshes and locks before protected UI can remain mounted", async () => {
    const refreshedSession = deferred<typeof session>();
    loadTfSessionMock
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(refreshedSession.promise);
    renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();

    act(() => {
      expect(reportTfAuthError(
        new TfApiError(403, "module_access_denied", "forbidden"),
      )).toBe(true);
      expect(reportTfAuthError(
        new TfApiError(503, "policy_unavailable", "unavailable"),
      )).toBe(true);
      expect(reportTfAuthError(
        new TfApiError(403, "policy_revoked", "forbidden"),
      )).toBe(true);
    });

    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(loadTfSessionMock).toHaveBeenCalledTimes(2);

    refreshedSession.resolve({ ...session, entitlements: ["tf.downloads"] });
    expect(await screen.findByText("Модуль недоступен")).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it.each([
    [
      new TfApiError(401, "unauthorized", "unauthenticated"),
      "Требуется вход",
    ],
    [
      new TfApiError(503, "policy_unavailable", "unavailable"),
      "Сервис временно недоступен",
    ],
  ])("keeps protected UI unmounted when policy refresh resolves to $kind", async (refreshError, heading) => {
    loadTfSessionMock
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(refreshError);
    renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();

    act(() => {
      reportTfAuthError(new TfApiError(403, "module_access_denied", "forbidden"));
    });

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(loadTfSessionMock).toHaveBeenCalledTimes(2);
  });

  it("ignores auth events and late refresh completion after provider cleanup", async () => {
    const refreshedSession = deferred<typeof session>();
    loadTfSessionMock
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(refreshedSession.promise);
    const view = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    act(() => {
      reportTfAuthError(new TfApiError(403, "module_access_denied", "forbidden"));
    });
    expect(loadTfSessionMock).toHaveBeenCalledTimes(2);

    view.unmount();
    act(() => {
      reportTfAuthError(new TfApiError(503, "policy_unavailable", "unavailable"));
      refreshedSession.resolve(session);
    });
    await act(async () => {
      await refreshedSession.promise;
    });

    expect(loadTfSessionMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("resolves and clears local state when the logout request fails", async () => {
    loadTfSessionMock.mockResolvedValueOnce(session);
    logoutTfSessionMock.mockRejectedValueOnce(new Error("logout unavailable"));
    let logoutAction: (() => Promise<void>) | undefined;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderAuth(queryClient, <LogoutActionProbe onReady={(logout) => { logoutAction = logout; }} />);

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    await waitFor(() => expect(logoutAction).toBeTypeOf("function"));
    queryClient.setQueryData(["protected"], "cached");

    await act(async () => {
      await expect(logoutAction!()).resolves.toBeUndefined();
    });

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Требуется вход" })).toBeInTheDocument();
  });
});
