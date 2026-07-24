import { describe, expect, it } from "vitest";
import type { TfSearchResult } from "@workspace/tf-search-contract";
import { BoundedSearchCache, type SearchCacheIdentity } from "./cache.js";

function result(index: number): TfSearchResult {
  return {
    id: `yt_${index}`,
    title: `Title ${index}`,
    artist: `Artist ${index}`,
    type: "original",
    duration: 180,
    source: "youtube",
    thumbnailUrl: null,
    quality: ["128"],
    viewCount: null,
    score: 0,
    sourceUrl: `https://media.example.test/${index}`,
  };
}

function identity(overrides: Partial<SearchCacheIdentity> = {}): SearchCacheIdentity {
  return {
    artist: "Artist",
    title: "Track",
    mode: "auto",
    sources: ["yt", "sc", "bc", "dz"],
    maxResults: 20,
    ...overrides,
  };
}

describe("BoundedSearchCache", () => {
  it("normalizes cache keys with lowercase trimmed artist and title", () => {
    const cache = new BoundedSearchCache();
    cache.set(identity({ artist: "  The Artist  ", title: "  THE Track " }), [result(1)]);

    expect(cache.get(identity({ artist: "the artist", title: "the track" }))).toEqual([result(1)]);
    expect(cache.suggestions("ARTIST", 5)).toEqual([
      { artist: "the artist", title: "the track" },
    ]);
  });

  it("keeps delimiter-containing artist and title pairs distinct", () => {
    const cache = new BoundedSearchCache();
    cache.set(identity({ artist: "Alpha::Beta", title: "Gamma" }), [result(1)]);
    cache.set(identity({ artist: "Alpha", title: "Beta::Gamma" }), [result(2)]);

    expect(cache.size).toBe(2);
    expect(cache.get(identity({ artist: "alpha::beta", title: "gamma" }))).toEqual([result(1)]);
    expect(cache.get(identity({ artist: "alpha", title: "beta::gamma" }))).toEqual([result(2)]);
    expect(cache.suggestions("alpha", 5)).toEqual([
      { artist: "alpha::beta", title: "gamma" },
      { artist: "alpha", title: "beta::gamma" },
    ]);
  });

  it("expires entries after one hour using the injected clock", () => {
    let now = 10_000;
    const cache = new BoundedSearchCache({ now: () => now });
    cache.set(identity(), [result(1)]);

    now += 60 * 60 * 1000 - 1;
    expect(cache.get(identity())).toEqual([result(1)]);

    now += 1;
    expect(cache.get(identity())).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("refreshes insertion order on a cache hit", () => {
    let now = 0;
    const cache = new BoundedSearchCache({ maxEntries: 2, now: () => now });
    cache.set(identity({ artist: "Artist A" }), [result(1)]);
    now += 1;
    cache.set(identity({ artist: "Artist B" }), [result(2)]);

    expect(cache.get(identity({ artist: "Artist A" }))).toEqual([result(1)]);
    cache.set(identity({ artist: "Artist C" }), [result(3)]);

    expect(cache.get(identity({ artist: "Artist A" }))).toEqual([result(1)]);
    expect(cache.get(identity({ artist: "Artist B" }))).toBeNull();
    expect(cache.get(identity({ artist: "Artist C" }))).toEqual([result(3)]);
  });

  it("evicts the oldest entry at 2,048 entries", () => {
    const cache = new BoundedSearchCache();
    for (let index = 0; index < 2_049; index += 1) {
      cache.set(identity({ artist: `Artist ${index}` }), [result(index)]);
    }

    expect(cache.size).toBe(2_048);
    expect(cache.get(identity({ artist: "Artist 0" }))).toBeNull();
    expect(cache.get(identity({ artist: "Artist 2048" }))).toEqual([result(2048)]);
  });

  it("replaces an existing entry without increasing cardinality", () => {
    const cache = new BoundedSearchCache();
    cache.set(identity(), [result(1)]);
    cache.set(identity({ artist: " ARTIST ", title: " track " }), [result(2)]);

    expect(cache.size).toBe(1);
    expect(cache.get(identity({ artist: "artist", title: "track" }))).toEqual([result(2)]);
  });

  it("stores at most 40 results per entry", () => {
    const cache = new BoundedSearchCache();
    const results = Array.from({ length: 41 }, (_, index) => result(index));
    cache.set(identity(), results);

    expect(cache.get(identity())).toEqual(results.slice(0, 40));
  });

  it("returns at most five matching normalized artist and title pairs", () => {
    const cache = new BoundedSearchCache();
    for (let index = 0; index < 6; index += 1) {
      cache.set(identity({ artist: `Artist ${index}`, title: `Track ${index}` }), [result(index)]);
    }
    cache.set(identity({ artist: "Other Artist", title: "Unrelated" }), [result(7)]);

    expect(cache.suggestions("track", 5)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        artist: `artist ${index}`,
        title: `track ${index}`,
      })),
    );
  });
});
