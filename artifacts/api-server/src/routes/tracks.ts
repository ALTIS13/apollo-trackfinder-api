import { Router, type IRouter } from "express";
import { searchYouTube } from "../adapters/youtube.js";
import { searchSoundCloud } from "../adapters/soundcloud.js";
import { rank } from "../lib/ranker.js";
import { getCached, setCached } from "../lib/cache.js";
import { getStreamUrl, spawnAudioDownload, type AudioQuality } from "../lib/ytdlp.js";
import { searchBandcamp } from "../adapters/bandcamp.js";
import { searchDeezer } from "../adapters/deezer.js";
import { SearchTracksBody } from "@workspace/api-zod";
import { getCachedStreamUrl, setCachedStreamUrl } from "../lib/stream-cache.js";
import { isRedisAvailable, getRedis } from "../lib/redis.js";
import { enqueueDownload, getDownloadJobStatus, DOWNLOAD_DIR, type DownloadJobData } from "../lib/background-queue.js";
import { db } from "@workspace/db";
import { playHistoryTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import * as fsSync from "node:fs";
import * as path from "node:path";

const router: IRouter = Router();

const ALLOWED_HOSTS: Record<string, string[]> = {
  yt: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
  sc: ["soundcloud.com", "www.soundcloud.com", "api.soundcloud.com", "api-v2.soundcloud.com"],
  bc: ["bandcamp.com"],
  dz: ["dzcdn.net", "cdns-preview-e.dzcdn.net"],
};

function decodeTrackUrl(id: string): { source: string; url: string } | null {
  const prefixes = ["yt_", "sc_", "bc_", "dz_"];
  let source: string | null = null;
  let encodedPart: string | null = null;

  for (const p of prefixes) {
    if (id.startsWith(p)) {
      source = p.slice(0, -1);
      encodedPart = id.slice(p.length);
      break;
    }
  }

  if (!source || !encodedPart) return null;

  let url: string;
  try {
    url = Buffer.from(encodedPart, "base64url").toString("utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS[source] ?? [];
    const isAllowed = allowed.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    if (!isAllowed) return null;
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return { source, url };
}

router.post("/tracks/search", async (req, res) => {
  const parseResult = SearchTracksBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "bad_request", message: "artist and title are required" });
    return;
  }

  const { artist, title } = parseResult.data;
  const query = `${artist} ${title}`.trim();
  const maxResults = Math.min(Math.max(Number((req.body as Record<string, unknown>).maxResults ?? 20), 5), 40);
  const isExtendedSearch = maxResults > 20;

  if (!isExtendedSearch) {
    const cached = await getCached<Record<string, unknown>>(artist, title);
    if (cached) {
      res.json({ query, results: cached, cached: true });
      return;
    }
  }

  const perSource = Math.ceil(maxResults / 2);

  const [ytResults, scResults, bcResults, dzResults] = await Promise.allSettled([
    searchYouTube(query, maxResults),
    searchSoundCloud(query, maxResults),
    searchBandcamp(query, perSource),
    searchDeezer(query, perSource),
  ]);

  const allResults = [
    ...(ytResults.status === "fulfilled" ? ytResults.value : []),
    ...(scResults.status === "fulfilled" ? scResults.value : []),
    ...(bcResults.status === "fulfilled" ? bcResults.value : []),
    ...(dzResults.status === "fulfilled" ? dzResults.value : []),
  ];

  if (ytResults.status === "rejected") {
    req.log.warn({ err: ytResults.reason }, "YouTube search failed");
  }
  if (scResults.status === "rejected") {
    req.log.warn({ err: scResults.reason }, "SoundCloud search failed");
  }
  if (bcResults.status === "rejected") {
    req.log.warn({ err: bcResults.reason }, "Bandcamp search failed");
  }
  if (dzResults.status === "rejected") {
    req.log.warn({ err: dzResults.reason }, "Deezer search failed");
  }

  const referenceDuration =
    allResults
      .filter((r) => r.type === "original" && r.duration > 0)
      .map((r) => r.duration)
      .sort((a, b) => a - b)
      .at(Math.floor(allResults.filter((r) => r.type === "original").length / 2)) ?? undefined;

  const ranked = rank(allResults, { artist, title }, referenceDuration);

  const apiResults = ranked.map(({ _sourceUrl: _, ...r }) => r);

  if (!isExtendedSearch) {
    await setCached(artist, title, apiResults).catch((err) => {
      req.log.warn({ err }, "Failed to save to cache");
    });
  }

  res.json({ query, results: apiResults, cached: false });
});

