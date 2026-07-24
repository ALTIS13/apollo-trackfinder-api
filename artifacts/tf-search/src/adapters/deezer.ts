import { classify } from "../classifier.js";
import type { InternalTrack } from "../search-service.js";

interface DeezerTrack {
  readonly id: number;
  readonly title: string;
  readonly duration: number;
  readonly preview: string;
  readonly artist: { readonly name: string };
  readonly album: { readonly cover_medium?: string };
  readonly rank?: number;
}

function encodeTrackId(url: string): string {
  return `dz_${Buffer.from(url).toString("base64url")}`;
}

export async function searchDeezer(query: string, maxResults = 10): Promise<readonly InternalTrack[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(Math.min(maxResults, 25)),
    output: "json",
  });
  const response = await fetch(`https://api.deezer.com/search?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("deezer_search_failed");

  const body = await response.json() as { readonly data?: readonly DeezerTrack[] };
  return (body.data ?? [])
    .filter((entry) => entry.preview && entry.title && entry.artist?.name)
    .map((entry) => ({
      id: encodeTrackId(entry.preview),
      title: entry.title,
      artist: entry.artist.name,
      type: classify(entry.title),
      duration: entry.duration,
      source: "deezer" as const,
      thumbnailUrl: entry.album?.cover_medium ?? null,
      quality: ["128"],
      viewCount: entry.rank ?? null,
      score: 0,
      sourceUrl: entry.preview,
    }));
}
