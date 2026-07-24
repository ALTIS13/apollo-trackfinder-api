import type { TfSearchResult, TfSearchSuggestion } from "@workspace/tf-search-contract";

const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const MAX_RESULTS_PER_ENTRY = 40;
const MAX_SUGGESTIONS = 5;

interface CacheEntry {
  readonly expiresAt: number;
  readonly results: readonly TfSearchResult[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function keyFor(artist: string, title: string): string {
  return `${normalize(artist)}::${normalize(title)}`;
}

function parseKey(key: string): TfSearchSuggestion {
  const separator = key.indexOf("::");
  return {
    artist: key.slice(0, separator),
    title: key.slice(separator + 2),
  };
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

  get(artist: string, title: string): readonly TfSearchResult[] | null {
    const key = keyFor(artist, title);
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

  set(artist: string, title: string, results: readonly TfSearchResult[]): void {
    const key = keyFor(artist, title);
    this.removeExpired();
    this.entries.delete(key);

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      results: results.slice(0, MAX_RESULTS_PER_ENTRY),
    });
  }

  suggestions(query: string, limit: number): readonly TfSearchSuggestion[] {
    this.removeExpired();
    const normalizedQuery = normalize(query);
    const maxSuggestions = Math.min(MAX_SUGGESTIONS, Math.max(0, Math.floor(limit)));
    const matches: TfSearchSuggestion[] = [];

    for (const key of this.entries.keys()) {
      if (!key.includes(normalizedQuery)) continue;
      matches.push(parseKey(key));
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
