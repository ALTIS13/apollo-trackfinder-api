import { randomBytes, timingSafeEqual } from "node:crypto";

import { db } from "@workspace/db";
import { spotifyTokensTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";

import { logger } from "../lib/logger.js";

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

export interface SpotifyTokenRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly spotifyUserId: string | null;
  readonly displayName: string | null;
}

export interface SpotifyTokenStore {
  readonly get: (accountId: string) => Promise<SpotifyTokenRecord | null>;
  readonly upsert: (
    accountId: string,
    tokens: SpotifyTokenRecord,
  ) => Promise<void>;
  readonly update: (
    accountId: string,
    tokens: SpotifyTokenRecord,
  ) => Promise<SpotifyTokenRecord | null>;
  readonly delete: (accountId: string) => Promise<void>;
}

export interface SpotifyRouteDependencies {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly serverUrl?: string;
  readonly publicApiDomain?: string;
  readonly webUrl: string;
  readonly now: () => number;
  readonly fetch: typeof fetch;
  readonly log: Pick<typeof logger, "error">;
  readonly tokenStore: SpotifyTokenStore;
}

const defaultSpotifyTokenStore: SpotifyTokenStore = {
  async get(accountId) {
    const rows = await db
      .select()
      .from(spotifyTokensTable)
      .where(eq(spotifyTokensTable.sessionId, accountId));
    const row = rows[0];
    return row === undefined
      ? null
      : {
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          expiresAt: row.expiresAt,
          spotifyUserId: row.spotifyUserId,
          displayName: row.displayName,
        };
  },
  async upsert(accountId, tokens) {
    await db
      .insert(spotifyTokensTable)
      .values({
        sessionId: accountId,
        ...tokens,
      })
      .onConflictDoUpdate({
        target: spotifyTokensTable.sessionId,
        set: {
          ...tokens,
          updatedAt: new Date(),
        },
      });
  },
  async update(accountId, tokens) {
    const rows = await db
      .update(spotifyTokensTable)
      .set({
        ...tokens,
        updatedAt: new Date(),
      })
      .where(eq(spotifyTokensTable.sessionId, accountId))
      .returning();
    const row = rows[0];
    return row === undefined
      ? null
      : {
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          expiresAt: row.expiresAt,
          spotifyUserId: row.spotifyUserId,
          displayName: row.displayName,
        };
  },
  async delete(accountId) {
    await db
      .delete(spotifyTokensTable)
      .where(eq(spotifyTokensTable.sessionId, accountId));
  },
};

function defaultDependencies(): SpotifyRouteDependencies {
  return {
    clientId: process.env["SPOTIFY_CLIENT_ID"] ?? "",
    clientSecret: process.env["SPOTIFY_CLIENT_SECRET"] ?? "",
    serverUrl: process.env["SERVER_URL"],
    publicApiDomain: process.env["PUBLIC_API_DOMAIN"],
    webUrl: process.env["WEB_URL"] ?? "",
    now: Date.now,
    fetch,
    log: logger,
    tokenStore: defaultSpotifyTokenStore,
  };
}

function redirectUri(
  dependencies: SpotifyRouteDependencies,
  hostname: string,
): string {
  if (dependencies.serverUrl) {
    return `${dependencies.serverUrl.replace(/\/$/, "")}/api/spotify/callback`;
  }
  const domain = dependencies.publicApiDomain ?? hostname;
  return `https://${domain}/api/spotify/callback`;
}

