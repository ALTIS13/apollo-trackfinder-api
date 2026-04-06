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
  return normalize(text).includes(normalize(query));
}

/**
 * Strip platform-specific noise from titles so cross-platform comparisons work.
 * e.g. "Song (Official Music Video)" → "Song"
 */
function stripMetadata(title: string): string {
  return title
    // Official video / audio / lyric video
    .replace(/[\(\[]\s*(official\s*(music\s*)?video|official\s*(audio|mv|clip)|official|lyric\s*video|lyrics?\s*video|audio|music\s*video|mv|visualizer|animated\s*video|performance\s*video|hd|4k)\s*[\)\]]/gi, "")
    // Remaster tags
    .replace(/[\(\[]\s*(\d{4}\s*)?(re)?master(ed)?(\s*\d{4})?\s*[\)\]]/gi, "")
    // Explicit / clean tags
    .replace(/[\(\[]\s*(explicit|clean)\s*[\)\]]/gi, "")
    // Normalize feat. / ft. / featuring → feat
    .replace(/\bfeat(?:uring)?\b\.?|\bft\.\b/gi, "feat")
    // Collapse whitespace
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
  // Bonus if one contains the other (e.g. "Artist feat. Someone" vs "Artist")
  const containsBonus = (
    containsQuery(trackArtist, queryArtist) ||
    containsQuery(queryArtist, trackArtist)
  ) ? 0.15 : 0;
  return Math.min(1, raw + containsBonus);
}

function computeWithinTierScore<T extends RankableTrack>(
  track: T,
  query: { artist: string; title: string },
  referenceDuration?: number,
): number {
  const trackFull = `${track.artist} ${track.title}`;
  const expectedFull = `${query.artist} ${query.title}`;

  const tSim = titleSimilarity(track.title, query.title);
  const aSim = artistSimilarity(track.artist, query.artist);
  const fullSim = jaccardSimilarity(trackFull, expectedFull);

  // Combined name score: title matters most, then artist, then the full string
  const nameSimilarity = Math.min(1, tSim * 0.50 + aSim * 0.25 + fullSim * 0.25);

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

const SOURCE_WEIGHT: Record<string, number> = {
  youtube: 1.0,
  soundcloud: 1.1,
  bandcamp: 1.2,
  deezer: 1.3,
};

export interface SmartBoosts {
  mode?: "auto" | "manual";
  queryText?: string;
}

function computeSmartBoosts(queryText: string): Record<string, number> {
  const q = queryText.toLowerCase();
  const boosts: Record<string, number> = {};
  if (q.includes("remix") || q.includes("ремикс")) boosts["soundcloud"] = 1.2;
  if (q.includes("live") || q.includes("живое") || q.includes("концерт")) boosts["youtube"] = 1.1;
  if (q.includes("album") || q.includes("альбом")) boosts["deezer"] = 1.3;
  if (q.includes("indie") || q.includes("инди")) boosts["bandcamp"] = 1.2;
  return boosts;
}

export function rank<T extends RankableTrack>(
  tracks: T[],
  query: { artist: string; title: string },
  referenceDuration?: number,
  smart?: SmartBoosts,
): T[] {
  const smartBoosts = smart?.mode === "auto" && smart.queryText
    ? computeSmartBoosts(smart.queryText)
    : {};

  const scored = tracks.map((track) => {
    let score = Math.round(computeWithinTierScore(track, query, referenceDuration) * 100) / 100;
    const src = (track as unknown as { source?: string }).source ?? "";
    score *= SOURCE_WEIGHT[src] ?? 1.0;
    if (smartBoosts[src]) score *= smartBoosts[src];
    score = Math.round(score * 100) / 100;
    return { ...track, score } as T;
  });

  return scored.sort((a, b) => {
    const tierA = TYPE_TIER[a.type];
    const tierB = TYPE_TIER[b.type];
    if (tierA !== tierB) return tierA - tierB;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

/** Produce a simplified query string that strips metadata noise before sending to search APIs */
export function simplifyQuery(artist: string, title: string): string {
  const a = stripMetadata(artist).replace(/\s*feat.*/i, "").trim();
  const t = stripMetadata(title).replace(/\s*feat.*/i, "").trim();
  return `${a} ${t}`.trim();
}
