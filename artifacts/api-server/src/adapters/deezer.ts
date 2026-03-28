import { classify } from "../lib/classifier.js";
import type { TrackType } from "../lib/classifier.js";

export interface NormalizedTrack {
  id: string;
  title: string;
  artist: string;
  type: TrackType;
  duration: number;
  source: "deezer";
  thumbnailUrl: string | null;
  quality: string[];
  viewCount: number | null;
  score: number;
  _sourceUrl: string;
}

interface DeezerTrack {
  id: number;
  title: string;
  duration: number;
  preview: string;
  artist: { name: string };
  album: { cover_medium?: string };
  rank?: number;
}

interface DeezerSearchResponse {
  data?: DeezerTrack[];
  error?: { message: string };
}

function encodeTrackId(url: string): string {
  return `dz_${Buffer.from(url).toString("base64url")}`;
}

export async function searchDeezer(
  query: string,
  maxResults = 10,
): Promise<NormalizedTrack[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.min(maxResults, 25)),
      output: "json",
    });

    const response = await fetch(`https://api.deezer.com/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return [];

    const data = await response.json() as DeezerSearchResponse;
    if (!data.data) return [];

    return data.data
      .filter((t) => t.preview && t.title && t.artist?.name)
      .map((t) => ({
        id: encodeTrackId(t.preview),
        title: t.title,
        artist: t.artist.name,
        type: classify(t.title) as TrackType,
        duration: t.duration,
        source: "deezer" as const,
        thumbnailUrl: t.album?.cover_medium ?? null,
        quality: ["128"],
        viewCount: t.rank ?? null,
        score: 0,
        _sourceUrl: t.preview,
      }));
  } catch {
    return [];
  }
}
