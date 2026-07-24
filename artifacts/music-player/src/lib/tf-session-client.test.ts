import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  buildTfWebSocketUrl,
  clearTfSessionSecurityState,
  commitTfSessionSecurityState,
  createWebSocketTicket,
  fetchTfSession,
  tfFetch,
  tfRequestInit,
} from "./tf-session-client";

const CSRF_TOKEN = "c".repeat(42) + "A";
const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  csrfToken: CSRF_TOKEN,
};

async function fetchAndCommitSession() {
  const fetchedSession = await fetchTfSession();
  commitTfSessionSecurityState(fetchedSession);
  return fetchedSession;
}

describe("TF browser session client", () => {
  beforeEach(() => {
    clearTfSessionSecurityState();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches and validates the session without committing CSRF until the caller accepts it", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const fetchedSession = await fetchTfSession();
    expect(fetchedSession).toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/me$/),
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(() => tfRequestInit({ method: "POST" })).toThrowError(
      expect.objectContaining({ code: "csrf_unavailable" }),
    );

    commitTfSessionSecurityState(fetchedSession);
    expect(tfRequestInit({
      method: "post",
      headers: { "Content-Type": "application/json", "x-csrf-token": "caller-token" },
    })).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": CSRF_TOKEN,
      },
    });
    expect(localStorage.length).toBe(0);
  });

  it("refuses unsafe requests before fetch when CSRF is absent", async () => {
    await expect(tfFetch("/tracks/play", { method: "POST" })).rejects.toMatchObject({
      code: "csrf_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates an exact empty ticket request and builds a ticket-only socket URL", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "a".repeat(43) }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));

    await fetchAndCommitSession();
    await expect(createWebSocketTicket()).resolves.toBe("a".repeat(43));
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/ws\/tickets$/),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(request?.body).toBeUndefined();
    expect(buildTfWebSocketUrl("a".repeat(43))).toMatch(
      /^wss?:\/\/[^?]+\/api\/ws\?ticket=a{43}$/,
    );
  });

  it.each([
    [401, "unauthorized", "unauthenticated"],
    [403, "module_access_denied", "forbidden"],
    [503, "policy_unavailable", "unavailable"],
  ])("classifies status %s and code %s", async (status, code, kind) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: code }), {
      status,
      headers: { "Content-Type": "application/json" },
    }));

    const error = await tfFetch("/auth/me").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TfApiError);
    expect(error).toMatchObject({ status, code, kind });
  });

  it("normalizes a successful response body read failure", async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: vi.fn().mockRejectedValue(new Error("body read failed")),
    } as unknown as Response);

    await expect(tfFetch("/auth/me")).rejects.toMatchObject({
      status: 0,
      code: "transport_unavailable",
      kind: "transport",
    });
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [503, "unavailable"],
  ])("classifies malformed JSON on status %s", async (status, kind) => {
    vi.mocked(fetch).mockResolvedValue(new Response("{", {
      status,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(tfFetch("/auth/me")).rejects.toMatchObject({
      status,
      code: "invalid_response",
      kind,
    });
  });

  it("clears CSRF after a confirmed 401", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));

    await fetchAndCommitSession();
    await expect(tfFetch("/auth/me")).rejects.toMatchObject({ status: 401 });
    await expect(tfFetch("/tracks/play", { method: "POST" })).rejects.toMatchObject({
      code: "csrf_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "non-canonical accountId",
      { ...session, accountId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ],
    [
      "non-canonical installationId",
      { ...session, installationId: "bbbbbbbb-bbbb-4bbb-cbbb-bbbbbbbbbbbb" },
    ],
    [
      "short CSRF token",
      { ...session, csrfToken: "short" },
    ],
    [
      "non-canonical base64url CSRF token",
      { ...session, csrfToken: "c".repeat(42) + "B" },
    ],
    [
      "non-string entitlement",
      { ...session, entitlements: ["tf.search", 1] },
    ],
    [
      "invalid expiry",
      { ...session, expiresAt: "not-a-date" },
    ],
    [
      "expired session",
      { ...session, expiresAt: "2020-01-01T00:00:00.000Z" },
    ],
  ])("clears CSRF after an invalid session payload: %s", async (_label, invalidSession) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(invalidSession), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await fetchAndCommitSession();
    await expect(fetchTfSession()).rejects.toMatchObject({ code: "invalid_session" });
    await expect(tfFetch("/tracks/play", { method: "POST" })).rejects.toMatchObject({
      code: "csrf_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears CSRF when a core policy 503 publishes revalidation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "policy_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));

    await fetchAndCommitSession();
    await expect(tfFetch("/auth/me")).rejects.toMatchObject({ status: 503 });
    expect(() => tfRequestInit({ method: "POST" })).toThrowError(
      expect.objectContaining({ code: "csrf_unavailable" }),
    );
  });

  it("publishes forced revalidation for pre-open WebSocket unavailability", async () => {
    const { reportTfAuthError, subscribeTfAuthSecurityEvents } = await import("./tf-session-client");
    const listener = vi.fn();
    const unsubscribe = subscribeTfAuthSecurityEvents(listener);

    expect(reportTfAuthError(
      new TfApiError(503, "websocket_unavailable", "unavailable"),
    )).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: "revalidate",
      error: expect.objectContaining({ code: "websocket_unavailable" }),
    }));

    unsubscribe();
  });
});
