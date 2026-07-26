import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getStreamUrl,
  spawnAudioDownload,
  type AudioQuality,
} from "../lib/ytdlp.js";
import { SearchTracksBody } from "@workspace/api-zod";
import { getCachedStreamUrl, setCachedStreamUrl } from "../lib/stream-cache.js";
import {
  cancelDownloadJob,
  enqueueDownload,
  getDownloadJobStatus,
  listSessionDownloadJobs,
} from "../lib/background-queue.js";
import { db } from "@workspace/db";
import { playHistoryTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  TfSearchUnavailableError,
  type TfSearchGateway,
} from "../lib/tf-search-client.js";
import type {
  TfSearchResult,
  TfSearchSource,
} from "@workspace/tf-search-contract";
import {
  DOWNLOAD_MAX_FILE_BYTES,
  downloadQualitySchema,
  parseAllowedDownloadSourceUrl,
} from "@workspace/tf-download-contract";
import {
  TfDownloadWorkerError,
  type TfDownloadWorkerGateway,
} from "../lib/tf-download-worker-client.js";

interface RecentTrack {
  readonly trackId: string;
  readonly artist: string | null;
  readonly title: string | null;
}

interface RecordPlayInput {
  readonly accountId: string;
  readonly trackId: string;
  readonly artist: string | null;
  readonly title: string | null;
}

export interface TrackRouteDependencies {
  readonly searchGateway: TfSearchGateway;
  readonly loadRecentTracks: (
    accountId: string,
    limit: number,
  ) => Promise<readonly RecentTrack[]>;
  readonly recordPlay: (input: RecordPlayInput) => Promise<void>;
  readonly loadTopArtists: (
    accountId: string,
  ) => Promise<readonly (string | null)[]>;
  readonly enqueueDownload: typeof enqueueDownload;
  readonly listDownloadJobs: typeof listSessionDownloadJobs;
  readonly getDownloadJobStatus: typeof getDownloadJobStatus;
  readonly cancelDownloadJob: typeof cancelDownloadJob;
  readonly downloadWorkerGateway: TfDownloadWorkerGateway;
}

