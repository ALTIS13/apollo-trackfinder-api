import { Router } from "express";
import { db } from "@workspace/db";
import { yandexTokensTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger.js";

const router = Router();

const YM_BASE = "https://api.music.yandex.net";
const YM_HEADERS = {
  "X-Yandex-Music-Client": "YandexMusicAndroid/24023621",
  "Accept": "application/json",
};

async function ymGet<T>(token: string, path: string, params?: Record<string, string>): Promise<T | null> {
  const url = new URL(`${YM_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        ...YM_HEADERS,
        Authorization: `OAuth ${token}`,
      },
    });

    if (!resp.ok) {
      logger.error({ status: resp.status, path }, "Yandex Music API error");
      return null;
    }

    const json = (await resp.json()) as { result?: T };
    return json.result ?? (json as T);
  } catch (err) {
    logger.error({ err, path }, "Yandex Music fetch error");
    return null;
  }
}

async function getYmTokenRow(sessionId: string) {
  const rows = await db.select().from(yandexTokensTable).where(eq(yandexTokensTable.sessionId, sessionId));
  return rows[0] ?? null;
}

router.post("/yandex/token", async (req, res) => {
  const { token } = req.body as { token?: string };

  if (!token || token.trim().length < 10) {
    res.status(400).json({ error: "invalid_token", message: "Token is required" });
    return;
  }

  const trimmedToken = token.trim();

  const accountData = await ymGet<{
    account: { uid: number; login: string; displayName?: string; fullName?: string };
  }>(trimmedToken, "/account/status");

  if (!accountData) {
    res.status(401).json({ error: "auth_failed", message: "Could not authenticate with Yandex Music. Check your token." });
    return;
  }

  const account = accountData.account;
  const sessionId = req.session.session_id ?? randomBytes(16).toString("hex");
  req.session.session_id = sessionId;

  await db
    .insert(yandexTokensTable)
    .values({
      sessionId,
      oauthToken: trimmedToken,
      yandexUserId: String(account.uid),
      displayName: account.fullName ?? account.displayName ?? account.login,
      login: account.login,
    })
    .onConflictDoUpdate({
      target: yandexTokensTable.sessionId,
      set: {
        oauthToken: trimmedToken,
        yandexUserId: String(account.uid),
        displayName: account.fullName ?? account.displayName ?? account.login,
        login: account.login,
        updatedAt: new Date(),
      },
    });

  res.json({
    ok: true,
    displayName: account.fullName ?? account.displayName ?? account.login,
    login: account.login,
    userId: String(account.uid),
  });
});

router.get("/yandex/status", async (req, res) => {
  const sessionId = req.session.session_id;
  if (!sessionId) {
    res.json({ connected: false });
    return;
  }

  const row = await getYmTokenRow(sessionId);
  if (!row) {
    res.json({ connected: false });
    return;
  }

  res.json({
    connected: true,
    displayName: row.displayName,
    login: row.login,
    userId: row.yandexUserId,
  });
});

router.get("/yandex/logout", async (req, res) => {
  const sessionId = req.session.session_id;
  if (sessionId) {
    await db.delete(yandexTokensTable).where(eq(yandexTokensTable.sessionId, sessionId));
  }
  res.json({ ok: true });
});

interface YmTrack {
  id: number;
  title: string;
  artists: { name: string }[];
  albums: { title: string; coverUri?: string; year?: number }[];
  durationMs?: number;
}

function mapYmTrack(t: YmTrack) {
  const album = t.albums[0];
  const coverUri = album?.coverUri
    ? `https://${album.coverUri.replace("%%", "200x200")}`
    : null;

  return {
    id: String(t.id),
    title: t.title,
    artist: t.artists.map((a) => a.name).join(", "),
    album: album?.title ?? "",
    durationMs: t.durationMs ?? 0,
    thumbnailUrl: coverUri,
    trackUrl: `https://music.yandex.ru/track/${t.id}`,
  };
}

router.get("/yandex/liked", async (req, res) => {
  const sessionId = req.session.session_id;
  if (!sessionId) {
    res.status(401).json({ error: "not_connected", message: "Not connected to Yandex Music" });
    return;
  }

  const row = await getYmTokenRow(sessionId);
  if (!row?.oauthToken || !row.yandexUserId) {
    res.status(401).json({ error: "not_connected", message: "Yandex Music session not found" });
    return;
  }

  const data = await ymGet<{ library: { tracks: { id: number; albumId?: number }[] } }>(
    row.oauthToken,
    `/users/${row.yandexUserId}/likes/tracks`
  );

  if (!data) {
    res.status(502).json({ error: "ym_error", message: "Failed to fetch liked tracks" });
    return;
  }

  const trackRefs = data.library?.tracks ?? [];

  if (trackRefs.length === 0) {
    res.json({ tracks: [], total: 0 });
    return;
  }

  const offset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Number(req.query["limit"] ?? 50), 50);
  const page = trackRefs.slice(offset, offset + limit);

  const trackIds = page.map((t) => (t.albumId ? `${t.id}:${t.albumId}` : String(t.id))).join(",");

  const tracksData = await ymGet<YmTrack[]>(row.oauthToken, "/tracks", { "track-ids": trackIds });

  if (!tracksData) {
    res.status(502).json({ error: "ym_error", message: "Failed to fetch track details" });
    return;
  }

  res.json({
    tracks: tracksData.map(mapYmTrack),
    total: trackRefs.length,
    offset,
    limit,
  });
});

router.get("/yandex/playlists", async (req, res) => {
  const sessionId = req.session.session_id;
  if (!sessionId) {
    res.status(401).json({ error: "not_connected", message: "Not connected to Yandex Music" });
    return;
  }

  const row = await getYmTokenRow(sessionId);
  if (!row?.oauthToken || !row.yandexUserId) {
    res.status(401).json({ error: "not_connected", message: "Yandex Music session not found" });
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
  >(row.oauthToken, `/users/${row.yandexUserId}/playlists/list`);

  if (!data) {
    res.status(502).json({ error: "ym_error", message: "Failed to fetch playlists" });
    return;
  }

  res.json({
    playlists: data.map((p) => ({
      kind: p.kind,
      uid: p.uid,
      title: p.title,
      description: p.description ?? "",
      trackCount: p.trackCount,
      thumbnailUrl: p.cover?.uri ? `https://${p.cover.uri.replace("%%", "200x200")}` : null,
      owner: p.owner.displayName ?? p.owner.name ?? p.owner.login,
    })),
    total: data.length,
  });
});

router.get("/yandex/playlists/:uid/:kind/tracks", async (req, res) => {
  const sessionId = req.session.session_id;
  if (!sessionId) {
    res.status(401).json({ error: "not_connected", message: "Not connected to Yandex Music" });
    return;
  }

  const row = await getYmTokenRow(sessionId);
  if (!row?.oauthToken) {
    res.status(401).json({ error: "not_connected", message: "Yandex Music session not found" });
    return;
  }

  const { uid, kind } = req.params;
  const offset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Number(req.query["limit"] ?? 50), 50);

  const data = await ymGet<{
    kind: number;
    title: string;
    tracks?: { id: number; timestamp: string; track?: YmTrack }[];
  }>(row.oauthToken, `/users/${uid}/playlists/${kind}`);

  if (!data) {
    res.status(502).json({ error: "ym_error", message: "Failed to fetch playlist tracks" });
    return;
  }

  const tracks = (data.tracks ?? []).slice(offset, offset + limit);
  const mapped = tracks
    .filter((t): t is typeof t & { track: YmTrack } => t.track != null)
    .map((t) => mapYmTrack(t.track));

  res.json({
    tracks: mapped,
    total: data.tracks?.length ?? 0,
    offset,
    limit,
  });
});

export default router;
