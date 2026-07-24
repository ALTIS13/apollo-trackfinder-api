import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  buildTfWebSocketUrl,
  clearTfSessionSecurityState,
  createWebSocketTicket,
  loadTfSession,
  tfFetch,
  tfRequestInit,
} from "./tf-session-client";

const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2026-07-25T12:00:00.000Z",
  csrfToken: "csrf-canary",
};

describe("TF browser session client", () => {
  beforeEach(() => {
    clearTfSessionSecurityState();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads the session with credentials and retains CSRF only in memory", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(loadTfSession()).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/me$/),
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(new Headers(tfRequestInit({ method: "POST" }).headers).get("X-CSRF-Token")).toBe("csrf-canary");
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

    await loadTfSession();
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
});
