import { classify } from "../classifier.js";
import type { InternalTrack } from "../search-service.js";
import { ytdlpSearch, type YtDlpEntry } from "../ytdlp-search.js";

function encodeTrackId(url: string): string {
  return `yt_${Buffer.from(url).toString("base64url")}`;
}

function extractQuality(entry: YtDlpEntry): string[] {
  const bitrates = entry.formats
    ?.filter((format) => format.vcodec === "none" && format.abr != null && format.abr > 0)
    .map((format) => String(Math.round(format.abr!)));
  const quality = [...new Set(bitrates ?? [])].sort((left, right) => Number(left) - Number(right));
  return quality.length > 0 ? quality : ["128", "320"];
}

export async function searchYouTube(query: string, maxResults = 10): Promise<readonly InternalTrack[]> {
  const entries = await ytdlpSearch(query, maxResults);
  return entries
    .filter((entry) => entry.id && entry.title)
    .map((entry) => {
      const sourceUrl = entry.webpage_url ?? `https://www.youtube.com/watch?v=${entry.id}`;
      return {
        id: encodeTrackId(sourceUrl),
        title: entry.title,
        artist: entry.uploader ?? "Unknown",
        type: classify(entry.title),
        duration: Math.round(entry.duration ?? 0),
        source: "youtube" as const,
        thumbnailUrl: entry.thumbnail ?? null,
        quality: extractQuality(entry),
        viewCount: entry.view_count ?? null,
        score: 0,
        sourceUrl,
      };
    });
}
