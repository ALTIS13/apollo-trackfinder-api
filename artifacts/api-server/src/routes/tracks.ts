import { Router, type IRouter } from "express";
import { searchYouTube } from "../adapters/youtube.js";
import { searchSoundCloud } from "../adapters/soundcloud.js";
import { rank } from "../lib/ranker.js";
import { getCached, setCached } from "../lib/cache.js";
import { getStreamUrl } from "../lib/ytdlp.js";
import { SearchTracksBody } from "@workspace/api-zod";

const router: IRouter = Router();

const ALLOWED_HOSTS: Record<"yt" | "sc", string[]> = {
  yt: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
  sc: ["soundcloud.com", "www.soundcloud.com", "api.soundcloud.com", "api-v2.soundcloud.com"],
};

function decodeTrackUrl(id: string): { source: "yt" | "sc"; url: string } | null {
  let source: "yt" | "sc";
  let encodedPart: string;

  if (id.startsWith("yt_")) {
    source = "yt";
    encodedPart = id.slice(3);
  } else if (id.startsWith("sc_")) {
    source = "sc";
    encodedPart = id.slice(3);
  } else {
    return null;
  }

  let url: string;
  try {
    url = Buffer.from(encodedPart, "base64url").toString("utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS[source].includes(hostname)) {
      return null;
    }
    if (parsed.protocol !== "https:") {
      return null;
    }
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

  const [ytResults, scResults] = await Promise.allSettled([
    searchYouTube(query, maxResults),
    searchSoundCloud(query, maxResults),
  ]);

  const allResults = [
    ...(ytResults.status === "fulfilled" ? ytResults.value : []),
    ...(scResults.status === "fulfilled" ? scResults.value : []),
  ];

  if (ytResults.status === "rejected") {
    req.log.warn({ err: ytResults.reason }, "YouTube search failed");
  }
  if (scResults.status === "rejected") {
    req.log.warn({ err: scResults.reason }, "SoundCloud search failed");
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
    const [ytResults, scResults] = await Promise.allSettled([
      searchYouTube(query, 8),
      searchSoundCloud(query, 8),
    ]);

    const allResults = [
      ...(ytResults.status === "fulfilled" ? ytResults.value : []),
      ...(scResults.status === "fulfilled" ? scResults.value : []),
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

  try {
    const { url } = await getStreamUrl(decoded.url);
    const filename = `track_${id.slice(0, 16)}.mp3`;
    res.json({ id, downloadUrl: url, filename });
  } catch (err) {
    req.log.error({ err, id }, "Failed to get download URL");
    res.status(500).json({ error: "download_error", message: "Could not resolve download URL" });
  }
});

export default router;
