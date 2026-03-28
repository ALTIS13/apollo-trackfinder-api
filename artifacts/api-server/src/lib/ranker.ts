import type { TrackType } from "./classifier.js";

export interface RankableTrack {
  title: string;
  artist: string;
  duration: number;
  type: TrackType;
  viewCount?: number | null;
  score?: number;
}

const TYPE_TIER: Record<TrackType, number> = {
  original: 0,
  remix: 1,
  live: 2,
  cover: 3,
};

function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(str: string): string[] {
  return normalize(str).split(" ").filter(Boolean);
}

function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

function containsQuery(text: string, query: string): boolean {
  const n = normalize(text);
  const q = normalize(query);
  return n.includes(q);
}

function titleSimilarity(trackTitle: string, queryTitle: string): number {
  const jaccard = jaccardSimilarity(trackTitle, queryTitle);
  const exact = containsQuery(trackTitle, queryTitle) ? 0.2 : 0;
  return Math.min(1, jaccard + exact);
}

function computeWithinTierScore<T extends RankableTrack>(
  track: T,
  query: { artist: string; title: string },
  referenceDuration?: number,
): number {
  const trackFull = `${track.artist} ${track.title}`;
  const expectedQuery = `${query.artist} ${query.title}`;

  const titleSim = titleSimilarity(track.title, query.title);
  const fullSim = jaccardSimilarity(trackFull, expectedQuery);
  const artistSim = jaccardSimilarity(track.artist, query.artist);
  const artistContains = containsQuery(track.artist, query.artist) || containsQuery(query.artist, track.artist)
    ? 0.15
    : 0;

  const nameSimilarity = Math.min(1, titleSim * 0.45 + fullSim * 0.25 + artistSim * 0.15 + artistContains);

  let durationScore = 0;
  if (referenceDuration && track.duration > 0) {
    const diff = Math.abs(track.duration - referenceDuration);
    durationScore = Math.max(0, 1 - diff / 90);
  }

  const popularityScore = track.viewCount
    ? Math.min(1, Math.log10(track.viewCount + 1) / 8)
    : 0;

  return nameSimilarity * 70 + durationScore * 20 + popularityScore * 10;
}

export function rank<T extends RankableTrack>(
  tracks: T[],
  query: { artist: string; title: string },
  referenceDuration?: number,
): T[] {
  const scored = tracks.map((track) => {
    const withinTierScore = computeWithinTierScore(track, query, referenceDuration);
    const score = Math.round(withinTierScore * 100) / 100;
    return { ...track, score } as T;
  });

  return scored.sort((a, b) => {
    const tierA = TYPE_TIER[a.type];
    const tierB = TYPE_TIER[b.type];
    if (tierA !== tierB) return tierA - tierB;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}
