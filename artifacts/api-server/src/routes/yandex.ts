import { db } from "@workspace/db";
import { yandexTokensTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";

import { logger } from "../lib/logger.js";

const YM_BASE = "https://api.music.yandex.net";
const YM_HEADERS = {
  "X-Yandex-Music-Client": "YandexMusicAndroid/24023621",
  Accept: "application/json",
};

export interface YandexTokenRecord {
  readonly oauthToken: string;
  readonly yandexUserId: string | null;
  readonly displayName: string | null;
  readonly login: string | null;
}

export interface YandexTokenStore {
  readonly get: (accountId: string) => Promise<YandexTokenRecord | null>;
  readonly upsert: (
    accountId: string,
    tokens: YandexTokenRecord,
  ) => Promise<void>;
  readonly delete: (accountId: string) => Promise<void>;
}

export interface YandexRouteDependencies {
  readonly fetch: typeof fetch;
  readonly log: Pick<typeof logger, "error">;
  readonly tokenStore: YandexTokenStore;
}

const defaultYandexTokenStore: YandexTokenStore = {
  async get(accountId) {
    const rows = await db
      .select()
      .from(yandexTokensTable)
      .where(eq(yandexTokensTable.sessionId, accountId));
    const row = rows[0];
    return row === undefined
      ? null
      : {
          oauthToken: row.oauthToken,
          yandexUserId: row.yandexUserId,
          displayName: row.displayName,
          login: row.login,
        };
  },
  async upsert(accountId, tokens) {
    await db
      .insert(yandexTokensTable)
      .values({
        sessionId: accountId,
        ...tokens,
      })
      .onConflictDoUpdate({
        target: yandexTokensTable.sessionId,
        set: {
          ...tokens,
          updatedAt: new Date(),
        },
      });
  },
  async delete(accountId) {
    await db
      .delete(yandexTokensTable)
      .where(eq(yandexTokensTable.sessionId, accountId));
  },
};

function defaultDependencies(): YandexRouteDependencies {
  return {
    fetch,
    log: logger,
    tokenStore: defaultYandexTokenStore,
  };
}

async function ymGet<T>(
  dependencies: YandexRouteDependencies,
  token: string,
  path: string,
  parameters?: Record<string, string>,
): Promise<T | null> {
  const url = new URL(`${YM_BASE}${path}`);
  if (parameters) {
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }
  }

  try {
    const response = await dependencies.fetch(url.toString(), {
      headers: { ...YM_HEADERS, Authorization: `OAuth ${token}` },
    });
    if (!response.ok) {
      dependencies.log.error(
        { status: response.status, path },
        "Yandex Music API error",
      );
      return null;
    }
    const value = (await response.json()) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const envelope = value as Record<string, unknown>;
    return (envelope.result ?? value) as T;
  } catch {
    dependencies.log.error(
      { errorType: "ProviderUnavailable", path },
      "Yandex Music fetch error",
    );
    return null;
  }
}

interface YmTrack {
  id: number;
  title: string;
  artists: { name: string }[];
  albums: { title: string; coverUri?: string; year?: number }[];
  durationMs?: number;
}

function mapYmTrack(track: YmTrack) {
  const album = track.albums[0];
  const coverUri = album?.coverUri
    ? `https://${album.coverUri.replace("%%", "200x200")}`
    : null;
  return {
    id: String(track.id),
    title: track.title,
    artist: track.artists.map((artist) => artist.name).join(", "),
    album: album?.title ?? "",
    durationMs: track.durationMs ?? 0,
    thumbnailUrl: coverUri,
    trackUrl: `https://music.yandex.ru/track/${track.id}`,
  };
}

