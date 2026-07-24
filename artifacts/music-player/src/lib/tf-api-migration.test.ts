import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Discover from "@/pages/Discover";
import {
  useSpotifyLogout,
  spotifyLoginUrl,
} from "@/hooks/use-spotify";
import {
  useYandexLogout,
  useYandexSaveToken,
} from "@/hooks/use-yandex";
import {
  clearTfSessionSecurityState,
  loadTfSession,
} from "./tf-session-client";

const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2026-07-25T12:00:00.000Z",
  csrfToken: "csrf-canary",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function queryWrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

async function loadSessionForUnsafeRequest() {
  vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(session));
  await loadTfSession();
  vi.mocked(fetch).mockClear();
}

describe("TF API migration", () => {
  beforeEach(() => {
    clearTfSessionSecurityState();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads recommendations without a sessionId query and with credentials", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ results: [] }));

    render(createElement(Discover));

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const [url, request] = vi.mocked(fetch).mock.calls[0];
    const requestUrl = new URL(String(url), window.location.origin);

    expect(requestUrl.pathname).toBe("/api/tracks/recommendations");
    expect(requestUrl.searchParams.get("limit")).toBe("20");
    expect(requestUrl.searchParams.has("sessionId")).toBe(false);
    expect(request).toMatchObject({ credentials: "include" });
  });

  it("posts Spotify and Yandex logout with CSRF", async () => {
    await loadSessionForUnsafeRequest();
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(jsonResponse({})));
    const { result } = renderHook(
      () => ({ spotify: useSpotifyLogout(), yandex: useYandexLogout() }),
      { wrapper: queryWrapper },
    );

    await act(async () => {
      await result.current.spotify.mutateAsync();
      await result.current.yandex.mutateAsync();
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/spotify/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.any(Headers),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/yandex/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.any(Headers),
      }),
    );
    for (const [, request] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe("csrf-canary");
    }
  });

  it("navigates to Spotify login without sid", () => {
    const url = new URL(spotifyLoginUrl(), window.location.origin);

    expect(url.pathname).toBe("/api/spotify/login");
    expect(url.searchParams.has("sid")).toBe(false);
  });

  it("posts the Yandex token through the CSRF adapter", async () => {
    await loadSessionForUnsafeRequest();
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() => useYandexSaveToken(), { wrapper: queryWrapper });

    await act(async () => {
      await result.current.mutateAsync("yandex-token");
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/yandex/token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.any(Headers),
        body: JSON.stringify({ token: "yandex-token" }),
      }),
    );
    const request = vi.mocked(fetch).mock.calls[0][1];
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe("csrf-canary");
  });

  it("contains no legacy identity transport in the migrated HTTP call sites", () => {
    const srcDir = path.resolve(import.meta.dirname, "..");
    const migratedFiles = [
      "pages/Home.tsx",
      "pages/Discover.tsx",
      "components/TrackCard.tsx",
      "hooks/use-spotify.ts",
      "hooks/use-yandex.ts",
    ];
    const legacyIdentity = [
      "getClientSessionId",
      "X-Client-Session",
      "trackfinder_session_id",
      "sessionId",
      "sid",
    ];

    for (const file of migratedFiles) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      for (const identity of legacyIdentity) {
        expect(source).not.toContain(identity);
      }
    }

    const playerSource = readFileSync(path.join(srcDir, "hooks/use-player.tsx"), "utf8");
    expect(playerSource).not.toMatch(/\/tracks\/play[\s\S]{0,500}sessionId/);
  });
});