router.post("/tracks/batch-search", async (req, res) => {
  const { tracks } = req.body as { tracks?: { artist: string; title: string }[] };

  if (!Array.isArray(tracks) || tracks.length === 0) {
    res.status(400).json({ error: "bad_request", message: "tracks array is required" });
    return;
  }

  if (tracks.length > 100) {
    res.status(400).json({ error: "too_many", message: "Maximum 100 tracks per batch" });
    return;
  }

  const CONCURRENCY = 8;

  async function searchOne(artist: string, title: string): Promise<{ matches: Record<string, unknown>[]; cached: boolean }> {
    const cached = await getCached<Record<string, unknown>>(artist, title);
    if (cached) return { matches: cached as Record<string, unknown>[], cached: true };

    const query = `${artist} ${title}`.trim();
    const [ytResults, scResults, bcResults, dzResults] = await Promise.allSettled([
      searchYouTube(query, 8),
      searchSoundCloud(query, 8),
      searchBandcamp(query, 4),
      searchDeezer(query, 8),
    ]);

    const allResults = [
      ...(ytResults.status === "fulfilled" ? ytResults.value : []),
      ...(scResults.status === "fulfilled" ? scResults.value : []),
      ...(bcResults.status === "fulfilled" ? bcResults.value : []),
      ...(dzResults.status === "fulfilled" ? dzResults.value : []),
    ];

    const referenceDuration =
      allResults
        .filter((r) => r.type === "original" && r.duration > 0)
        .map((r) => r.duration)
        .sort((a, b) => a - b)
        .at(Math.floor(allResults.filter((r) => r.type === "original").length / 2)) ?? undefined;

    const ranked = rank(allResults, { artist, title }, referenceDuration);
    const apiResults = ranked.map(({ _sourceUrl: _, ...r }) => r) as Record<string, unknown>[];

    await setCached(artist, title, apiResults).catch(() => null);
    return { matches: apiResults, cached: false };
  }

  const results: {
    index: number;
    query: { artist: string; title: string };
    matches: Record<string, unknown>[];
    bestScore: number;
    autoSelected: boolean;
  }[] = [];

  for (let i = 0; i < tracks.length; i += CONCURRENCY) {
    const chunk = tracks.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (t, ci) => {
        try {
          const { matches } = await searchOne(t.artist, t.title);
          const bestScore = typeof matches[0]?.score === "number" ? matches[0].score : 0;
          return {
            index: i + ci,
            query: { artist: t.artist, title: t.title },
            matches: matches.slice(0, 5),
            bestScore,
            autoSelected: bestScore >= 80,
          };
        } catch {
          return {
            index: i + ci,
            query: { artist: t.artist, title: t.title },
            matches: [],
            bestScore: 0,
            autoSelected: false,
          };
        }
      }),
    );
    results.push(...chunkResults);
  }

  res.json({ results });
});

