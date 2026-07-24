import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import session from "express-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpotifyRouter,
  type SpotifyRouteDependencies,
  type SpotifyTokenRecord,
} from "./spotify.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const NOW = Date.parse("2026-07-24T03:00:00.000Z");
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const TF_SESSION_ID = "40000000-0000-4000-8000-000000000004";
const WEB_ORIGIN = "https://tf.apollot.ru";
const principal = {
  accountId: ACCOUNT_ID,
  tfSessionId: TF_SESSION_ID,
  installationId: "30000000-0000-4000-8000-000000000003",
  entitlements: ["tf.integrations"],
  sessionExpiresAt: "2026-07-24T04:00:00.000Z",
  policyFreshUntil: "2026-07-24T03:05:00.000Z",
} as const;
const servers: Server[] = [];

function tokenRecord(
  overrides: Partial<SpotifyTokenRecord> = {},
): SpotifyTokenRecord {
  return {
    accessToken: "spotify-access-token",
    refreshToken: "spotify-refresh-token",
    expiresAt: new Date(NOW + 60 * 60 * 1_000),
    spotifyUserId: "spotify-user",
    displayName: "Spotify User",
    ...overrides,
  };
}

function spotifyDependencies() {
  return {
    clientId: "spotify-client",
    clientSecret: "spotify-secret",
    serverUrl: "https://api.tf.apollot.ru",
    webUrl: WEB_ORIGIN,
    now: () => NOW,
    fetch: vi.fn(),
    log: {
      error: vi.fn(),
    },
    tokenStore: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } satisfies SpotifyRouteDependencies;
}

