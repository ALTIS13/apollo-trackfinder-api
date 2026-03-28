import { Router, type IRouter } from "express";
import { searchYouTube } from "../adapters/youtube.js";
import { searchSoundCloud } from "../adapters/soundcloud.js";
import { rank } from "../lib/ranker.js";
import { getCached, setCached } from "../lib/cache.js";
import { getStreamUrl, spawnAudioDownload, type AudioQuality } from "../lib/ytdlp.js";
import { searchBandcamp } from "../adapters/bandcamp.js";
import { SearchTracksBody } from "@workspace/api-zod";

const router: IRouter = Router();

const ALLOWED_HOSTS: Record<string, string[]> = {
  yt: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
  sc: ["soundcloud.com", "www.soundcloud.com", "api.soundcloud.com", "api-v2.soundcloud.com"],
  bc: ["bandcamp.com"],
};

function decodeTrackUrl(id: string): { source: string; url: string } | null {
  const prefixes = ["yt_", "sc_", "bc_"];
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

  const [ytResults, scResults, bcResults] = await Promise.allSettled([
    searchYouTube(query, maxResults),
    searchSoundCloud(query, maxResults),
    searchBandcamp(query, perSource),
  ]);

  const allResults = [
    ...(ytResults.status === "fulfilled" ? ytResults.value : []),
    ...(scResults.status === "fulfilled" ? scResults.value : []),
    ...(bcResults.status === "fulfilled" ? bcResults.value : []),
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
    const [ytResults, scResults, bcResults] = await Promise.allSettled([
      searchYouTube(query, 8),
      searchSoundCloud(query, 8),
      searchBandcamp(query, 4),
    ]);

    const allResults = [
      ...(ytResults.status === "fulfilled" ? ytResults.value : []),
      ...(scResults.status === "fulfilled" ? scResults.value : []),
      ...(bcResults.status === "fulfilled" ? bcResults.value : []),
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
    const { url, mimeType } = await getStreamUrl(decoded.url);
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
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

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

router.get("/tracks/lyrics", async (req, res) => {
  const artist = String(req.query["artist"] ?? "").trim();
  const title = String(req.query["title"] ?? "").trim();
  const duration = Number(req.query["duration"] ?? 0);

  if (!artist || !title) {
    res.status(400).json({ error: "bad_request", message: "artist and title are required" });
    return;
  }

  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (duration > 0) params.set("duration", String(Math.round(duration)));

    const response = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { "Lrclib-Client": "Apollo TrackFinder/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 404) {
      res.json({ plainLyrics: null, syncedLyrics: null });
      return;
    }

    if (!response.ok) {
      res.status(502).json({ error: "lyrics_unavailable", message: "Lyrics service error" });
      return;
    }

    const data = await response.json() as {
      plainLyrics?: string | null;
      syncedLyrics?: string | null;
    };

    res.json({
      plainLyrics: data.plainLyrics ?? null,
      syncedLyrics: data.syncedLyrics ?? null,
    });
  } catch (err) {
    req.log.warn({ err }, "Lyrics fetch failed");
    res.json({ plainLyrics: null, syncedLyrics: null });
  }
});

export default router;
