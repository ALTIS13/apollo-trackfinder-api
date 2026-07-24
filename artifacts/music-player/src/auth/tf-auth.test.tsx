import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  clearTfSessionSecurityState,
  fetchTfSession,
  logoutTfSession,
  reportTfAuthError,
  startTfLogin,
  tfFetch,
  tfRequestInit,
} from "@/lib/tf-session-client";
import { TfAuthProvider, useTfAuth } from "./tf-auth";
import { TfSessionBoundary } from "./TfSessionBoundary";

vi.mock("@/lib/tf-session-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tf-session-client")>();
  return {
    ...actual,
    fetchTfSession: vi.fn(),
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
const replacementSession = {
  ...session,
  accountId: "10000000-0000-4000-8000-000000000003",
  installationId: "20000000-0000-4000-8000-000000000004",
  csrfToken: "d".repeat(42) + "A",
};

const fetchTfSessionMock = vi.mocked(fetchTfSession);
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
  const { logout, session: currentSession } = useTfAuth();

  return (
    <div>
      <div data-testid="protected-canary">{currentSession?.accountId}</div>
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

function ProviderLogoutProbe({ onReady }: { onReady: (logout: () => Promise<void>) => void }) {
  const { logout } = useTfAuth();
  useEffect(() => {
    onReady(logout);
  }, [logout, onReady]);

  return null;
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
  clearTfSessionSecurityState();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("TF auth boundary", () => {
  it("does not mount protected children before /auth/me succeeds", async () => {
    let resolveSession: (value: typeof session) => void;
    fetchTfSessionMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveSession = resolve;
    }));

    renderAuth();

    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();

    resolveSession!(session);
    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
  });

  it("shows sign in after a 401 and navigates through /auth/start", async () => {
    fetchTfSessionMock.mockRejectedValueOnce(new TfApiError(401, "unauthorized", "unauthenticated"));
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
    fetchTfSessionMock.mockRejectedValueOnce(error);

    renderAuth();

    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("shows module locked when tf.search is absent", async () => {
    fetchTfSessionMock.mockResolvedValueOnce({ ...session, entitlements: ["tf.downloads"] });

    renderAuth();

    expect(await screen.findByText("Модуль недоступен")).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("does not mount protected UI when /auth/me validation fails", async () => {
    fetchTfSessionMock.mockRejectedValueOnce(
      new TfApiError(200, "invalid_session", "invalid"),
    );

    renderAuth();

    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("starts remote logout with the current token but unmounts and clears locally before it settles", async () => {
    const remoteLogout = deferred<void>();
    let logoutHeaders: HeadersInit | undefined;
    fetchTfSessionMock.mockResolvedValueOnce(session);
    logoutTfSessionMock.mockImplementationOnce(() => {
      logoutHeaders = tfRequestInit({ method: "POST" }).headers;
      return remoteLogout.promise;
    });
    const { queryClient } = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    queryClient.setQueryData(["protected"], "cached");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(logoutTfSessionMock).toHaveBeenCalledOnce();
    expect(new Headers(logoutHeaders).get("X-CSRF-Token")).toBe(session.csrfToken);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Требуется вход" })).toBeInTheDocument();
    expect(() => tfRequestInit({ method: "POST" })).toThrowError(
      expect.objectContaining({ code: "csrf_unavailable" }),
    );

    remoteLogout.resolve();
    await act(async () => {
      await remoteLogout.promise;
    });
  });

  it("rejects a delayed initial session response after logout", async () => {
    const delayedSession = deferred<typeof session>();
    fetchTfSessionMock.mockReturnValueOnce(delayedSession.promise);
    logoutTfSessionMock.mockResolvedValueOnce();
    let logoutAction: (() => Promise<void>) | undefined;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TfAuthProvider>
          <ProviderLogoutProbe onReady={(logout) => { logoutAction = logout; }} />
          <TfSessionBoundary>
            <ProtectedCanary />
          </TfSessionBoundary>
        </TfAuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fetchTfSessionMock).toHaveBeenCalledOnce();
      expect(logoutAction).toBeTypeOf("function");
    });

    await act(async () => {
      await logoutAction!();
    });
    delayedSession.resolve(session);
    await act(async () => {
      await delayedSession.promise;
    });

    expect(screen.getByRole("heading", { name: "Требуется вход" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(() => tfRequestInit({ method: "POST" })).toThrowError(
      expect.objectContaining({ code: "csrf_unavailable" }),
    );
  });

  it("clears query data and unmounts protected UI after a runtime tfFetch 401", async () => {
    fetchTfSessionMock.mockResolvedValueOnce(session);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )));
    const { queryClient } = renderAuth();
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    cancelQueries.mockClear();
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
    expect(fetchTfSessionMock).toHaveBeenCalledOnce();
    expect(cancelQueries).toHaveBeenCalledOnce();
  });

  it("cancels and clears account A before one deduplicated policy refresh can mount account B", async () => {
    const refreshedSession = deferred<typeof session>();
    const transitionOrder: string[] = [];
    fetchTfSessionMock
      .mockResolvedValueOnce(session)
      .mockImplementationOnce(() => {
        transitionOrder.push("fetch-b");
        return refreshedSession.promise;
      });
    const { queryClient } = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    queryClient.setQueryData(["account-a"], "private-a");
    const inFlight = queryClient.fetchQuery({
      queryKey: ["account-a", "in-flight"],
      queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          transitionOrder.push("cancel-a");
          reject(new DOMException("cancelled", "AbortError"));
        });
      }),
    });

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
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(transitionOrder).toContain("cancel-a");
    await expect(inFlight).rejects.toBeDefined();
    await waitFor(() => expect(fetchTfSessionMock).toHaveBeenCalledTimes(2));
    expect(transitionOrder).toEqual(["cancel-a", "fetch-b"]);

    refreshedSession.resolve(replacementSession);
    expect(await screen.findByTestId("protected-canary")).toHaveTextContent(
      replacementSession.accountId,
    );
    expect(queryClient.getQueryData(["account-a"])).toBeUndefined();
    expect(tfRequestInit({ method: "POST" })).toMatchObject({
      headers: { "x-csrf-token": replacementSession.csrfToken },
    });
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
    fetchTfSessionMock
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(refreshError);
    renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();

    act(() => {
      reportTfAuthError(new TfApiError(403, "module_access_denied", "forbidden"));
    });

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(fetchTfSessionMock).toHaveBeenCalledTimes(2);
  });

  it("ignores auth events and late refresh completion after provider cleanup", async () => {
    const refreshedSession = deferred<typeof session>();
    fetchTfSessionMock
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(refreshedSession.promise);
    const view = renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    act(() => {
      reportTfAuthError(new TfApiError(403, "module_access_denied", "forbidden"));
    });
    await waitFor(() => expect(fetchTfSessionMock).toHaveBeenCalledTimes(2));

    view.unmount();
    act(() => {
      reportTfAuthError(new TfApiError(503, "policy_unavailable", "unavailable"));
      refreshedSession.resolve(session);
    });
    await act(async () => {
      await refreshedSession.promise;
    });

    expect(fetchTfSessionMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
  });

  it("accepts only the current provider generation when delayed account A resolves after account B", async () => {
    const delayedAccountA = deferred<typeof session>();
    fetchTfSessionMock
      .mockReturnValueOnce(delayedAccountA.promise)
      .mockResolvedValueOnce(replacementSession);

    const firstProvider = renderAuth();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchTfSessionMock).toHaveBeenCalledOnce());
    firstProvider.unmount();

    renderAuth();
    expect(await screen.findByTestId("protected-canary")).toHaveTextContent(
      replacementSession.accountId,
    );

    delayedAccountA.resolve(session);
    await act(async () => {
      await delayedAccountA.promise;
    });

    expect(screen.getByTestId("protected-canary")).toHaveTextContent(
      replacementSession.accountId,
    );
    expect(tfRequestInit({ method: "POST" })).toMatchObject({
      headers: { "x-csrf-token": replacementSession.csrfToken },
    });
  });

  it("does not commit a delayed policy response after a confirmed 401 replaces its generation", async () => {
    const delayedReplacement = deferred<typeof replacementSession>();
    fetchTfSessionMock
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(delayedReplacement.promise);
    renderAuth();

    expect(await screen.findByTestId("protected-canary")).toBeInTheDocument();
    act(() => {
      reportTfAuthError(new TfApiError(403, "module_access_denied", "forbidden"));
    });
    await waitFor(() => expect(fetchTfSessionMock).toHaveBeenCalledTimes(2));

    act(() => {
      reportTfAuthError(new TfApiError(401, "unauthorized", "unauthenticated"));
      delayedReplacement.resolve(replacementSession);
    });
    await act(async () => {
      await delayedReplacement.promise;
    });

    expect(screen.getByRole("heading", { name: "Требуется вход" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-canary")).not.toBeInTheDocument();
    expect(() => tfRequestInit({ method: "POST" })).toThrowError(
      expect.objectContaining({ code: "csrf_unavailable" }),
    );
  });

  it("resolves and clears local state when the logout request fails", async () => {
    fetchTfSessionMock.mockResolvedValueOnce(session);
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
