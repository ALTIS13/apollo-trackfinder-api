import { classify } from "../classifier.js";
import type { InternalTrack } from "../search-service.js";
import { bcdlpSearch, type YtDlpEntry } from "../ytdlp-search.js";

function encodeTrackId(url: string): string {
  return `bc_${Buffer.from(url).toString("base64url")}`;
}

function extractQuality(entry: YtDlpEntry): string[] {
  const bitrates = entry.formats
    ?.filter((format) => format.vcodec === "none" && format.abr != null && format.abr > 0)
    .map((format) => String(Math.round(format.abr!)));
  const quality = [...new Set(bitrates ?? [])].sort((left, right) => Number(left) - Number(right));
  return quality.length > 0 ? quality : ["128", "320"];
}

export async function searchBandcamp(query: string, maxResults = 10): Promise<readonly InternalTrack[]> {
  const entries = await bcdlpSearch(query, maxResults);
  return entries.flatMap((entry) => {
    const sourceUrl = entry.webpage_url ?? "";
    if (!entry.id || !entry.title || !sourceUrl) return [];
    return [{
      id: encodeTrackId(sourceUrl),
      title: entry.title,
      artist: entry.uploader ?? "Unknown",
      type: classify(entry.title),
      duration: Math.round(entry.duration ?? 0),
      source: "bandcamp" as const,
      thumbnailUrl: entry.thumbnail ?? null,
      quality: extractQuality(entry),
      viewCount: null,
      score: 0,
      sourceUrl,
    }];
  });
}
