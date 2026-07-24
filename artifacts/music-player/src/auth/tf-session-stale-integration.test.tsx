import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  clearTfSessionSecurityState,
  fetchTfSession,
  subscribeTfAuthSecurityEvents,
  tfFetch,
} from "@/lib/tf-session-client";
import { TfAuthProvider, useTfAuth } from "./tf-auth";
import { TfSessionBoundary } from "./TfSessionBoundary";

const accountB = {
  accountId: "10000000-0000-4000-8000-000000000003",
  installationId: "20000000-0000-4000-8000-000000000004",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  csrfToken: "d".repeat(42) + "A",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function AccountCanary() {
  const { session } = useTfAuth();
  return <div data-testid="account-canary">{session?.accountId}</div>;
}

const staleFailures = [
  {
    label: "401",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.resolve(jsonResponse({ error: "unauthorized" }, 401));
    },
    expected: { status: 401, code: "unauthorized", kind: "unauthenticated" },
  },
  {
    label: "policy 403",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.resolve(jsonResponse({ error: "module_access_denied" }, 403));
    },
    expected: { status: 403, code: "module_access_denied", kind: "forbidden" },
  },
  {
    label: "policy 503",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.resolve(jsonResponse({ error: "policy_unavailable" }, 503));
    },
    expected: { status: 503, code: "policy_unavailable", kind: "unavailable" },
  },
  {
    label: "malformed 200 candidate",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.resolve(jsonResponse({ ...accountB, csrfToken: "invalid" }));
    },
    expected: { status: 200, code: "invalid_session", kind: "invalid" },
  },
  {
    label: "body read failure",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.resolve({
        status: 200,
        ok: true,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: vi.fn().mockRejectedValue(new Error("body read failed")),
      } as unknown as Response);
    },
    expected: { status: 0, code: "transport_unavailable", kind: "transport" },
  },
  {
    label: "transport failure",
    complete: (pending: ReturnType<typeof deferred<Response>>) => {
      pending.reject(new Error("network unavailable"));
    },
    expected: { status: 0, code: "transport_unavailable", kind: "transport" },
  },
];

let unsubscribeSecurityEvents: (() => void) | null = null;

beforeEach(() => {
  clearTfSessionSecurityState();
});

afterEach(() => {
  unsubscribeSecurityEvents?.();
  unsubscribeSecurityEvents = null;
  cleanup();
  clearTfSessionSecurityState();
  vi.unstubAllGlobals();
});

describe("stale unmanaged /auth/me integration", () => {
  it.each(staleFailures)(
    "does not publish, clear account B, or change provider state after stale $label",
    async ({ complete, expected }) => {
      const staleResponse = deferred<Response>();
      const fetchMock = vi.fn()
        .mockReturnValueOnce(staleResponse.promise)
        .mockResolvedValueOnce(jsonResponse(accountB))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const securityEvents = vi.fn();
      unsubscribeSecurityEvents = subscribeTfAuthSecurityEvents(securityEvents);
      const staleRequest = fetchTfSession().catch((error: unknown) => error);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <TfAuthProvider>
            <TfSessionBoundary>
              <AccountCanary />
            </TfSessionBoundary>
          </TfAuthProvider>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId("account-canary")).toHaveTextContent(
        accountB.accountId,
      );

      complete(staleResponse);
      const staleError = await staleRequest;
      await act(async () => {
        await Promise.resolve();
      });

      expect(staleError).toBeInstanceOf(TfApiError);
      expect(staleError).toMatchObject(expected);
      expect(securityEvents).not.toHaveBeenCalled();
      expect(screen.getByTestId("account-canary")).toHaveTextContent(
        accountB.accountId,
      );

      await expect(tfFetch<void>("/tracks/play", { method: "POST" })).resolves.toBeUndefined();
      const [, unsafeRequest] = fetchMock.mock.calls.at(-1)!;
      expect(new Headers(unsafeRequest?.headers).get("X-CSRF-Token")).toBe(
        accountB.csrfToken,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );
});
