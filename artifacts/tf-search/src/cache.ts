import type {
  TfSearchCommand,
  TfSearchResult,
  TfSearchSource,
  TfSearchSuggestion,
} from "@workspace/tf-search-contract";

const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const MAX_RESULTS_PER_ENTRY = 40;
const MAX_SUGGESTIONS = 5;
const SOURCE_ORDER: readonly TfSearchSource[] = ["yt", "sc", "bc", "dz"];

export interface SearchCacheIdentity {
  readonly artist: string;
  readonly title: string;
  readonly mode: TfSearchCommand["mode"];
  readonly sources: readonly TfSearchSource[];
  readonly maxResults: number;
}

interface CacheEntry {
  readonly artist: string;
  readonly title: string;
  readonly expiresAt: number;
  readonly results: readonly TfSearchResult[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function keyFor(identity: SearchCacheIdentity): string {
  const canonicalSources = SOURCE_ORDER.filter((source) => identity.sources.includes(source));
  return JSON.stringify([
    normalize(identity.artist),
    normalize(identity.title),
    identity.mode,
    canonicalSources,
    identity.maxResults,
  ]);
}

export class BoundedSearchCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: {
    readonly maxEntries?: number;
    readonly ttlMs?: number;
    readonly now?: () => number;
  } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.removeExpired();
    return this.entries.size;
  }

  get(identity: SearchCacheIdentity): readonly TfSearchResult[] | null {
    const key = keyFor(identity);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return [...entry.results];
  }

  set(identity: SearchCacheIdentity, results: readonly TfSearchResult[]): void {
    const key = keyFor(identity);
    const normalizedArtist = normalize(identity.artist);
    const normalizedTitle = normalize(identity.title);
    this.removeExpired();
    this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      artist: normalizedArtist,
      title: normalizedTitle,
      expiresAt: this.now() + this.ttlMs,
      results: results.slice(0, MAX_RESULTS_PER_ENTRY),
    });
  }

  suggestions(query: string, limit: number): readonly TfSearchSuggestion[] {
    this.removeExpired();
    const normalizedQuery = normalize(query);
    const maxSuggestions = Math.min(MAX_SUGGESTIONS, Math.max(0, Math.floor(limit)));
    const matches: TfSearchSuggestion[] = [];
    const projectedPairs = new Set<string>();

    for (const entry of this.entries.values()) {
      if (!entry.artist.includes(normalizedQuery) && !entry.title.includes(normalizedQuery)) continue;
      const projectedPair = JSON.stringify([entry.artist, entry.title]);
      if (projectedPairs.has(projectedPair)) continue;
      projectedPairs.add(projectedPair);
      matches.push({ artist: entry.artist, title: entry.title });
      if (matches.length === maxSuggestions) break;
    }

    return matches;
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
