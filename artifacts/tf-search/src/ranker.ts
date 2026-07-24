import type { TrackType } from "./classifier.js";

export interface RankableTrack {
  readonly title: string;
  readonly artist: string;
  readonly duration: number;
  readonly type: TrackType;
  readonly viewCount?: number | null;
  readonly score?: number;
}

const TYPE_TIER: Record<TrackType, number> = {
  original: 0,
  remix: 1,
  live: 2,
  cover: 3,
};

const SOURCE_WEIGHT: Record<string, number> = {
  youtube: 1.0,
  soundcloud: 1.1,
  bandcamp: 1.2,
  deezer: 1.3,
};

export interface SmartBoosts {
  readonly mode?: "auto" | "manual";
  readonly queryText?: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function containsQuery(text: string, query: string): boolean {
  return normalize(text).includes(normalize(query));
}

function stripMetadata(title: string): string {
  return title
    .replace(/[\(\[]\s*(official\s*(music\s*)?video|official\s*(audio|mv|clip)|official|lyric\s*video|lyrics?\s*video|audio|music\s*video|mv|visualizer|animated\s*video|performance\s*video|hd|4k)\s*[\)\]]/gi, "")
    .replace(/[\(\[]\s*(\d{4}\s*)?(re)?master(ed)?(\s*\d{4})?\s*[\)\]]/gi, "")
    .replace(/[\(\[]\s*(explicit|clean)\s*[\)\]]/gi, "")
    .replace(/\bfeat(?:uring)?\b\.?|\bft\.\b/gi, "feat")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(trackTitle: string, queryTitle: string): number {
  const raw = jaccardSimilarity(trackTitle, queryTitle);
  const stripped = jaccardSimilarity(stripMetadata(trackTitle), stripMetadata(queryTitle));
  const containsBonus = containsQuery(stripMetadata(trackTitle), stripMetadata(queryTitle)) ? 0.15 : 0;
  return Math.min(1, Math.max(raw, stripped) + containsBonus);
}

function artistSimilarity(trackArtist: string, queryArtist: string): number {
  const raw = jaccardSimilarity(trackArtist, queryArtist);
  const containsBonus = containsQuery(trackArtist, queryArtist) || containsQuery(queryArtist, trackArtist)
    ? 0.15
    : 0;
  return Math.min(1, raw + containsBonus);
}

function scoreTrack<T extends RankableTrack>(
  track: T,
  query: { readonly artist: string; readonly title: string },
  referenceDuration?: number,
): number {
  const titleScore = titleSimilarity(track.title, query.title);
  const artistScore = artistSimilarity(track.artist, query.artist);
  const fullScore = jaccardSimilarity(`${track.artist} ${track.title}`, `${query.artist} ${query.title}`);
  const nameScore = Math.min(1, titleScore * 0.5 + artistScore * 0.25 + fullScore * 0.25);
  const durationScore = referenceDuration && track.duration > 0
    ? Math.max(0, 1 - Math.abs(track.duration - referenceDuration) / 90)
    : 0;
  const popularityScore = track.viewCount ? Math.min(1, Math.log10(track.viewCount + 1) / 8) : 0;
  return nameScore * 70 + durationScore * 20 + popularityScore * 10;
}

function smartBoosts(queryText: string): Record<string, number> {
  const query = queryText.toLowerCase();
  const boosts: Record<string, number> = {};
  if (query.includes("remix") || query.includes("ремикс")) boosts.soundcloud = 1.2;
  if (query.includes("live") || query.includes("живое") || query.includes("концерт")) boosts.youtube = 1.1;
  if (query.includes("album") || query.includes("альбом")) boosts.deezer = 1.3;
  if (query.includes("indie") || query.includes("инди")) boosts.bandcamp = 1.2;
  return boosts;
}

export function rank<T extends RankableTrack>(
  tracks: readonly T[],
  query: { readonly artist: string; readonly title: string },
  referenceDuration?: number,
  smart?: SmartBoosts,
): T[] {
  const boosts = smart?.mode === "auto" && smart.queryText ? smartBoosts(smart.queryText) : {};
  const scored = tracks.map((track) => {
    const source = (track as T & { readonly source?: string }).source ?? "";
    let score = Math.round(scoreTrack(track, query, referenceDuration) * 100) / 100;
    score *= SOURCE_WEIGHT[source] ?? 1;
    score *= boosts[source] ?? 1;
    score = Math.round(score * 100) / 100;
    return { ...track, score } as T;
  });

  return scored.sort((left, right) => {
    const tierDifference = TYPE_TIER[left.type] - TYPE_TIER[right.type];
    return tierDifference === 0 ? (right.score ?? 0) - (left.score ?? 0) : tierDifference;
  });
}

export function simplifyQuery(artist: string, title: string): string {
  const normalizedArtist = stripMetadata(artist).replace(/\s*feat.*/i, "").trim();
  const normalizedTitle = stripMetadata(title).replace(/\s*feat.*/i, "").trim();
  return `${normalizedArtist} ${normalizedTitle}`.trim();
}