export function createYandexRouter(
  overrides: Partial<YandexRouteDependencies> = {},
): IRouter {
  const dependencies: YandexRouteDependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  const router = Router();

  router.post("/yandex/token", async (request, response) => {
    const token =
      typeof request.body === "object" &&
      request.body !== null &&
      typeof (request.body as Record<string, unknown>).token === "string"
        ? (request.body as Record<string, string>).token.trim()
        : "";
    if (token.length < 10 || token.length > 8_192) {
      response.status(400).json({
        error: "invalid_token",
        message: "Token is required",
      });
      return;
    }
    const accountData = await ymGet<{
      account: {
        uid: number;
        login: string;
        displayName?: string;
        fullName?: string;
      };
    }>(dependencies, token, "/account/status");
    if (accountData === null) {
      response.status(401).json({
        error: "auth_failed",
        message: "Could not authenticate with Yandex Music. Check your token.",
      });
      return;
    }
    const account = accountData.account;
    const displayName =
      account.fullName ?? account.displayName ?? account.login;
    try {
      await dependencies.tokenStore.upsert(request.tfPrincipal!.accountId, {
        oauthToken: token,
        yandexUserId: String(account.uid),
        displayName,
        login: account.login,
      });
    } catch {
      dependencies.log.error(
        { errorType: "StorageUnavailable" },
        "Yandex token persistence failed",
      );
      response.status(503).json({ error: "yandex_unavailable" });
      return;
    }
    response.json({
      ok: true,
      displayName,
      login: account.login,
      userId: String(account.uid),
    });
  });

  router.get("/yandex/status", async (request, response) => {
    const row = await dependencies.tokenStore.get(
      request.tfPrincipal!.accountId,
    );
    if (row === null || row.yandexUserId === null) {
      response.json({ connected: false });
      return;
    }
    response.json({
      connected: true,
      displayName: row.displayName,
      login: row.login,
      userId: row.yandexUserId,
    });
  });

  router.post("/yandex/logout", async (request, response) => {
    try {
      await dependencies.tokenStore.delete(request.tfPrincipal!.accountId);
    } catch {
      dependencies.log.error(
        { errorType: "StorageUnavailable" },
        "Yandex token deletion failed",
      );
      response.status(503).json({ error: "yandex_unavailable" });
      return;
    }
    response.json({ ok: true });
  });

  router.get("/yandex/liked", async (request, response) => {
    const row = await dependencies.tokenStore.get(
      request.tfPrincipal!.accountId,
    );
    if (row === null || row.yandexUserId === null) {
      response.status(401).json({
        error: "not_connected",
        message: "Yandex Music session not found",
      });
      return;
    }
    const data = await ymGet<{
      library: { tracks: { id: number; albumId?: number }[] };
    }>(dependencies, row.oauthToken, `/users/${row.yandexUserId}/likes/tracks`);
    if (data === null) {
      response.status(502).json({
        error: "ym_error",
        message: "Failed to fetch liked tracks",
      });
      return;
    }
    const trackReferences = data.library?.tracks ?? [];
    if (trackReferences.length === 0) {
      response.json({ tracks: [], total: 0 });
      return;
    }
    const offset = Number(request.query["offset"] ?? 0);
    const limit = Math.min(Number(request.query["limit"] ?? 50), 50);
    const page = trackReferences.slice(offset, offset + limit);
    const trackIds = page
      .map((track) =>
        track.albumId ? `${track.id}:${track.albumId}` : String(track.id),
      )
      .join(",");
    const tracks = await ymGet<YmTrack[]>(
      dependencies,
      row.oauthToken,
      "/tracks",
      { "track-ids": trackIds },
    );
    if (tracks === null) {
      response.status(502).json({
        error: "ym_error",
        message: "Failed to fetch track details",
      });
      return;
    }
    response.json({
      tracks: tracks.map(mapYmTrack),
      total: trackReferences.length,
      offset,
      limit,
    });
  });

  router.get("/yandex/playlists", async (request, response) => {
    const row = await dependencies.tokenStore.get(
      request.tfPrincipal!.accountId,
    );
    if (row === null || row.yandexUserId === null) {
      response.status(401).json({
        error: "not_connected",
        message: "Yandex Music session not found",
      });
      return;
    }
    const data = await ymGet<
      {
        kind: number;
        title: string;
        description?: string;
        trackCount: number;
        cover?: { uri?: string };
        owner: { login: string; name?: string; displayName?: string };
        uid: number;
      }[]
    >(
      dependencies,
      row.oauthToken,
      `/users/${row.yandexUserId}/playlists/list`,
    );
    if (data === null) {
      response.status(502).json({
        error: "ym_error",
        message: "Failed to fetch playlists",
      });
      return;
    }
    response.json({
      playlists: data.map((playlist) => ({
        kind: playlist.kind,
        uid: playlist.uid,
        title: playlist.title,
        description: playlist.description ?? "",
        trackCount: playlist.trackCount,
        thumbnailUrl: playlist.cover?.uri
          ? `https://${playlist.cover.uri.replace("%%", "200x200")}`
          : null,
        owner:
          playlist.owner.displayName ??
          playlist.owner.name ??
          playlist.owner.login,
      })),
      total: data.length,
    });
  });

  router.get(
    "/yandex/playlists/:uid/:kind/tracks",
    async (request, response) => {
      const row = await dependencies.tokenStore.get(
        request.tfPrincipal!.accountId,
      );
      if (row === null) {
        response.status(401).json({
          error: "not_connected",
          message: "Yandex Music session not found",
        });
        return;
      }
      const { uid, kind } = request.params;
      const offset = Number(request.query["offset"] ?? 0);
      const limit = Math.min(Number(request.query["limit"] ?? 50), 50);
      const data = await ymGet<{
        kind: number;
        title: string;
        tracks?: { id: number; timestamp: string; track?: YmTrack }[];
      }>(dependencies, row.oauthToken, `/users/${uid}/playlists/${kind}`);
      if (data === null) {
        response.status(502).json({
          error: "ym_error",
          message: "Failed to fetch playlist tracks",
        });
        return;
      }
      const tracks = (data.tracks ?? []).slice(offset, offset + limit);
      response.json({
        tracks: tracks
          .filter(
            (
              track,
            ): track is typeof track & {
              track: YmTrack;
            } => track.track !== undefined,
          )
          .map((track) => mapYmTrack(track.track)),
        total: data.tracks?.length ?? 0,
        offset,
        limit,
      });
    },
  );

  return router;
}

export default createYandexRouter();