function fixedOpaqueEqual(left: string, right: string): boolean {
  if (!OPAQUE_PATTERN.test(left) || !OPAQUE_PATTERN.test(right)) return false;
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function providerState(): string {
  return randomBytes(32).toString("base64url");
}

function saveProviderSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function webRedirect(
  dependencies: SpotifyRouteDependencies,
  response: Response,
  parameters: Readonly<Record<string, string>>,
): void {
  const query = new URLSearchParams(parameters).toString();
  response.redirect(
    `${dependencies.webUrl.replace(/\/$/, "")}/favorites?${query}`,
  );
}

function safeProviderError(
  dependencies: SpotifyRouteDependencies,
  status: number,
  message: string,
): void {
  dependencies.log.error({ status }, message);
}

function parseTokenResponse(value: unknown): {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (
    typeof data.access_token !== "string" ||
    data.access_token.length < 1 ||
    data.access_token.length > 8_192 ||
    (data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" ||
        data.refresh_token.length < 1 ||
        data.refresh_token.length > 8_192)) ||
    typeof data.expires_in !== "number" ||
    !Number.isInteger(data.expires_in) ||
    data.expires_in < 1 ||
    data.expires_in > 86_400
  ) {
    return null;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

async function refreshIfExpired(
  dependencies: SpotifyRouteDependencies,
  accountId: string,
): Promise<SpotifyTokenRecord | null> {
  const row = await dependencies.tokenStore.get(accountId);
  if (row === null) return null;
  if (row.expiresAt.getTime() > dependencies.now() + 60_000) return row;

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refreshToken,
      client_id: dependencies.clientId,
      client_secret: dependencies.clientSecret,
    });
    const response = await dependencies.fetch(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    if (!response.ok) {
      safeProviderError(
        dependencies,
        response.status,
        "Spotify token refresh failed",
      );
      return null;
    }
    const tokens = parseTokenResponse(await response.json());
    if (tokens === null) {
      safeProviderError(
        dependencies,
        response.status,
        "Spotify token refresh failed",
      );
      return null;
    }
    return dependencies.tokenStore.update(accountId, {
      ...row,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? row.refreshToken,
      expiresAt: new Date(dependencies.now() + tokens.expiresIn * 1_000),
    });
  } catch {
    dependencies.log.error(
      { errorType: "ProviderUnavailable" },
      "Spotify token refresh failed",
    );
    return null;
  }
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  album: {
    name: string;
    images: { url: string; width?: number; height?: number }[];
  };
  duration_ms: number;
  external_urls: { spotify: string };
}

async function spotifyGet<T>(
  dependencies: SpotifyRouteDependencies,
  token: string,
  path: string,
  parameters?: Record<string, string>,
): Promise<T | null> {
  const url = new URL(`https://api.spotify.com/v1${path}`);
  if (parameters) {
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }
  }
  try {
    const response = await dependencies.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      safeProviderError(dependencies, response.status, "Spotify API error");
      return null;
    }
    return (await response.json()) as T;
  } catch {
    dependencies.log.error(
      { errorType: "ProviderUnavailable", path },
      "Spotify API error",
    );
    return null;
  }
}

function mapTrack(track: SpotifyTrack) {
  const image = [...track.album.images].sort(
    (left, right) => (right.width ?? 0) - (left.width ?? 0),
  )[0];
  return {
    id: track.id,
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(", "),
    album: track.album.name,
    durationMs: track.duration_ms,
    thumbnailUrl: image?.url ?? null,
    spotifyUrl: track.external_urls.spotify,
  };
}