const ALL_SEARCH_SOURCES: readonly TfSearchSource[] = ["yt", "sc", "bc", "dz"];
const downloadQueueRequestSchema = z
  .object({
    tracks: z
      .array(
        z
          .object({
            trackId: z.string().trim().min(1).max(4_096),
            artist: z.string().trim().min(1).max(300),
            title: z.string().trim().min(1).max(500),
            quality: downloadQualitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const CANONICAL_JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function unavailableGateway(): TfSearchGateway {
  const unavailable = async (): Promise<never> => {
    throw new TfSearchUnavailableError();
  };
  return {
    search: unavailable,
    discoverArtist: unavailable,
    suggestions: unavailable,
  };
}

function unavailableDownloadWorkerGateway(): TfDownloadWorkerGateway {
  return {
    async openFile(): Promise<never> {
      throw new TfDownloadWorkerError(503);
    },
  };
}

function publicSearchResult({
  sourceUrl: _sourceUrl,
  ...result
}: TfSearchResult): Omit<TfSearchResult, "sourceUrl"> {
  return result;
}

function preferredSourceUrl(
  results: readonly TfSearchResult[],
  sources: readonly TfSearchResult["source"][],
): string | null {
  for (const source of sources) {
    const match = results.find((result) => result.source === source);
    if (match !== undefined) return match.sourceUrl;
  }
  return null;
}

function trustedFallbackSourceUrl(
  results: readonly TfSearchResult[],
): string | null {
  const allowedHosts = {
    youtube: "youtube.com",
    soundcloud: "soundcloud.com",
  } as const;
  for (const source of ["youtube", "soundcloud"] as const) {
    for (const result of results) {
      if (result.source !== source) continue;
      const parsed = parseAllowedDownloadSourceUrl(result.sourceUrl);
      const allowedHost = allowedHosts[source];
      if (
        parsed !== null &&
        parsed.href === result.sourceUrl &&
        (parsed.hostname === allowedHost ||
          parsed.hostname.endsWith(`.${allowedHost}`))
      ) {
        return result.sourceUrl;
      }
    }
  }
  return null;
}

function hasTfSearchAccess(entitlements: readonly string[]): boolean {
  return entitlements.includes("tf.search");
}

function hasLegacyInvalidSearchOptions(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  const maxResults = candidate["maxResults"];
  if (typeof maxResults === "number" && !Number.isSafeInteger(maxResults)) {
    return true;
  }
  const sources = candidate["sources"];
  return (
    Array.isArray(sources) &&
    sources.every(
      (source) =>
        typeof source === "string" &&
        ALL_SEARCH_SOURCES.includes(source as TfSearchSource),
    ) &&
    new Set(sources).size !== sources.length
  );
}

const ALLOWED_HOSTS: Record<string, string[]> = {
  yt: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
  sc: [
    "soundcloud.com",
    "www.soundcloud.com",
    "api.soundcloud.com",
    "api-v2.soundcloud.com",
  ],
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
    const isAllowed = allowed.some(
      (h) => hostname === h || hostname.endsWith(`.${h}`),
    );
    if (!isAllowed) return null;
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return { source, url };
}

const defaultTrackRouteDependencies: TrackRouteDependencies = {
  searchGateway: unavailableGateway(),
  async loadRecentTracks(accountId, limit) {
    const result = await db.execute(sql`
      SELECT t.track_id, t.artist, t.title
      FROM (
        SELECT DISTINCT ON (track_id)
          track_id, artist, title, played_at
        FROM play_history
        WHERE session_id = ${accountId}
        ORDER BY track_id, played_at DESC
      ) t
      ORDER BY t.played_at DESC
      LIMIT ${limit}
    `);
    const rows = (result.rows ?? result) as {
      track_id: string;
      artist: string | null;
      title: string | null;
    }[];
    return rows.map((row) => ({
      trackId: row.track_id,
      artist: row.artist,
      title: row.title,
    }));
  },
  async recordPlay(input) {
    await db.insert(playHistoryTable).values({
      sessionId: input.accountId,
      trackId: input.trackId,
      artist: input.artist,
      title: input.title,
    });
  },
  async loadTopArtists(accountId) {
    const rows = await db
      .select({
        artist: playHistoryTable.artist,
        count: sql<number>`count(*)::int`,
      })
      .from(playHistoryTable)
      .where(eq(playHistoryTable.sessionId, accountId))
      .groupBy(playHistoryTable.artist)
      .orderBy(sql`count(*) desc`)
      .limit(10);
    return rows.map((row) => row.artist);
  },
  enqueueDownload,
  listDownloadJobs: listSessionDownloadJobs,
  getDownloadJobStatus,
  cancelDownloadJob,
  downloadWorkerGateway: unavailableDownloadWorkerGateway(),
};

export function createTracksRouter(
  dependencies: Partial<TrackRouteDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const routeDependencies: TrackRouteDependencies = {
    ...defaultTrackRouteDependencies,
    ...dependencies,
  };

  router.post("/tracks/search", async (req, res) => {
    const parseResult = SearchTracksBody.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "bad_request",
        message: hasLegacyInvalidSearchOptions(req.body)
          ? "invalid search options"
          : "artist and title are required",
      });
      return;
    }

    const { artist, title, mode, sources } = parseResult.data;
    const maxResults = parseResult.data.maxResults ?? 20;
    const enabledSources: TfSearchSource[] =
      mode === "manual" && sources && sources.length > 0
        ? sources
        : [...ALL_SEARCH_SOURCES];

    try {
      const response = await routeDependencies.searchGateway.search({
        artist,
        title,
        mode: mode ?? "auto",
        sources: enabledSources,
        maxResults,
      });
      res.json({
        query: response.query,
        results: response.results.map(publicSearchResult),
        cached: response.cached,
        sources: response.sources,
        fallbackAvailable: response.fallbackAvailable,
      });
    } catch {
      res.status(503).json({ error: "search_unavailable" });
    }
  });

  router.post("/tracks/batch-search", async (req, res) => {
    const { tracks } = req.body as {
      tracks?: { artist: string; title: string }[];
    };

    if (!Array.isArray(tracks) || tracks.length === 0) {
      res
        .status(400)
        .json({ error: "bad_request", message: "tracks array is required" });
      return;
    }

    if (tracks.length > 100) {
      res
        .status(400)
        .json({ error: "too_many", message: "Maximum 100 tracks per batch" });
      return;
    }

    const CONCURRENCY = 8;

    async function searchOne(
      artist: string,
      title: string,
    ): Promise<{ matches: Record<string, unknown>[]; cached: boolean }> {
      const response = await routeDependencies.searchGateway.search({
        artist,
        title,
        mode: "auto",
        sources: [...ALL_SEARCH_SOURCES],
        maxResults: 20,
      });
      return {
        matches: response.results.map(publicSearchResult),
        cached: response.cached,
      };
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
            const bestScore =
              typeof matches[0]?.score === "number" ? matches[0].score : 0;
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
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid track id format" });
      return;
    }

    try {
      const cached = await getCachedStreamUrl(id);
      if (cached) {
        res.json({
          id,
          streamUrl: cached.url,
          mimeType: cached.mimeType,
          cached: true,
        });
        return;
      }

      if (decoded.source === "dz") {
        const dzArtist = String(req.query["artist"] ?? "").trim();
        const dzTitle = String(req.query["title"] ?? "").trim();

        if (dzArtist && dzTitle) {
          try {
            if (!hasTfSearchAccess(req.tfPrincipal!.entitlements)) {
              res.status(403).json({ error: "module_access_denied" });
              return;
            }
            const candidates = await routeDependencies.searchGateway.search({
              artist: dzArtist,
              title: dzTitle,
              mode: "manual",
              sources: ["yt"],
              maxResults: 3,
            });
            const sourceUrl = preferredSourceUrl(candidates.results, [
              "youtube",
            ]);
            if (sourceUrl !== null) {
              const { url, mimeType } = await getStreamUrl(sourceUrl);
              await setCachedStreamUrl(id, url, mimeType ?? "audio/mpeg");
              res.json({
                id,
                streamUrl: url,
                mimeType: mimeType ?? "audio/mpeg",
              });
              return;
            }
          } catch {
            req.log?.warn("Deezer stream fallback unavailable; using preview");
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
      res.status(500).json({
        error: "stream_error",
        message: "Could not resolve stream URL",
      });
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
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid track id format" });
      return;
    }

    const rawQuality = String(req.query["quality"] ?? "256");
    const quality: AudioQuality = (
      ["128", "192", "256", "320", "flac"] as const
    ).includes(rawQuality as AudioQuality)
      ? (rawQuality as AudioQuality)
      : "256";
    const ext = quality === "flac" ? "flac" : "mp3";
    const mimeType = quality === "flac" ? "audio/flac" : "audio/mpeg";

    try {
      const filename = `track_${id.slice(0, 16)}.${ext}`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      if (decoded.source === "dz") {
        const dzArtist = String(req.query["artist"] ?? "").trim();
        const dzTitle = String(req.query["title"] ?? "").trim();
        const query = `${dzArtist} ${dzTitle}`.trim();

        const pipeFallback = (sourceUrl: string, label: string) => {
          req.log?.info(
            { id, artist: dzArtist, title: dzTitle },
            `Deezer→${label} download fallback`,
          );
          res.setHeader("Content-Type", mimeType);
          const proc = spawnAudioDownload(sourceUrl, quality);
          proc.stdout.pipe(res);
          proc.stderr.on("data", () => {});
          req.on("close", () => proc.kill("SIGKILL"));
          proc.on("close", (code) => {
            if (code !== 0 && !res.writableEnded) res.destroy();
          });
          proc.on("error", (err) => {
            req.log.error(
              { err },
              `yt-dlp error during deezer ${label} fallback`,
            );
            if (!res.headersSent)
              res.status(500).json({ error: "download_error" });
            else res.destroy();
          });
        };

        if (query) {
          try {
            if (!hasTfSearchAccess(req.tfPrincipal!.entitlements)) {
              res.status(403).json({ error: "module_access_denied" });
              return;
            }
            const candidates = await routeDependencies.searchGateway.search({
              artist: dzArtist,
              title: dzTitle,
              mode: "manual",
              sources: ["yt", "sc"],
              maxResults: 6,
            });
            const sourceUrl = preferredSourceUrl(candidates.results, [
              "youtube",
              "soundcloud",
            ]);
            if (sourceUrl !== null) {
              const source = candidates.results.find(
                (candidate) => candidate.sourceUrl === sourceUrl,
              )?.source;
              pipeFallback(
                sourceUrl,
                source === "soundcloud" ? "SoundCloud" : "YouTube",
              );
              return;
            }
          } catch {
            req.log?.warn("Deezer download fallback unavailable");
          }
        }

        // All fallbacks exhausted — return a clear error so the mobile doesn't
        // save a 0-byte or expired-CDN file as a valid download.
        res.status(502).json({
          error: "download_error",
          message: "Could not find a downloadable source for this track",
        });
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
          res.status(500).json({
            error: "download_error",
            message: "Failed to start downloader",
          });
        } else {
          res.destroy();
        }
      });
    } catch (err) {
      req.log.error({ err, id }, "Failed to start audio download");
      if (!res.headersSent) {
        res.status(500).json({
          error: "download_error",
          message: "Could not resolve download URL",
        });
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
      res
        .status(400)
        .json({ error: "bad_request", message: "Invalid track id format" });
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
      proc.on("close", (code) => {
        if (code !== 0 && !res.writableEnded) res.destroy();
      });
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
          try {
            if (!hasTfSearchAccess(req.tfPrincipal!.entitlements)) {
              res.status(403).json({ error: "module_access_denied" });
              return;
            }
            const candidates = await routeDependencies.searchGateway.search({
              artist: dzArtist,
              title: dzTitle,
              mode: "manual",
              sources: ["yt", "sc"],
              maxResults: 6,
            });
            const sourceUrl = preferredSourceUrl(candidates.results, [
              "youtube",
              "soundcloud",
            ]);
            if (sourceUrl !== null) {
              req.log?.info(
                { id, artist: dzArtist, title: dzTitle },
                "Deezer audio-stream fallback",
              );
              pipeProc(sourceUrl);
              return;
            }
          } catch {
            req.log?.warn("Deezer audio-stream fallback unavailable");
          }
        }

        res.status(502).json({
          error: "stream_error",
          message: "Could not find a streamable source for this track",
        });
        return;
      }

      pipeProc(decoded.url);
    } catch (err) {
      req.log.error({ err, id }, "Failed to start audio stream");
      if (!res.headersSent) {
        res.status(500).json({
          error: "stream_error",
          message: "Could not start audio stream",
        });
      }
    }
  });

  async function fetchLrclib(
    artist: string,
    title: string,
    duration: number,
  ): Promise<{
    plainLyrics: string | null;
    syncedLyrics: string | null;
  } | null> {
    try {
      const params = new URLSearchParams({
        artist_name: artist,
        track_name: title,
      });
      if (duration > 0) params.set("duration", String(Math.round(duration)));
      const r = await fetch(`https://lrclib.net/api/get?${params}`, {
        headers: { "Lrclib-Client": "Apollo TrackFinder/1.0" },
        signal: AbortSignal.timeout(7000),
      });
      if (r.status === 404) return { plainLyrics: null, syncedLyrics: null };
      if (!r.ok) return null;
      const d = (await r.json()) as {
        plainLyrics?: string | null;
        syncedLyrics?: string | null;
      };
      const plain = d.plainLyrics?.trim() ?? null;
      const synced = d.syncedLyrics?.trim() ?? null;
      if (!plain && !synced) return null;
      return { plainLyrics: plain, syncedLyrics: synced };
    } catch {
      return null;
    }
  }

  async function fetchLrcLibSearch(
    artist: string,
    title: string,
  ): Promise<{
    plainLyrics: string | null;
    syncedLyrics: string | null;
  } | null> {
    try {
      const params = new URLSearchParams({
        artist_name: artist,
        track_name: title,
        limit: "3",
      });
      const r = await fetch(`https://lrclib.net/api/search?${params}`, {
        headers: { "Lrclib-Client": "Apollo TrackFinder/1.0" },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) return null;
      const results = (await r.json()) as Array<{
        plainLyrics?: string | null;
        syncedLyrics?: string | null;
      }>;
      for (const item of results) {
        const plain = item.plainLyrics?.trim() ?? null;
        const synced = item.syncedLyrics?.trim() ?? null;
        if (plain || synced)
          return { plainLyrics: plain, syncedLyrics: synced };
      }
      return null;
    } catch {
      return null;
    }
  }

  async function fetchLyricsOvh(
    artist: string,
    title: string,
  ): Promise<{ plainLyrics: string | null; syncedLyrics: null } | null> {
    try {
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const d = (await r.json()) as { lyrics?: string; error?: string };
      if (d.error || !d.lyrics?.trim()) return null;
      return { plainLyrics: d.lyrics.trim(), syncedLyrics: null };
    } catch {
      return null;
    }
  }

  router.get("/tracks/recent", async (req, res) => {
    const rawLimit = Number(req.query["limit"] ?? 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 50)
        : 10;

    try {
      const resultRows = await routeDependencies.loadRecentTracks(
        req.tfPrincipal!.accountId,
        limit,
      );

      res.json({
        results: resultRows.map((r) => ({
          id: r.trackId,
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
    const { trackId, artist, title } = req.body as Record<string, unknown>;

    if (!trackId || typeof trackId !== "string") {
      res
        .status(400)
        .json({ error: "bad_request", message: "trackId is required" });
      return;
    }

    try {
      await routeDependencies.recordPlay({
        accountId: req.tfPrincipal!.accountId,
        trackId: String(trackId),
        artist: typeof artist === "string" ? artist : null,
        title: typeof title === "string" ? title : null,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      req.log.warn({ err }, "Failed to record play history");
      res
        .status(500)
        .json({ error: "db_error", message: "Could not record play" });
    }
  });

  router.get("/tracks/recommendations", async (req, res) => {
    try {
      const artists = (
        await routeDependencies.loadTopArtists(req.tfPrincipal!.accountId)
      ).filter((artist): artist is string => !!artist);

      if (artists.length === 0) {
        res.json({ results: [] });
        return;
      }
      if (!hasTfSearchAccess(req.tfPrincipal!.entitlements)) {
        res.status(403).json({ error: "module_access_denied" });
        return;
      }

      const discoveryPromises = artists.map((artist) =>
        routeDependencies.searchGateway
          .discoverArtist({
            artist,
            sources: ["yt", "sc"],
            limitPerSource: 6,
          })
          .then((response) => response.results),
      );

      const settled = await Promise.allSettled(discoveryPromises);
      const allResults = settled.flatMap((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : [],
      );

      const seen = new Set<string>();
      const deduped = allResults.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });

      const limited = deduped.slice(0, 20).map(publicSearchResult);

      res.json({ results: limited });
    } catch {
      req.log?.warn("Failed to generate recommendations");
      res.json({ results: [] });
    }
  });

  router.get("/tracks/suggest", async (req, res) => {
    const q = String(req.query["q"] ?? "")
      .trim()
      .toLowerCase();
    if (!q || q.length < 2) {
      res.json({ suggestions: [] });
      return;
    }

    try {
      const response = await routeDependencies.searchGateway.suggestions(q, 5);
      res.json({ suggestions: response.suggestions });
    } catch {
      res.status(503).json({ error: "search_unavailable" });
    }
  });

  router.get("/tracks/lyrics", async (req, res) => {
    const artist = String(req.query["artist"] ?? "").trim();
    const title = String(req.query["title"] ?? "").trim();
    const duration = Number(req.query["duration"] ?? 0);

    if (!artist || !title) {
      res.status(400).json({
        error: "bad_request",
        message: "artist and title are required",
      });
      return;
    }

    try {
      const lrclibExact = await fetchLrclib(artist, title, duration);
      if (
        lrclibExact &&
        (lrclibExact.plainLyrics || lrclibExact.syncedLyrics)
      ) {
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

  router.post("/tracks/download/queue", async (req, res) => {
    const parsedBody = downloadQueueRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }

    const resolved = [] as Array<{
      readonly trackId: string;
      readonly artist: string;
      readonly title: string;
      readonly quality: AudioQuality;
      readonly sourceUrl: string;
    }>;
    for (const track of parsedBody.data.tracks) {
      const decoded = decodeTrackUrl(track.trackId);
      if (decoded === null) {
        res.status(400).json({ error: "bad_request" });
        return;
      }

      let sourceUrl = decoded.url;
      if (decoded.source === "dz") {
        if (!hasTfSearchAccess(req.tfPrincipal!.entitlements)) {
          res.status(403).json({ error: "module_access_denied" });
          return;
        }
        try {
          const fallback = await routeDependencies.searchGateway.search({
            artist: track.artist,
            title: track.title,
            mode: "manual",
            sources: ["yt", "sc"],
            maxResults: 6,
          });
          sourceUrl = trustedFallbackSourceUrl(fallback.results) ?? "";
        } catch {
          res.status(503).json({ error: "download_queue_unavailable" });
          return;
        }
        if (sourceUrl === "") {
          res.status(400).json({ error: "bad_request" });
          return;
        }
      }
      resolved.push({ ...track, sourceUrl });
    }

    const outcomes = await Promise.allSettled(
      resolved.map(async (track) => {
        const { jobId, position } = await routeDependencies.enqueueDownload({
          ...track,
          schemaVersion: 1,
          accountId: req.tfPrincipal!.accountId,
          createdAt: new Date().toISOString(),
        });
        return { trackId: track.trackId, jobId, position };
      }),
    );
    if (outcomes.every((outcome) => outcome.status === "rejected")) {
      res.status(503).json({ error: "download_queue_unavailable" });
      return;
    }
    res.json({
      results: outcomes.map((outcome, index) =>
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              trackId: resolved[index]!.trackId,
              error: "download_queue_unavailable",
            },
      ),
    });
  });

  router.get("/tracks/download/jobs", async (req, res) => {
    try {
      const jobs = await routeDependencies.listDownloadJobs(
        req.tfPrincipal!.accountId,
      );
      res.json({ jobs });
    } catch {
      res.status(503).json({ error: "download_queue_unavailable" });
    }
  });

  router.get("/tracks/download/status/:jobId", async (req, res) => {
    const { jobId } = req.params as { jobId: string };
    if (!CANONICAL_JOB_ID.test(jobId)) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    try {
      const status = await routeDependencies.getDownloadJobStatus(
        jobId,
        req.tfPrincipal!.accountId,
      );
      if (status.status === "unknown") {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      res.json(status);
    } catch {
      res.status(503).json({ error: "download_queue_unavailable" });
    }
  });

  router.delete("/tracks/download/jobs/:jobId", async (req, res) => {
    const { jobId } = req.params as { jobId: string };
    if (!CANONICAL_JOB_ID.test(jobId)) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    try {
      const result = await routeDependencies.cancelDownloadJob(
        jobId,
        req.tfPrincipal!.accountId,
      );
      if (result.status === "unknown") {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      res.json({ jobId, status: result.status });
    } catch {
      res.status(503).json({ error: "download_queue_unavailable" });
    }
  });

  router.get("/tracks/download/file/:jobId", async (req, res) => {
    const { jobId } = req.params as { jobId: string };
    if (!CANONICAL_JOB_ID.test(jobId)) {
      res.status(404).json({ error: "file_not_found" });
      return;
    }
    const rangeHeader = req.get("range");
    let range: { start: number; end?: number } | undefined;
    if (rangeHeader !== undefined) {
      const match = /^bytes=(0|[1-9]\d*)-(?:(0|[1-9]\d*))?$/.exec(rangeHeader);
      const start = match === null ? NaN : Number(match[1]);
      const end = match?.[2] === undefined ? undefined : Number(match[2]);
      if (
        match === null ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start >= DOWNLOAD_MAX_FILE_BYTES ||
        (end !== undefined &&
          (!Number.isSafeInteger(end) ||
            end < start ||
            end >= DOWNLOAD_MAX_FILE_BYTES))
      ) {
        res.status(416).json({ error: "range_not_satisfiable" });
        return;
      }
      range = end === undefined ? { start } : { start, end };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const abortOnClose = (): void => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", abortOnClose);
    if (req.aborted) abort();
    try {
      const file = await routeDependencies.downloadWorkerGateway.openFile({
        accountId: req.tfPrincipal!.accountId,
        jobId,
        ...(range === undefined ? {} : { range }),
        signal: controller.signal,
      });
      res.status(file.status);
      res.setHeader("content-type", file.contentType);
      res.setHeader("content-length", String(file.contentLength));
      res.setHeader("content-disposition", file.contentDisposition);
      res.setHeader("accept-ranges", "bytes");
      res.setHeader("cache-control", "private, no-store");
      if (file.contentRange !== undefined) {
        res.setHeader("content-range", file.contentRange);
      }
      const downstream = Readable.fromWeb(
        file.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      await pipeline(downstream, res, { signal: controller.signal });
    } catch (error) {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
      }
      const workerError =
        error instanceof TfDownloadWorkerError
          ? error
          : new TfDownloadWorkerError(503);
      res.status(workerError.status).json({ error: workerError.code });
    } finally {
      req.off("aborted", abort);
      res.off("close", abortOnClose);
    }
  });

  return router;
}

export default createTracksRouter();
