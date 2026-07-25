import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  TfIntegrationsCommand,
  TfIntegrationsErrorResponse,
  TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TfIntegrationsGateway } from "../lib/tf-integrations-client.js";
import { TfIntegrationsUnavailableError } from "../lib/tf-integrations-client.js";
import type { TfPrincipal } from "../lib/tf-policy.js";
import {
  createSpotifyRouter,
  type SpotifyRouteDependencies,
} from "./spotify.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??=
    "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const WEB_ORIGIN = "https://tf.apollot.ru";
const API_ORIGIN = "https://api.tf.apollot.ru";
const CALLBACK_URI = `${API_ORIGIN}/api/spotify/callback`;
const STATE = Buffer.alloc(32, 4).toString("base64url");
const principal = {
  accountId: ACCOUNT_ID,
  tfSessionId: "40000000-0000-4000-8000-000000000004",
  installationId: "30000000-0000-4000-8000-000000000003",
  entitlements: ["tf.integrations"],
  sessionExpiresAt: "2026-07-24T04:00:00.000Z",
  policyFreshUntil: "2026-07-24T03:05:00.000Z",
} as const;
const servers: Server[] = [];

type GatewayCommand = TfIntegrationsCommand extends infer Command
  ? Command extends TfIntegrationsCommand
    ? Omit<Command, "schemaVersion" | "requestId">
    : never
  : never;

const track = {
  id: "track-1",
  title: "Track",
  artist: "Artist",
  album: "Album",
  duration: 180,
  thumbnailUrl: "https://images.example.test/track.jpg",
  providerUrl: "https://open.spotify.com/track/track-1",
} as const;

const playlist = {
  id: "playlist-1",
  name: "Playlist",
  description: "Description",
  trackCount: 2,
  thumbnailUrl: "https://images.example.test/playlist.jpg",
  owner: "Owner",
} as const;

function success(
  command: GatewayCommand,
  result: unknown,
): TfIntegrationsSuccessResponse {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    accountId: command.accountId,
    operation: command.operation,
    result,
  } as TfIntegrationsSuccessResponse;
}

function failure(
  command: GatewayCommand,
  code: TfIntegrationsErrorResponse["error"]["code"],
): TfIntegrationsErrorResponse {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    accountId: command.accountId,
    operation: command.operation,
    error: { code },
  };
}

function defaultResult(command: GatewayCommand): unknown {
  switch (command.operation) {
    case "spotify.oauth.authorize":
      return {
        authorizationUrl:
          "https://accounts.spotify.com/authorize?client_id=client&response_type=code" +
          `&redirect_uri=${encodeURIComponent(CALLBACK_URI)}` +
          `&state=${STATE}&scope=user-library-read`,
      };
    case "spotify.oauth.complete":
      return {
        account: {
          provider: "spotify",
          connected: true,
          account: { id: "spotify-user", displayName: "Spotify User" },
        },
      };
    case "spotify.status":
      return {
        account: {
          provider: "spotify",
          connected: true,
          account: { id: "spotify-user", displayName: "Spotify User" },
        },
      };
    case "spotify.disconnect":
      return { ok: true };
    case "spotify.liked.list":
    case "spotify.playlist-tracks.list":
      return {
        tracks: [track],
        total: 2,
        offset: command.input.offset,
        limit: command.input.limit,
      };
    case "spotify.playlists.list":
      return { playlists: [playlist], total: 1 };
    case "spotify.top-tracks.list":
      return { tracks: [track] };
    default:
      throw new Error(`unexpected operation: ${command.operation}`);
  }
}

function spotifyDependencies(
  execute: (command: GatewayCommand) => Promise<
    TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse
  > = async (command) => success(command, defaultResult(command)),
) {
  const events: string[] = [];
  const gateway = {
    execute: vi.fn(async (command: GatewayCommand) => {
      events.push(`execute:${command.operation}`);
      return execute(command);
    }),
  } as unknown as TfIntegrationsGateway;
  return {
    dependencies: {
      gateway,
      serverUrl: API_ORIGIN,
      webUrl: WEB_ORIGIN,
      providerOAuthStateStore: {
        issueProviderOAuthState: vi.fn(async () => {
          events.push("state:issue");
          return STATE;
        }),
        consumeProviderOAuthState: vi.fn(async () => {
          events.push("state:consume");
          return true;
        }),
      },
    } satisfies SpotifyRouteDependencies,
    events,
    execute: gateway.execute as ReturnType<typeof vi.fn>,
  };
}