export function createSpotifyRouter(
  overrides: Partial<SpotifyRouteDependencies> = {},
): IRouter {
  const dependencies: SpotifyRouteDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  const router = Router();

  router.get("/spotify/login", async (request, response) => {
    if (!dependencies.clientId) {
      response.status(500).json({
        error: "spotify_not_configured",
        message: "SPOTIFY_CLIENT_ID is not set",
      });
      return;
    }
    const state = providerState();
    request.session.spotify_state = state;
    try {
      await saveProviderSession(request);
      const parameters = new URLSearchParams({
        response_type: "code",
        client_id: dependencies.clientId,
        scope: SCOPES,
        redirect_uri: redirectUri(dependencies, request.hostname),
        state,
      });
      response.redirect(
        `https://accounts.spotify.com/authorize?${parameters.toString()}`,
      );
    } catch {
      response.status(503).json({ error: "spotify_unavailable" });
    }
  });

  router.get("/spotify/callback", async (request, response) => {
    const suppliedState =
      typeof request.query["state"] === "string" ? request.query["state"] : "";
    const expectedState = request.session.spotify_state;
    if (expectedState !== undefined) {
      delete request.session.spotify_state;
      try {
        await saveProviderSession(request);
      } catch {
        webRedirect(dependencies, response, { spotify_error: "internal" });
        return;
      }
    }
    if (
      expectedState === undefined ||
      !fixedOpaqueEqual(expectedState, suppliedState)
    ) {
      webRedirect(dependencies, response, {
        spotify_error: "invalid_state",
      });
      return;
    }
    if (request.query["error"] !== undefined) {
      webRedirect(dependencies, response, {
        spotify_error: "provider_denied",
      });
      return;
    }
    const code =
      typeof request.query["code"] === "string" ? request.query["code"] : "";
    if (!PROVIDER_CODE_PATTERN.test(code)) {
      webRedirect(dependencies, response, {
        spotify_error: "invalid_callback",
      });
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(dependencies, request.hostname),
        client_id: dependencies.clientId,
        client_secret: dependencies.clientSecret,
      });
      const tokenResponse = await dependencies.fetch(
        "https://accounts.spotify.com/api/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
      );
      if (!tokenResponse.ok) {
        safeProviderError(
          dependencies,
          tokenResponse.status,
          "Spotify token exchange failed",
        );
        webRedirect(dependencies, response, {
          spotify_error: "token_exchange_failed",
        });
        return;
      }
      const tokens = parseTokenResponse(await tokenResponse.json());
      if (tokens === null || tokens.refreshToken === undefined) {
        safeProviderError(
          dependencies,
          tokenResponse.status,
          "Spotify token exchange failed",
        );
        webRedirect(dependencies, response, {
          spotify_error: "token_exchange_failed",
        });
        return;
      }

      const meResponse = await dependencies.fetch(
        "https://api.spotify.com/v1/me",
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        },
      );
      const meValue = meResponse.ok ? await meResponse.json() : null;
      const me =
        typeof meValue === "object" &&
        meValue !== null &&
        !Array.isArray(meValue)
          ? (meValue as Record<string, unknown>)
          : null;
      await dependencies.tokenStore.upsert(request.tfPrincipal!.accountId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(dependencies.now() + tokens.expiresIn * 1_000),
        spotifyUserId: typeof me?.id === "string" ? me.id : null,
        displayName:
          typeof me?.display_name === "string" ? me.display_name : null,
      });
      webRedirect(dependencies, response, { spotify_connected: "1" });
    } catch {
      dependencies.log.error(
        { errorType: "ProviderUnavailable" },
        "Spotify callback error",
      );
      webRedirect(dependencies, response, { spotify_error: "internal" });
    }
  });

  router.get("/spotify/status", async (request, response) => {
    const tokens = await refreshIfExpired(
      dependencies,
      request.tfPrincipal!.accountId,
    );
    if (tokens === null) {
      response.json({ connected: false });
      return;
    }
    response.json({
      connected: true,
      displayName: tokens.displayName,
      spotifyUserId: tokens.spotifyUserId,
    });
  });

  router.post("/spotify/logout", async (request, response) => {
    await dependencies.tokenStore.delete(request.tfPrincipal!.accountId);
    response.json({ ok: true });
  });

  router.get("/spotify/liked", async (request, response) => {
    const tokens = await refreshIfExpired(
      dependencies,
      request.tfPrincipal!.accountId,
    );
    if (tokens === null) {
      response.status(401).json({ error: "not_connected" });
      return;
    }
    const offset = Number(request.query["offset"] ?? 0);
    const limit = Math.min(Number(request.query["limit"] ?? 50), 50);
    const data = await spotifyGet<{
      items: { track: SpotifyTrack }[];
      total: number;
    }>(dependencies, tokens.accessToken, "/me/tracks", {
      limit: String(limit),
      offset: String(offset),
    });
    if (data === null) {
      response.status(502).json({ error: "spotify_error" });
      return;
    }
    const tracks = data.items.map((item) => mapTrack(item.track));
    response.json({
      tracks,
      total: data.total,
      offset,
      limit,
      hasMore: offset + tracks.length < data.total,
    });
  });

  router.get("/spotify/liked-all", async (request, response) => {
    const tokens = await refreshIfExpired(
      dependencies,
      request.tfPrincipal!.accountId,
    );
    if (tokens === null) {
      response.status(401).json({ error: "not_connected" });
      return;
    }
    const allTracks: ReturnType<typeof mapTrack>[] = [];
    const pageSize = 50;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const data = await spotifyGet<{
        items: { track: SpotifyTrack }[];
        total: number;
      }>(dependencies, tokens.accessToken, "/me/tracks", {
        limit: String(pageSize),
        offset: String(offset),
      });
      if (data === null) break;
      total = data.total;
      allTracks.push(...data.items.map((item) => mapTrack(item.track)));
      offset += pageSize;
      if (data.items.length < pageSize) break;
    }
    response.json({ tracks: allTracks, total: allTracks.length });
  });

  router.get("/spotify/playlists", async (request, response) => {
    const tokens = await refreshIfExpired(
      dependencies,
      request.tfPrincipal!.accountId,
    );
    if (tokens === null) {
      response.status(401).json({ error: "not_connected" });
      return;
    }
    const data = await spotifyGet<{
      items: {
        id: string;
        name: string;
        description: string;
        tracks: { total: number };
        images: { url: string }[];
        owner: { display_name: string };
      }[];
      total: number;
    }>(dependencies, tokens.accessToken, "/me/playlists", { limit: "50" });
    if (data === null) {
      response.status(502).json({ error: "spotify_error" });
      return;
    }
    response.json({
      playlists: data.items.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        trackCount: playlist.tracks.total,
        thumbnailUrl: playlist.images[0]?.url ?? null,
        owner: playlist.owner.display_name,
      })),
      total: data.total,
    });
  });

  router.get(
    "/spotify/playlists/:playlistId/tracks",
    async (request, response) => {
      const tokens = await refreshIfExpired(
        dependencies,
        request.tfPrincipal!.accountId,
      );
      if (tokens === null) {
        response.status(401).json({ error: "not_connected" });
        return;
      }
      const { playlistId } = request.params;
      const offset = Number(request.query["offset"] ?? 0);
      const limit = Math.min(Number(request.query["limit"] ?? 50), 50);
      const data = await spotifyGet<{
        items: { track: SpotifyTrack | null }[];
        total: number;
      }>(dependencies, tokens.accessToken, `/playlists/${playlistId}/tracks`, {
        limit: String(limit),
        offset: String(offset),
        fields:
          "items(track(id,name,artists,album,duration_ms,external_urls)),total",
      });
      if (data === null) {
        response.status(502).json({ error: "spotify_error" });
        return;
      }
      response.json({
        tracks: data.items
          .filter(
            (item): item is { track: SpotifyTrack } => item.track !== null,
          )
          .map((item) => mapTrack(item.track)),
        total: data.total,
        offset,
        limit,
      });
    },
  );

  router.get("/spotify/top-tracks", async (request, response) => {
    const tokens = await refreshIfExpired(
      dependencies,
      request.tfPrincipal!.accountId,
    );
    if (tokens === null) {
      response.status(401).json({ error: "not_connected" });
      return;
    }
    const timeRange =
      typeof request.query["time_range"] === "string"
        ? request.query["time_range"]
        : "medium_term";
    const data = await spotifyGet<{ items: SpotifyTrack[] }>(
      dependencies,
      tokens.accessToken,
      "/me/top/tracks",
      { limit: "50", time_range: timeRange },
    );
    if (data === null) {
      response.status(502).json({ error: "spotify_error" });
      return;
    }
    response.json({ tracks: data.items.map(mapTrack), timeRange });
  });

  return router;
}

export default createSpotifyRouter();