async function startSpotifyServer(
  dependencies: SpotifyRouteDependencies,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: "spotify-test-session-secret-at-least-32-bytes",
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.use((request, _response, next) => {
    request.tfPrincipal = principal;
    next();
  });
  app.use("/api", createSpotifyRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("missing provider session cookie");
  return setCookie.split(";", 1)[0]!;
}

function changedOpaque(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function beginSpotifyLogin(
  baseUrl: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly state: string; readonly cookie: string }> {
  const response = await fetch(
    `${baseUrl}/spotify/login?sid=${OTHER_ACCOUNT_ID}&mobile=1`,
    {
      redirect: "manual",
      headers,
    },
  );
  const location = response.headers.get("location");
  if (location === null) throw new Error("missing Spotify redirect");
  const state = new URL(location).searchParams.get("state");
  if (state === null) throw new Error("missing Spotify state");
  return { state, cookie: sessionCookie(response) };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Spotify provider state", () => {
  it("creates opaque 32-byte state without any account or session identifier", async () => {
    const dependencies = spotifyDependencies();
    const baseUrl = await startSpotifyServer(dependencies);

    const { state } = await beginSpotifyLogin(baseUrl, {
      "x-client-session": OTHER_ACCOUNT_ID,
    });

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    for (const identifier of [
      ACCOUNT_ID,
      OTHER_ACCOUNT_ID,
      PLATFORM_SESSION_ID,
      TF_SESSION_ID,
    ]) {
      expect(state).not.toContain(identifier);
      expect(Buffer.from(state, "base64url").toString("utf8")).not.toContain(
        identifier,
      );
    }
    expect(dependencies.tokenStore.get).not.toHaveBeenCalled();
    expect(dependencies.tokenStore.upsert).not.toHaveBeenCalled();
  });

  it("requires exact fixed-length state and consumes a mismatch once", async () => {
    const dependencies = spotifyDependencies();
    const baseUrl = await startSpotifyServer(dependencies);
    const { state, cookie } = await beginSpotifyLogin(baseUrl);

    const mismatch = await fetch(
      `${baseUrl}/spotify/callback?code=provider-code&state=${changedOpaque(state)}`,
      {
        redirect: "manual",
        headers: { cookie },
      },
    );
    const retry = await fetch(
      `${baseUrl}/spotify/callback?code=provider-code&state=${state}`,
      {
        redirect: "manual",
        headers: { cookie },
      },
    );

    expect(mismatch.status).toBe(302);
    expect(retry.status).toBe(302);
    expect(mismatch.headers.get("location")).toContain(
      "spotify_error=invalid_state",
    );
    expect(retry.headers.get("location")).toContain(
      "spotify_error=invalid_state",
    );
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.tokenStore.upsert).not.toHaveBeenCalled();
  });

  it("consumes successful state once and stores tokens for the principal account", async () => {
    const dependencies = spotifyDependencies();
    const accessToken = `access-${randomBytes(24).toString("base64url")}`;
    const refreshToken = `refresh-${randomBytes(24).toString("base64url")}`;
    dependencies.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3_600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "spotify-user",
            display_name: "Spotify User",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const baseUrl = await startSpotifyServer(dependencies);
    const { state, cookie } = await beginSpotifyLogin(baseUrl);

    const callback = await fetch(
      `${baseUrl}/spotify/callback?code=provider-code&state=${state}&sid=${OTHER_ACCOUNT_ID}`,
      {
        redirect: "manual",
        headers: {
          cookie,
          "x-client-session": OTHER_ACCOUNT_ID,
        },
      },
    );
    const replay = await fetch(
      `${baseUrl}/spotify/callback?code=provider-code&state=${state}`,
      {
        redirect: "manual",
        headers: { cookie },
      },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_connected=1`,
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain(
      "spotify_error=invalid_state",
    );
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.tokenStore.upsert).toHaveBeenCalledOnce();
    expect(dependencies.tokenStore.upsert).toHaveBeenCalledWith(ACCOUNT_ID, {
      accessToken,
      refreshToken,
      expiresAt: new Date(NOW + 3_600_000),
      spotifyUserId: "spotify-user",
      displayName: "Spotify User",
    });
    expect(
      JSON.stringify(dependencies.tokenStore.upsert.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
    expect(callback.headers.get("location")).not.toContain(accessToken);
    expect(callback.headers.get("location")).not.toContain(refreshToken);
  });

  it("does not log an upstream body or provider token on exchange failure", async () => {
    const dependencies = spotifyDependencies();
    const tokenCanary = `provider-${randomBytes(24).toString("base64url")}`;
    dependencies.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: tokenCanary }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    const baseUrl = await startSpotifyServer(dependencies);
    const { state, cookie } = await beginSpotifyLogin(baseUrl);

    const callback = await fetch(
      `${baseUrl}/spotify/callback?code=provider-code&state=${state}`,
      {
        redirect: "manual",
        headers: { cookie },
      },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain(
      "spotify_error=token_exchange_failed",
    );
    expect(JSON.stringify(dependencies.log.error.mock.calls)).not.toContain(
      tokenCanary,
    );
    expect(await callback.text()).not.toContain(tokenCanary);
  });
});

describe("Spotify account ownership", () => {
  it("ignores header and query session selectors for token reads and logout", async () => {
    const dependencies = spotifyDependencies();
    dependencies.tokenStore.get.mockResolvedValue(tokenRecord());
    const baseUrl = await startSpotifyServer(dependencies);
    const headers = { "x-client-session": OTHER_ACCOUNT_ID };

    const status = await fetch(
      `${baseUrl}/spotify/status?sid=${OTHER_ACCOUNT_ID}&sessionId=${OTHER_ACCOUNT_ID}`,
      { headers },
    );
    const logout = await fetch(
      `${baseUrl}/spotify/logout?sid=${OTHER_ACCOUNT_ID}`,
      {
        method: "POST",
        headers,
      },
    );

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      connected: true,
      spotifyUserId: "spotify-user",
    });
    expect(logout.status).toBe(200);
    expect(dependencies.tokenStore.get).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(dependencies.tokenStore.delete).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(
      JSON.stringify(dependencies.tokenStore.get.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
    expect(
      JSON.stringify(dependencies.tokenStore.delete.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
  });
});