async function startSpotifyServer(
  dependencies: SpotifyRouteDependencies,
  currentPrincipal: TfPrincipal = principal,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.tfPrincipal = currentPrincipal;
    next();
  });
  app.use("/api", createSpotifyRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
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

describe("Spotify gateway routes", () => {
  it("issues API-owned state before dispatching the account-bound authorization command", async () => {
    const current = spotifyDependencies();
    const baseUrl = await startSpotifyServer(current.dependencies);

    const response = await request(
      baseUrl,
      `/spotify/login?sid=${OTHER_ACCOUNT_ID}`,
      { headers: { "x-client-session": OTHER_ACCOUNT_ID } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://accounts.spotify.com/authorize?",
    );
    expect(current.events).toEqual([
      "state:issue",
      "execute:spotify.oauth.authorize",
    ]);
    expect(current.execute).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      operation: "spotify.oauth.authorize",
      input: {
        state: STATE,
        callbackUri: CALLBACK_URI,
      },
    });
  });

  it("rejects authorization URLs with substituted state, callback, origin, or path", async () => {
    const authorizationUrl = (
      origin: string,
      path: string,
      state: string,
      callbackUri: string,
    ) =>
      `${origin}${path}?client_id=client&response_type=code` +
      `&redirect_uri=${encodeURIComponent(callbackUri)}` +
      `&state=${encodeURIComponent(state)}&scope=user-library-read`;
    const substitutions = [
      authorizationUrl(
        "https://accounts.spotify.com",
        "/authorize",
        "substituted-state",
        CALLBACK_URI,
      ),
      authorizationUrl(
        "https://accounts.spotify.com",
        "/authorize",
        STATE,
        "https://substituted.example/api/spotify/callback",
      ),
      authorizationUrl(
        "https://substituted.example",
        "/authorize",
        STATE,
        CALLBACK_URI,
      ),
      authorizationUrl(
        "https://accounts.spotify.com",
        "/substituted",
        STATE,
        CALLBACK_URI,
      ),
    ];
    const current = spotifyDependencies(async (command) =>
      success(command, {
        authorizationUrl: substitutions.shift()!,
      }),
    );
    const baseUrl = await startSpotifyServer(current.dependencies);

    for (let index = 0; index < 4; index += 1) {
      const response = await request(baseUrl, "/spotify/login");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "spotify_unavailable",
      });
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("consumes state before completion and never dispatches an invalid or denied callback", async () => {
    const current = spotifyDependencies();
    current.dependencies.providerOAuthStateStore.consumeProviderOAuthState =
      vi
        .fn()
        .mockImplementationOnce(async () => {
          current.events.push("state:consume");
          return false;
        })
        .mockImplementation(async () => {
          current.events.push("state:consume");
          return true;
        });
    const baseUrl = await startSpotifyServer(current.dependencies);

    const invalid = await request(
      baseUrl,
      "/spotify/callback?code=provider-code&state=invalid",
    );
    const denied = await request(
      baseUrl,
      `/spotify/callback?error=access_denied&state=${STATE}`,
    );

    expect(invalid.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_error=invalid_state`,
    );
    expect(denied.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_error=provider_denied`,
    );
    expect(current.execute).not.toHaveBeenCalled();

    const completed = await request(
      baseUrl,
      `/spotify/callback?code=provider-code&state=${STATE}`,
    );
    expect(completed.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_connected=1`,
    );
    expect(current.events.slice(-2)).toEqual([
      "state:consume",
      "execute:spotify.oauth.complete",
    ]);
    expect(current.execute).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      operation: "spotify.oauth.complete",
      input: {
        code: "provider-code",
        callbackUri: CALLBACK_URI,
      },
    });
  });

  it("derives accountId only from tfPrincipal for every Spotify command", async () => {
    const current = spotifyDependencies();
    const baseUrl = await startSpotifyServer(current.dependencies);
    const alias = `sid=${OTHER_ACCOUNT_ID}&accountId=${OTHER_ACCOUNT_ID}`;
    const headers = { "x-client-session": OTHER_ACCOUNT_ID };

    await request(baseUrl, `/spotify/login?${alias}`, { headers });
    await request(
      baseUrl,
      `/spotify/callback?code=provider-code&state=${STATE}&${alias}`,
      { headers },
    );
    await request(baseUrl, `/spotify/status?${alias}`, { headers });
    await request(baseUrl, `/spotify/logout?${alias}`, {
      method: "POST",
      headers,
    });
    await request(baseUrl, `/spotify/liked?offset=0&limit=1&${alias}`, {
      headers,
    });
    await request(baseUrl, `/spotify/liked-all?${alias}`, { headers });
    await request(baseUrl, `/spotify/playlists?${alias}`, { headers });
    await request(
      baseUrl,
      `/spotify/playlists/playlist-1/tracks?offset=0&limit=1&${alias}`,
      { headers },
    );
    await request(
      baseUrl,
      `/spotify/top-tracks?time_range=short_term&${alias}`,
      { headers },
    );

    expect(current.execute).toHaveBeenCalledTimes(9);
    for (const [command] of current.execute.mock.calls as [
      GatewayCommand,
    ][]) {
      expect(command.accountId).toBe(ACCOUNT_ID);
      expect(JSON.stringify(command)).not.toContain(OTHER_ACCOUNT_ID);
    }
    expect(
      current.dependencies.providerOAuthStateStore.issueProviderOAuthState,
    ).toHaveBeenCalledWith("spotify", ACCOUNT_ID);
    expect(
      current.dependencies.providerOAuthStateStore.consumeProviderOAuthState,
    ).toHaveBeenCalledWith("spotify", ACCOUNT_ID, STATE);
  });

  it("preserves connected, disconnected, logout, library, and callback redirect shapes", async () => {
    let statusCalls = 0;
    const current = spotifyDependencies(async (command) => {
      if (command.operation === "spotify.status") {
        statusCalls += 1;
        return success(command, {
          account:
            statusCalls === 1
              ? {
                  provider: "spotify",
                  connected: true,
                  account: {
                    id: "spotify-user",
                    displayName: "Spotify User",
                  },
                }
              : { provider: "spotify", connected: false },
        });
      }
      return success(command, defaultResult(command));
    });
    const baseUrl = await startSpotifyServer(current.dependencies);

    const connected = await request(baseUrl, "/spotify/status");
    const disconnected = await request(baseUrl, "/spotify/status");
    const logout = await request(baseUrl, "/spotify/logout", {
      method: "POST",
    });
    const liked = await request(
      baseUrl,
      "/spotify/liked?offset=0&limit=1",
    );
    const playlists = await request(baseUrl, "/spotify/playlists");
    const playlistTracks = await request(
      baseUrl,
      "/spotify/playlists/playlist-1/tracks?offset=0&limit=1",
    );
    const topTracks = await request(
      baseUrl,
      "/spotify/top-tracks?time_range=long_term",
    );
    const callback = await request(
      baseUrl,
      `/spotify/callback?code=provider-code&state=${STATE}`,
    );

    await expect(connected.json()).resolves.toEqual({
      connected: true,
      displayName: "Spotify User",
      spotifyUserId: "spotify-user",
    });
    await expect(disconnected.json()).resolves.toEqual({ connected: false });
    await expect(logout.json()).resolves.toEqual({ ok: true });
    await expect(liked.json()).resolves.toEqual({
      tracks: [
        {
          id: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          durationMs: 180_000,
          thumbnailUrl: "https://images.example.test/track.jpg",
          spotifyUrl: "https://open.spotify.com/track/track-1",
        },
      ],
      total: 2,
      offset: 0,
      limit: 1,
      hasMore: true,
    });
    await expect(playlists.json()).resolves.toEqual({
      playlists: [playlist],
      total: 1,
    });
    await expect(playlistTracks.json()).resolves.toEqual({
      tracks: [
        {
          id: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          durationMs: 180_000,
          thumbnailUrl: "https://images.example.test/track.jpg",
          spotifyUrl: "https://open.spotify.com/track/track-1",
        },
      ],
      total: 2,
      offset: 0,
      limit: 1,
    });
    await expect(topTracks.json()).resolves.toEqual({
      tracks: [
        {
          id: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          durationMs: 180_000,
          thumbnailUrl: "https://images.example.test/track.jpg",
          spotifyUrl: "https://open.spotify.com/track/track-1",
        },
      ],
      timeRange: "long_term",
    });
    expect(callback.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_connected=1`,
    );
  });

  it("implements liked-all through bounded liked-list commands and preserves partial results", async () => {
    let likedCalls = 0;
    const current = spotifyDependencies(async (command) => {
      if (command.operation !== "spotify.liked.list") {
        return success(command, defaultResult(command));
      }
      likedCalls += 1;
      if (likedCalls === 1) {
        return success(command, {
          tracks: Array.from({ length: 50 }, (_, index) => ({
            ...track,
            id: `track-${index}`,
          })),
          total: 120,
          offset: 0,
          limit: 50,
        });
      }
      return failure(command, "provider_unavailable");
    });
    const baseUrl = await startSpotifyServer(current.dependencies);

    const response = await request(baseUrl, "/spotify/liked-all");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tracks: unknown[];
      total: number;
    };
    expect(body.tracks).toHaveLength(50);
    expect(body.total).toBe(50);
    const likedCommands = (
      current.execute.mock.calls as [GatewayCommand][]
    ).map(([command]) => command);
    expect(likedCommands).toEqual([
      {
        accountId: ACCOUNT_ID,
        operation: "spotify.liked.list",
        input: { offset: 0, limit: 50 },
      },
      {
        accountId: ACCOUNT_ID,
        operation: "spotify.liked.list",
        input: { offset: 50, limit: 50 },
      },
    ]);
  });

  it("maps integration errors to existing sanitized public Spotify errors", async () => {
    const canary = "private-provider-code-canary";
    let statusCalls = 0;
    const current = spotifyDependencies(async (command) => {
      switch (command.operation) {
        case "spotify.status":
          statusCalls += 1;
          if (statusCalls === 1) {
            return failure(command, "provider_unavailable");
          }
          throw new TfIntegrationsUnavailableError();
        case "spotify.disconnect":
          return failure(command, "storage_unavailable");
        case "spotify.oauth.complete":
          return failure(command, "provider_rejected");
        default:
          return failure(command, "not_connected");
      }
    });
    const baseUrl = await startSpotifyServer(current.dependencies);

    const failedStatus = await request(baseUrl, "/spotify/status");
    const unavailableStatus = await request(baseUrl, "/spotify/status");
    const logout = await request(baseUrl, "/spotify/logout", {
      method: "POST",
    });
    const liked = await request(baseUrl, "/spotify/liked");
    const callback = await request(
      baseUrl,
      `/spotify/callback?code=${canary}&state=${STATE}`,
    );

    for (const status of [failedStatus, unavailableStatus]) {
      expect(status.status).toBe(503);
      await expect(status.json()).resolves.toEqual({
        error: "spotify_unavailable",
      });
    }
    expect(logout.status).toBe(503);
    await expect(logout.json()).resolves.toEqual({
      error: "spotify_unavailable",
    });
    expect(liked.status).toBe(401);
    await expect(liked.json()).resolves.toEqual({ error: "not_connected" });
    expect(callback.headers.get("location")).toBe(
      `${WEB_ORIGIN}/favorites?spotify_error=token_exchange_failed`,
    );
    expect(callback.headers.get("location")).not.toContain(canary);
  });
});
