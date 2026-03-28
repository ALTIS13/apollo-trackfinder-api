import { Router } from "express";
import { db } from "@workspace/db";
import { spotifyTokensTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger.js";

const router = Router();

const CLIENT_ID = process.env["SPOTIFY_CLIENT_ID"]!;
const CLIENT_SECRET = process.env["SPOTIFY_CLIENT_SECRET"]!;

const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

function makeRedirectUri(hostname: string): string {
  const domain = process.env["REPLIT_DOMAINS"]?.split(",")[0] ?? hostname;
  return `https://${domain}/api/spotify/callback`;
}

function getSessionId(req: Parameters<typeof router.get>[1] extends (req: infer R, ...args: any[]) => any ? R : never): string | null {
  const header = req.headers["x-client-session"];
  if (typeof header === "string" && header.length > 8) return header;
  return req.session?.session_id ?? null;
}

async function refreshIfExpired(sessionId: string) {
  const rows = await db.select().from(spotifyTokensTable).where(eq(spotifyTokensTable.sessionId, sessionId));
  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt > new Date(Date.now() + 60_000)) return row;

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) {
      logger.error({ status: resp.status }, "Spotify token refresh failed");
      return null;
    }

    const data = (await resp.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    const updated = await db
      .update(spotifyTokensTable)
      .set({ accessToken: data.access_token, refreshToken: data.refresh_token ?? row.refreshToken, expiresAt, updatedAt: new Date() })
      .where(eq(spotifyTokensTable.sessionId, sessionId))
      .returning();

    return updated[0] ?? null;
  } catch (err) {
    logger.error({ err }, "Error refreshing Spotify token");
    return null;
  }
}

router.get("/spotify/login", (req, res) => {
  if (!CLIENT_ID) {
    res.status(500).json({ error: "spotify_not_configured", message: "SPOTIFY_CLIENT_ID is not set" });
    return;
  }

  const clientSessionId = (req.query["sid"] as string) ?? req.headers["x-client-session"] as string;
  if (!clientSessionId) {
    res.status(400).json({ error: "no_session", message: "No client session ID provided" });
    return;
  }

  const isMobile = req.query["mobile"] === "1";
  const nonce = randomBytes(8).toString("hex");
  const state = `${encodeURIComponent(clientSessionId)}__${nonce}${isMobile ? "__m" : ""}`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: makeRedirectUri(req.hostname),
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

router.get("/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  const stateParts = (state ?? "").split("__");
  const isMobile = stateParts[stateParts.length - 1] === "m";

  function mobileOrWebRedirect(path: string, params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    if (isMobile) {
      res.redirect(`trackfinder://${path}?${qs}`);
    } else {
      res.redirect(`/${path}?${qs}`);
    }
  }

  if (error) {
    mobileOrWebRedirect("favorites", { spotify_error: error });
    return;
  }

  if (!state || !state.includes("__")) {
    mobileOrWebRedirect("favorites", { spotify_error: "invalid_state" });
    return;
  }

  const [encodedSessionId] = stateParts;
  const clientSessionId = decodeURIComponent(encodedSessionId);

  if (!clientSessionId || clientSessionId.length < 8) {
    mobileOrWebRedirect("favorites", { spotify_error: "state_mismatch" });
    return;
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: makeRedirectUri(req.hostname),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, text }, "Spotify token exchange failed");
      mobileOrWebRedirect("favorites", { spotify_error: "token_exchange_failed" });
      return;
    }

    const tokens = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const meResp = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = meResp.ok ? ((await meResp.json()) as { id: string; display_name?: string }) : null;
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await db
      .insert(spotifyTokensTable)
      .values({
        sessionId: clientSessionId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        spotifyUserId: me?.id ?? null,
        displayName: me?.display_name ?? null,
      })
      .onConflictDoUpdate({
        target: spotifyTokensTable.sessionId,
        set: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          spotifyUserId: me?.id ?? null,
          displayName: me?.display_name ?? null,
          updatedAt: new Date(),
        },
      });

    mobileOrWebRedirect("favorites", { spotify_connected: "1" });
  } catch (err) {
    logger.error({ err }, "Spotify callback error");
    mobileOrWebRedirect("favorites", { spotify_error: "internal" });
  }
});

router.get("/spotify/status", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    res.json({ connected: false });
    return;
  }

  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) {
    res.json({ connected: false });
    return;
  }

  res.json({ connected: true, displayName: tokens.displayName, spotifyUserId: tokens.spotifyUserId });
});

