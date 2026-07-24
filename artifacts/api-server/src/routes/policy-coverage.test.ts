import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import {
  TF_ROUTE_POLICIES,
  assertProtectedRouteCoverage,
  type TfProtectedRoute,
} from "../lib/tf-policy.js";
import { createSpotifyRouter } from "./spotify.js";
import { createTracksRouter } from "./tracks.js";
import { createYandexRouter } from "./yandex.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const servers: Server[] = [];

interface RouteLayer {
  readonly route?: {
    readonly path: string;
    readonly methods: Readonly<Record<string, boolean>>;
  };
}

function discoverRoutes(router: Router): TfProtectedRoute[] {
  const stack = (router as unknown as { readonly stack: RouteLayer[] }).stack;
  return stack.flatMap((layer) => {
    if (layer.route === undefined) return [];
    return Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => ({
        method: method.toUpperCase(),
        path: `/api${layer.route!.path}`,
      }));
  });
}

function exactInventory(): TfProtectedRoute[] {
  return [
    { method: "POST", path: "/api/tracks/search" },
    { method: "POST", path: "/api/tracks/batch-search" },
    { method: "GET", path: "/api/tracks/:id/stream" },
    { method: "GET", path: "/api/tracks/:id/download" },
    { method: "GET", path: "/api/tracks/:id/audio-stream" },
    { method: "GET", path: "/api/tracks/recent" },
    { method: "POST", path: "/api/tracks/play" },
    { method: "GET", path: "/api/tracks/recommendations" },
    { method: "GET", path: "/api/tracks/suggest" },
    { method: "GET", path: "/api/tracks/lyrics" },
    { method: "POST", path: "/api/tracks/download/queue" },
    { method: "GET", path: "/api/tracks/download/jobs" },
    { method: "GET", path: "/api/tracks/download/status/:jobId" },
    { method: "GET", path: "/api/tracks/download/file/:jobId" },
    { method: "GET", path: "/api/spotify/login" },
    { method: "GET", path: "/api/spotify/callback" },
    { method: "GET", path: "/api/spotify/status" },
    { method: "POST", path: "/api/spotify/logout" },
    { method: "GET", path: "/api/spotify/liked" },
    { method: "GET", path: "/api/spotify/liked-all" },
    { method: "GET", path: "/api/spotify/playlists" },
    {
      method: "GET",
      path: "/api/spotify/playlists/:playlistId/tracks",
    },
    { method: "GET", path: "/api/spotify/top-tracks" },
    { method: "POST", path: "/api/yandex/token" },
    { method: "GET", path: "/api/yandex/status" },
    { method: "POST", path: "/api/yandex/logout" },
    { method: "GET", path: "/api/yandex/liked" },
    { method: "GET", path: "/api/yandex/playlists" },
    { method: "GET", path: "/api/yandex/playlists/:uid/:kind/tracks" },
  ];
}

function policyAuthDependencies() {
  return {
    platform: {
      createAuthorizationUrl: vi.fn(),
      exchangeCode: vi.fn(),
      introspect: vi.fn(),
    },
    sessionStore: {
      createTransaction: vi.fn(),
      consumeTransaction: vi.fn(),
      createSession: vi.fn(),
      getSession: vi.fn(),
      observeSession: vi.fn(),
      refreshSession: vi.fn(),
      revokeSession: vi.fn(),
    },
    webOrigin: "https://tf.apollot.ru",
    secureCookies: true,
  };
}

async function startApp(): Promise<{
  readonly origin: string;
  readonly dependencies: ReturnType<typeof policyAuthDependencies>;
}> {
  const dependencies = policyAuthDependencies();
  const app = createApiApp({ auth: dependencies });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    dependencies,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("protected route policy coverage", () => {
  it("discovers exactly 14 track, 9 Spotify, and 6 Yandex routes", () => {
    const trackRoutes = discoverRoutes(createTracksRouter());
    const spotifyRoutes = discoverRoutes(createSpotifyRouter());
    const yandexRoutes = discoverRoutes(createYandexRouter());
    const discovered = [...trackRoutes, ...spotifyRoutes, ...yandexRoutes];

    expect(trackRoutes).toHaveLength(14);
    expect(spotifyRoutes).toHaveLength(9);
    expect(yandexRoutes).toHaveLength(6);
    expect(
      [...discovered].sort((left, right) =>
        `${left.method} ${left.path}`.localeCompare(
          `${right.method} ${right.path}`,
        ),
      ),
    ).toEqual(
      exactInventory().sort((left, right) =>
        `${left.method} ${left.path}`.localeCompare(
          `${right.method} ${right.path}`,
        ),
      ),
    );
    expect(() =>
      assertProtectedRouteCoverage(discovered, TF_ROUTE_POLICIES),
    ).not.toThrow();
  });

  it("rejects missing, stale, duplicate, and method-mismatched policies", () => {
    const discovered = exactInventory();
    const withoutFirst = TF_ROUTE_POLICIES.slice(1);
    const stale = [
      ...TF_ROUTE_POLICIES,
      {
        method: "GET",
        path: "/api/tracks/stale",
        pattern: /^\/api\/tracks\/stale$/,
        capability: "tf.search",
        live: false,
      },
    ] as const;
    const duplicate = [...TF_ROUTE_POLICIES, TF_ROUTE_POLICIES[0]!] as const;
    const methodMismatch = discovered.map((route, index) =>
      index === 0 ? { ...route, method: "PUT" } : route,
    );

    expect(() =>
      assertProtectedRouteCoverage(discovered, withoutFirst),
    ).toThrow();
    expect(() => assertProtectedRouteCoverage(discovered, stale)).toThrow();
    expect(() => assertProtectedRouteCoverage(discovered, duplicate)).toThrow();
    expect(() =>
      assertProtectedRouteCoverage(methodMismatch, TF_ROUTE_POLICIES),
    ).toThrow();
  });
});

describe("direct protected endpoints", () => {
  it("denies direct track, Spotify, and Yandex calls without the TF cookie", async () => {
    const { origin, dependencies } = await startApp();
    const canary = randomBytes(32).toString("base64url");
    const responses = await Promise.all([
      fetch(`${origin}/api/tracks/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${canary}`,
          "x-client-session": canary,
        },
        body: JSON.stringify({
          artist: "Artist",
          title: "Title",
          capability: "tf.search",
        }),
      }),
      fetch(`${origin}/api/spotify/status?sid=${canary}`, {
        headers: {
          "x-client-session": canary,
          cookie: `connect.sid=${canary}`,
        },
      }),
      fetch(`${origin}/api/yandex/status?sessionId=${canary}`, {
        headers: { "x-client-session": canary },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual([
      { error: "unauthorized" },
      { error: "unauthorized" },
      { error: "unauthorized" },
    ]);
    expect(dependencies.sessionStore.observeSession).not.toHaveBeenCalled();
    expect(dependencies.platform.introspect).not.toHaveBeenCalled();
  });

  it("keeps health outside policy middleware and removes X-Client-Session from CORS", async () => {
    const { origin } = await startApp();

    const health = await fetch(`${origin}/api/healthz`);
    const preflight = await fetch(`${origin}/api/tracks/search`, {
      method: "OPTIONS",
      headers: {
        origin: "https://tf.apollot.ru",
        "access-control-request-method": "POST",
        "access-control-request-headers": "X-Client-Session, Content-Type",
      },
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(preflight.status).toBe(204);
    expect(
      preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).not.toContain("x-client-session");
  });
});