router.get("/tracks/:id/stream", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "bad_request", message: "id is required" });
    return;
  }

  const decoded = decodeTrackUrl(id);
  if (!decoded) {
    res.status(400).json({ error: "bad_request", message: "Invalid track id format" });
    return;
  }

  try {
    const cached = await getCachedStreamUrl(id);
    if (cached) {
      res.json({ id, streamUrl: cached.url, mimeType: cached.mimeType, cached: true });
      return;
    }

    if (decoded.source === "dz") {
      const dzArtist = String(req.query["artist"] ?? "").trim();
      const dzTitle = String(req.query["title"] ?? "").trim();

      if (dzArtist && dzTitle) {
        try {
          const ytResults = await searchYouTube(`${dzArtist} ${dzTitle}`, 3);
          const ytTrack = ytResults.find((r) => r._sourceUrl) ?? ytResults[0];
          if (ytTrack?._sourceUrl) {
            const { url, mimeType } = await getStreamUrl(ytTrack._sourceUrl);
            await setCachedStreamUrl(id, url, mimeType ?? "audio/mpeg");
            res.json({ id, streamUrl: url, mimeType: mimeType ?? "audio/mpeg" });
            return;
          }
        } catch (e) {
          req.log.warn({ e }, "Deezer→YouTube stream fallback failed, using preview");
        }
      }

      res.json({ id, streamUrl: decoded.url, mimeType: "audio/mpeg" });
      return;
    }
    const { url, mimeType } = await getStreamUrl(decoded.url);
    await setCachedStreamUrl(id, url, mimeType ?? "audio/mpeg");
    res.json({ id, streamUrl: url, mimeType: mimeType ?? null });
  } catch (err) {
    req.log.error({ err, id }, "Failed to get stream URL");
    res.status(500).json({ error: "stream_error", message: "Could not resolve stream URL" });
  }
});