router.get("/spotify/logout", async (req, res) => {
  const sessionId = getSessionId(req);
  if (sessionId) {
    await db.delete(spotifyTokensTable).where(eq(spotifyTokensTable.sessionId, sessionId));
  }
  res.json({ ok: true });
});

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

async function spotifyGet<T>(token: string, path: string, params?: Record<string, string>): Promise<T | null> {
  const url = new URL(`https://api.spotify.com/v1${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    logger.error({ status: resp.status, path }, "Spotify API error");
    return null;
  }
  return resp.json() as Promise<T>;
}

function mapTrack(track: SpotifyTrack) {
  const image = track.album.images.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return {
    id: track.id,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    album: track.album.name,
    durationMs: track.duration_ms,
    thumbnailUrl: image?.url ?? null,
    spotifyUrl: track.external_urls.spotify,
  };
}

router.get("/spotify/liked", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(401).json({ error: "not_connected" }); return; }
  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) { res.status(401).json({ error: "not_connected" }); return; }

  const offset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Number(req.query["limit"] ?? 50), 50);

  const data = await spotifyGet<{ items: { track: SpotifyTrack }[]; total: number }>(
    tokens.accessToken, "/me/tracks", { limit: String(limit), offset: String(offset) }
  );
  if (!data) { res.status(502).json({ error: "spotify_error" }); return; }

  const tracks = data.items.map((i) => mapTrack(i.track));
  res.json({ tracks, total: data.total, offset, limit, hasMore: offset + tracks.length < data.total });
});

router.get("/spotify/liked-all", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(401).json({ error: "not_connected" }); return; }
  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) { res.status(401).json({ error: "not_connected" }); return; }

  const allTracks: ReturnType<typeof mapTrack>[] = [];
  const pageSize = 50;
  let offset = 0;
  let total = Infinity;

  while (offset < total && allTracks.length < 500) {
    const data = await spotifyGet<{ items: { track: SpotifyTrack }[]; total: number }>(
      tokens.accessToken, "/me/tracks", { limit: String(pageSize), offset: String(offset) }
    );
    if (!data) break;
    total = data.total;
    allTracks.push(...data.items.map((i) => mapTrack(i.track)));
    offset += pageSize;
    if (data.items.length < pageSize) break;
  }

  res.json({ tracks: allTracks, total: allTracks.length });
});

router.get("/spotify/playlists", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(401).json({ error: "not_connected" }); return; }
  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) { res.status(401).json({ error: "not_connected" }); return; }

  const data = await spotifyGet<{
    items: { id: string; name: string; description: string; tracks: { total: number }; images: { url: string }[]; owner: { display_name: string } }[];
    total: number;
  }>(tokens.accessToken, "/me/playlists", { limit: "50" });
  if (!data) { res.status(502).json({ error: "spotify_error" }); return; }

  res.json({
    playlists: data.items.map((p) => ({
      id: p.id, name: p.name, description: p.description,
      trackCount: p.tracks.total, thumbnailUrl: p.images[0]?.url ?? null, owner: p.owner.display_name,
    })),
    total: data.total,
  });
});

router.get("/spotify/playlists/:playlistId/tracks", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(401).json({ error: "not_connected" }); return; }
  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) { res.status(401).json({ error: "not_connected" }); return; }

  const { playlistId } = req.params;
  const offset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Number(req.query["limit"] ?? 50), 50);

  const data = await spotifyGet<{ items: { track: SpotifyTrack | null }[]; total: number }>(
    tokens.accessToken, `/playlists/${playlistId}/tracks`,
    { limit: String(limit), offset: String(offset), fields: "items(track(id,name,artists,album,duration_ms,external_urls)),total" }
  );
  if (!data) { res.status(502).json({ error: "spotify_error" }); return; }

  res.json({
    tracks: data.items.filter((i): i is { track: SpotifyTrack } => i.track != null).map((i) => mapTrack(i.track)),
    total: data.total, offset, limit,
  });
});

router.get("/spotify/top-tracks", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(401).json({ error: "not_connected" }); return; }
  const tokens = await refreshIfExpired(sessionId);
  if (!tokens) { res.status(401).json({ error: "not_connected" }); return; }

  const timeRange = (req.query["time_range"] as string) ?? "medium_term";
  const data = await spotifyGet<{ items: SpotifyTrack[] }>(
    tokens.accessToken, "/me/top/tracks", { limit: "50", time_range: timeRange }
  );
  if (!data) { res.status(502).json({ error: "spotify_error" }); return; }

  res.json({ tracks: data.items.map(mapTrack), timeRange });
});

export default router;
