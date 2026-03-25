import { Router, type IRouter } from "express";
import { searchYouTube } from "../adapters/youtube.js";
import { searchSoundCloud } from "../adapters/soundcloud.js";
import { rank } from "../lib/ranker.js";
import { getCached, setCached } from "../lib/cache.js";
import { getStreamUrl } from "../lib/ytdlp.js";
import { SearchTracksBody } from "@workspace/api-zod";

const router: IRouter = Router();

function decodeTrackUrl(id: string): { source: "yt" | "sc"; url: string } | null {
  if (id.startsWith("yt_")) {
    try {
      return { source: "yt", url: Buffer.from(id.slice(3), "base64url").toString() };
    } catch {
      return null;
    }
  }
  if (id.startsWith("sc_")) {
    try {
      return { source: "sc", url: Buffer.from(id.slice(3), "base64url").toString() };
    } catch {
      return null;
    }
  }
  return null;
}

router.post("/tracks/search", async (req, res) => {
  const parseResult = SearchTracksBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "bad_request", message: "artist and title are required" });
    return;
  }

  const { artist, title } = parseResult.data;
  const query = `${artist} ${title}`.trim();

  const cached = await getCached<Record<string, unknown>>(artist, title);
  if (cached) {
    res.json({ query, results: cached, cached: true });
    return;
  }

  const [ytResults, scResults] = await Promise.allSettled([
    searchYouTube(query, 10),
    searchSoundCloud(query, 10),
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

  await setCached(artist, title, apiResults).catch((err) => {
    req.log.warn({ err }, "Failed to save to cache");
  });

  res.json({ query, results: apiResults, cached: false });
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
