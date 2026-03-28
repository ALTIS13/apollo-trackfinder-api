import { bcdlpSearch, type YtDlpEntry } from "../lib/ytdlp.js";
import { classify } from "../lib/classifier.js";
import type { TrackType } from "../lib/classifier.js";

export interface NormalizedTrack {
  id: string;
  title: string;
  artist: string;
  type: TrackType;
  duration: number;
  source: "bandcamp";
  thumbnailUrl: string | null;
  quality: string[];
  viewCount: number | null;
  score: number;
  _sourceUrl: string;
}

function encodeTrackId(url: string): string {
  return `bc_${Buffer.from(url).toString("base64url")}`;
}

function extractQuality(entry: YtDlpEntry): string[] {
  if (!entry.formats) return ["128", "320"];
  const audioBitrates = entry.formats
    .filter((f) => f.vcodec === "none" && f.abr != null && f.abr > 0)
    .map((f) => String(Math.round(f.abr!)));
  const unique = [...new Set(audioBitrates)].sort((a, b) => Number(a) - Number(b));
  return unique.length > 0 ? unique : ["128", "320"];
}

export async function searchBandcamp(
  query: string,
  maxResults = 10,
): Promise<NormalizedTrack[]> {
  let entries: YtDlpEntry[] = [];
  try {
    entries = await bcdlpSearch(query, maxResults);
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.id && e.title)
    .map((e) => {
      const url = e.webpage_url ?? "";
      if (!url) return null;
      return {
        id: encodeTrackId(url),
        title: e.title ?? "",
        artist: e.uploader ?? "Unknown",
        type: classify(e.title ?? "") as TrackType,
        duration: Math.round(e.duration ?? 0),
        source: "bandcamp" as const,
        thumbnailUrl: e.thumbnail ?? null,
        quality: extractQuality(e),
        viewCount: null,
        score: 0,
        _sourceUrl: url,
      };
    })
    .filter((t): t is NormalizedTrack => t !== null);
}