router.get("/tracks/:id/download", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "bad_request", message: "id is required" });
    return;
  }

  const decoded = decodeTrackUrl(id);
  if (!decoded) {
    res.status(400).json({ error: "bad_request", message: "Invalid track id format" });
    return;
  }

  const rawQuality = String(req.query["quality"] ?? "256");
  const quality: AudioQuality = (["128", "192", "256", "320", "flac"] as const).includes(rawQuality as AudioQuality)
    ? (rawQuality as AudioQuality)
    : "256";
  const ext = quality === "flac" ? "flac" : "mp3";
  const mimeType = quality === "flac" ? "audio/flac" : "audio/mpeg";

  try {
    const filename = `track_${id.slice(0, 16)}.${ext}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (decoded.source === "dz") {
      const dzArtist = String(req.query["artist"] ?? "").trim();
      const dzTitle = String(req.query["title"] ?? "").trim();
      const query = `${dzArtist} ${dzTitle}`.trim();

      const pipeFallback = (sourceUrl: string, label: string) => {
        req.log.info({ id, artist: dzArtist, title: dzTitle }, `Deezer→${label} download fallback`);
        res.setHeader("Content-Type", mimeType);
        const proc = spawnAudioDownload(sourceUrl, quality);
        proc.stdout.pipe(res);
        proc.stderr.on("data", () => {});
        req.on("close", () => proc.kill("SIGKILL"));
        proc.on("close", (code) => { if (code !== 0 && !res.writableEnded) res.destroy(); });
        proc.on("error", (err) => {
          req.log.error({ err }, `yt-dlp error during deezer ${label} fallback`);
          if (!res.headersSent) res.status(500).json({ error: "download_error" });
          else res.destroy();
        });
      };

      if (query) {
        // Try YouTube first
        try {
          const ytResults = await searchYouTube(query, 3);
          const ytTrack = ytResults.find((r) => r._sourceUrl) ?? ytResults[0];
          if (ytTrack?._sourceUrl) {
            pipeFallback(ytTrack._sourceUrl, "YouTube");
            return;
          }
        } catch (e) {
          req.log.warn({ e }, "Deezer→YouTube fallback failed, trying SoundCloud");
        }

        // Try SoundCloud as secondary fallback
        try {
          const scResults = await searchSoundCloud(query, 3);
          const scTrack = scResults.find((r) => r._sourceUrl) ?? scResults[0];
          if (scTrack?._sourceUrl) {
            pipeFallback(scTrack._sourceUrl, "SoundCloud");
            return;
          }
        } catch (e) {
          req.log.warn({ e }, "Deezer→SoundCloud fallback also failed");
        }
      }

      // All fallbacks exhausted — return a clear error so the mobile doesn't
      // save a 0-byte or expired-CDN file as a valid download.
      res.status(502).json({ error: "download_error", message: "Could not find a downloadable source for this track" });
      return;
    }

    res.setHeader("Content-Type", mimeType);

    const proc = spawnAudioDownload(decoded.url, quality);
    proc.stdout.pipe(res);
    proc.stderr.on("data", () => {});

    req.on("close", () => proc.kill("SIGKILL"));

    proc.on("close", (code) => {
      if (code !== 0 && !res.writableEnded) {
        res.destroy();
      }
    });
    proc.on("error", (err) => {
      req.log.error({ err, id }, "yt-dlp spawn error");
      if (!res.headersSent) {
        res.status(500).json({ error: "download_error", message: "Failed to start downloader" });
      } else {
        res.destroy();
      }
    });
  } catch (err) {
    req.log.error({ err, id }, "Failed to start audio download");
    if (!res.headersSent) {
      res.status(500).json({ error: "download_error", message: "Could not resolve download URL" });
    }
  }
});

router.get("/tracks/:id/audio-stream", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "bad_request", message: "id is required" });
    return;
  }

  const decoded = decodeTrackUrl(id);
  if (!decoded) {
    res.status(400).json({ error: "bad_request", message: "Invalid track id format" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "no-cache");

  const pipeProc = (sourceUrl: string) => {
    const proc = spawnAudioDownload(sourceUrl, "128");
    proc.stdout.pipe(res);
    proc.stderr.on("data", () => {});
    req.on("close", () => proc.kill("SIGKILL"));
    proc.on("close", (code) => { if (code !== 0 && !res.writableEnded) res.destroy(); });
    proc.on("error", (err) => {
      req.log.error({ err }, "yt-dlp error in audio-stream");
      if (!res.headersSent) res.status(500).json({ error: "stream_error" });
      else res.destroy();
    });
  };

  try {
    if (decoded.source === "dz") {
      const dzArtist = String(req.query["artist"] ?? "").trim();
      const dzTitle = String(req.query["title"] ?? "").trim();
      const query = `${dzArtist} ${dzTitle}`.trim();

      if (query) {
        // Try YouTube first
        try {
          const ytResults = await searchYouTube(query, 3);
          const ytTrack = ytResults.find((r) => r._sourceUrl) ?? ytResults[0];
          if (ytTrack?._sourceUrl) {
            req.log.info({ id, artist: dzArtist, title: dzTitle }, "Deezer→YouTube audio-stream fallback");
            pipeProc(ytTrack._sourceUrl);
            return;
          }
        } catch (e) {
          req.log.warn({ e }, "Deezer→YouTube audio-stream fallback failed, trying SoundCloud");
        }

        // Try SoundCloud as secondary fallback
        try {
          const scResults = await searchSoundCloud(query, 3);
          const scTrack = scResults.find((r) => r._sourceUrl) ?? scResults[0];
          if (scTrack?._sourceUrl) {
            req.log.info({ id, artist: dzArtist, title: dzTitle }, "Deezer→SoundCloud audio-stream fallback");
            pipeProc(scTrack._sourceUrl);
            return;
          }
        } catch (e) {
          req.log.warn({ e }, "Deezer→SoundCloud audio-stream fallback also failed");
        }
      }

      res.status(502).json({ error: "stream_error", message: "Could not find a streamable source for this track" });
      return;
    }

    pipeProc(decoded.url);
  } catch (err) {
    req.log.error({ err, id }, "Failed to start audio stream");
    if (!res.headersSent) {
      res.status(500).json({ error: "stream_error", message: "Could not start audio stream" });
    }
  }
});

async function fetchLrclib(artist: string, title: string, duration: number): Promise<{ plainLyrics: string | null; syncedLyrics: string | null } | null> {
  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (duration > 0) params.set("duration", String(Math.round(duration)));
    const r = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "Lrclib-Client": "Apollo TrackFinder/1.0" },
      signal: AbortSignal.timeout(7000),
    });
    if (r.status === 404) return { plainLyrics: null, syncedLyrics: null };
    if (!r.ok) return null;
    const d = await r.json() as { plainLyrics?: string | null; syncedLyrics?: string | null };
    const plain = d.plainLyrics?.trim() ?? null;
    const synced = d.syncedLyrics?.trim() ?? null;
    if (!plain && !synced) return null;
    return { plainLyrics: plain, syncedLyrics: synced };
  } catch {
    return null;
  }
}

async function fetchLrcLibSearch(artist: string, title: string): Promise<{ plainLyrics: string | null; syncedLyrics: string | null } | null> {
  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: title, limit: "3" });
    const r = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { "Lrclib-Client": "Apollo TrackFinder/1.0" },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return null;
    const results = await r.json() as Array<{ plainLyrics?: string | null; syncedLyrics?: string | null }>;
    for (const item of results) {
      const plain = item.plainLyrics?.trim() ?? null;
      const synced = item.syncedLyrics?.trim() ?? null;
      if (plain || synced) return { plainLyrics: plain, syncedLyrics: synced };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchLyricsOvh(artist: string, title: string): Promise<{ plainLyrics: string | null; syncedLyrics: null } | null> {
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json() as { lyrics?: string; error?: string };
    if (d.error || !d.lyrics?.trim()) return null;
    return { plainLyrics: d.lyrics.trim(), syncedLyrics: null };
  } catch {
    return null;
  }
}

router.get("/tracks/recent", async (req, res) => {
  const sessionId = (req.headers["x-client-session"] as string | undefined) ??
    String(req.query["sessionId"] ?? "");

  if (!sessionId) {
    res.json({ results: [] });
    return;
  }

  const rawLimit = Number(req.query["limit"] ?? 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 10;

  try {
    const result = await db.execute(sql`
      SELECT t.track_id, t.artist, t.title
      FROM (
        SELECT DISTINCT ON (track_id)
          track_id, artist, title, played_at
        FROM play_history
        WHERE session_id = ${sessionId}
        ORDER BY track_id, played_at DESC
      ) t
      ORDER BY t.played_at DESC
      LIMIT ${limit}
    `);

    const resultRows = (result.rows ?? result) as { track_id: string; artist: string | null; title: string | null }[];

    res.json({
      results: resultRows.map((r) => ({
        id: r.track_id,
        artist: r.artist ?? "",
        title: r.title ?? "",
        thumbnailUrl: null,
      })),
    });
  } catch (err) {
    req.log.warn({ err }, "Failed to fetch recent tracks");
    res.json({ results: [] });
  }
});

router.post("/tracks/play", async (req, res) => {
  const { trackId, artist, title, sessionId } = req.body as Record<string, unknown>;

  if (!trackId || typeof trackId !== "string") {
    res.status(400).json({ error: "bad_request", message: "trackId is required" });
    return;
  }

  const effectiveSession = (sessionId && typeof sessionId === "string" && sessionId.trim())
    ? sessionId.trim()
    : (req.headers["x-client-session"] as string | undefined) ?? "anonymous";

  try {
    await db.insert(playHistoryTable).values({
      sessionId: effectiveSession,
      trackId: String(trackId),
      artist: typeof artist === "string" ? artist : null,
      title: typeof title === "string" ? title : null,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    req.log.warn({ err }, "Failed to record play history");
    res.status(500).json({ error: "db_error", message: "Could not record play" });
  }
});

router.get("/tracks/recommendations", async (req, res) => {
  const sessionId = (req.headers["x-client-session"] as string | undefined) ??
    String(req.query["sessionId"] ?? "");

  if (!sessionId) {
    res.json({ results: [] });
    return;
  }

  try {
    const topArtistsRows = await db
      .select({
        artist: playHistoryTable.artist,
        count: sql<number>`count(*)::int`,
      })
      .from(playHistoryTable)
      .where(eq(playHistoryTable.sessionId, sessionId))
      .groupBy(playHistoryTable.artist)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    const artists = topArtistsRows
      .map((r) => r.artist)
      .filter((a): a is string => !!a);

    if (artists.length === 0) {
      res.json({ results: [] });
      return;
    }

    const searchPromises = artists.map((artist) =>
      Promise.allSettled([
        searchYouTube(artist, 6),
        searchSoundCloud(artist, 6),
      ]).then(([yt, sc]) => [
        ...(yt.status === "fulfilled" ? yt.value : []),
        ...(sc.status === "fulfilled" ? sc.value : []),
      ]),
    );

    const nested = await Promise.all(searchPromises);
    const allResults = nested.flat();

    const seen = new Set<string>();
    const deduped = allResults.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    const limited = deduped.slice(0, 20).map(({ _sourceUrl: _, ...r }) => r);

    res.json({ results: limited });
  } catch (err) {
    req.log.warn({ err }, "Failed to generate recommendations");
    res.json({ results: [] });
  }
});

router.get("/tracks/suggest", async (req, res) => {
  const q = String(req.query["q"] ?? "").trim().toLowerCase();
  if (!q || q.length < 2) {
    res.json({ suggestions: [] });
    return;
  }

  try {
    // Try Redis SCAN (non-blocking O(1) per call) — keys are `search:<artist>::<title>`
    if (isRedisAvailable()) {
      const redis = getRedis();
      if (redis) {
        const pattern = `search:*${q}*`;
        const found: string[] = [];
        let cursor = "0";
        do {
          const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 50);
          cursor = nextCursor;
          for (const key of keys) {
            if (found.length >= 5) break;
            found.push(key);
          }
        } while (cursor !== "0" && found.length < 5);

        const suggestions = found.map((key: string) => {
          const cacheKey = key.replace(/^search:/, "");
          const sep = cacheKey.indexOf("::");
          if (sep === -1) return null;
          return { artist: cacheKey.slice(0, sep), title: cacheKey.slice(sep + 2) };
        }).filter(Boolean);
        res.json({ suggestions });
        return;
      }
    }

    // PostgreSQL path (indexed on cache_key)
    const rows = await db.execute(
      sql`SELECT cache_key FROM track_search_cache WHERE cache_key LIKE ${"%" + q + "%"} AND expires_at > NOW() ORDER BY id DESC LIMIT 5`,
    );
    const resultRows = (rows.rows ?? rows) as { cache_key: string }[];
    const suggestions = resultRows.map((r) => {
      const sep = r.cache_key.indexOf("::");
      if (sep === -1) return null;
      return { artist: r.cache_key.slice(0, sep), title: r.cache_key.slice(sep + 2) };
    }).filter(Boolean);

    res.json({ suggestions });
  } catch (err) {
    req.log.warn({ err }, "Suggest query failed");
    res.json({ suggestions: [] });
  }
});

router.get("/tracks/lyrics", async (req, res) => {
  const artist = String(req.query["artist"] ?? "").trim();
  const title = String(req.query["title"] ?? "").trim();
  const duration = Number(req.query["duration"] ?? 0);

  if (!artist || !title) {
    res.status(400).json({ error: "bad_request", message: "artist and title are required" });
    return;
  }

  try {
    const lrclibExact = await fetchLrclib(artist, title, duration);
    if (lrclibExact && (lrclibExact.plainLyrics || lrclibExact.syncedLyrics)) {
      res.json(lrclibExact);
      return;
    }

    const lrclibSearch = await fetchLrcLibSearch(artist, title);
    if (lrclibSearch) {
      res.json(lrclibSearch);
      return;
    }

    const ovh = await fetchLyricsOvh(artist, title);
    if (ovh) {
      res.json(ovh);
      return;
    }

    res.json({ plainLyrics: null, syncedLyrics: null });
  } catch (err) {
    req.log.warn({ err }, "Lyrics fetch failed");
    res.json({ plainLyrics: null, syncedLyrics: null });
  }
});

// --- Download Queue endpoints ---

/**
 * Validate and allowlist a source URL for download queue jobs.
 * Accepts either a trusted track ID (decoded server-side via decodeTrackUrl)
 * or an explicit sourceUrl that must match HTTPS + allowed host allowlist.
 */
function validateDownloadSourceUrl(trackId: string, rawSourceUrl?: string): string | null {
  // Primary: derive from trusted track ID
  const decoded = decodeTrackUrl(trackId);
  if (decoded) return decoded.url;

  // Fallback: if caller provided a raw URL, apply allowlist
  if (rawSourceUrl) {
    try {
      const parsed = new URL(rawSourceUrl);
      if (parsed.protocol !== "https:") return null;
      const host = parsed.hostname.toLowerCase();
      const allAllowed = Object.values(ALLOWED_HOSTS).flat();
      const ok = allAllowed.some((h) => host === h || host.endsWith(`.${h}`));
      if (!ok) return null;
      return rawSourceUrl;
    } catch {
      return null;
    }
  }

  return null;
}

router.post("/tracks/download/queue", async (req, res) => {
  const body = req.body as { tracks?: unknown[] };
  if (!Array.isArray(body.tracks) || body.tracks.length === 0) {
    res.status(400).json({ error: "tracks array is required" });
    return;
  }
  if (body.tracks.length > 50) {
    res.status(400).json({ error: "Maximum 50 tracks per request" });
    return;
  }

  const results: Array<{ trackId: string; jobId: string; position: number } | { trackId: string; error: string }> = [];

  for (const t of body.tracks as Record<string, unknown>[]) {
    const trackId = String(t["trackId"] ?? t["id"] ?? "").trim();
    const artist = String(t["artist"] ?? "").trim();
    const title = String(t["title"] ?? "").trim();
    const quality = (t["quality"] as string) ?? "128k";
    const rawSourceUrl = t["sourceUrl"] ? String(t["sourceUrl"]) : undefined;

    if (!trackId) {
      results.push({ trackId, error: "trackId is required" });
      continue;
    }

    // Derive source URL server-side from trusted track ID (with allowlist fallback)
    const sourceUrl = validateDownloadSourceUrl(trackId, rawSourceUrl);
    if (!sourceUrl) {
      results.push({ trackId, error: "Could not resolve a trusted source URL for this track" });
      continue;
    }

    try {
      const { jobId, position } = await enqueueDownload({
        trackId,
        artist,
        title,
        quality: quality as import("../lib/ytdlp.js").AudioQuality,
        sourceUrl,
      });
      results.push({ trackId, jobId, position });
    } catch (err) {
      results.push({ trackId, error: (err as Error).message });
    }
  }

  res.json({ results });
});

router.get("/tracks/download/status/:jobId", async (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const status = await getDownloadJobStatus(jobId);
  res.json(status);
});

router.get("/tracks/download/file/:jobId", async (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const status = await getDownloadJobStatus(jobId);
  if (status.status !== "completed" || !status.filePath) {
    res.status(404).json({ error: "File not ready", status: status.status });
    return;
  }
  if (!fsSync.existsSync(status.filePath)) {
    res.status(404).json({ error: "File not found on disk" });
    return;
  }
  const ext = path.extname(status.filePath).slice(1) || "mp3";
  const mime = ext === "flac" ? "audio/flac" : "audio/mpeg";
  const filename = path.basename(status.filePath);
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (status.fileSize) res.setHeader("Content-Length", status.fileSize);
  fsSync.createReadStream(status.filePath).pipe(res);
});

export default router;

