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

function similarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, "");

  if (na === nb) return 1;
  if (nb.length === 0) return 0;

  const wordsA = new Set(na.split(/\s+/).filter(Boolean));
  const wordsB = new Set(nb.split(/\s+/).filter(Boolean));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;

  return union === 0 ? 0 : intersection / union;
}

function computeWithinTierScore<T extends RankableTrack>(
  track: T,
  query: { artist: string; title: string },
  referenceDuration?: number,
): number {
  const trackFull = `${track.artist} ${track.title}`;
  const expectedQuery = `${query.artist} ${query.title}`.toLowerCase();

  const titleSim = similarity(track.title, query.title);
  const fullSim = similarity(trackFull, expectedQuery);
  const artistSim = similarity(track.artist, query.artist);
  const nameSimilarity = titleSim * 0.5 + fullSim * 0.3 + artistSim * 0.2;

  let durationScore = 0;
  if (referenceDuration && track.duration > 0) {
    const diff = Math.abs(track.duration - referenceDuration);
    durationScore = Math.max(0, 1 - diff / 120);
  }

  const popularityScore = track.viewCount
    ? Math.min(1, Math.log10(track.viewCount + 1) / 8)
    : 0;

  return nameSimilarity * 70 + durationScore * 15 + popularityScore * 15;
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
