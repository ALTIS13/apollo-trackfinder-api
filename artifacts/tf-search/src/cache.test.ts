import { describe, expect, it } from "vitest";
import type { TfSearchResult } from "@workspace/tf-search-contract";
import { BoundedSearchCache } from "./cache.js";

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

describe("BoundedSearchCache", () => {
  it("normalizes cache keys with lowercase trimmed artist and title", () => {
    const cache = new BoundedSearchCache();
    cache.set("  The Artist  ", "  THE Track ", [result(1)]);

    expect(cache.get("the artist", "the track")).toEqual([result(1)]);
    expect(cache.suggestions("ARTIST", 5)).toEqual([
      { artist: "the artist", title: "the track" },
    ]);
  });

  it("expires entries after one hour using the injected clock", () => {
    let now = 10_000;
    const cache = new BoundedSearchCache({ now: () => now });
    cache.set("Artist", "Track", [result(1)]);

    now += 60 * 60 * 1000 - 1;
    expect(cache.get("Artist", "Track")).toEqual([result(1)]);

    now += 1;
    expect(cache.get("Artist", "Track")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("refreshes insertion order on a cache hit", () => {
    let now = 0;
    const cache = new BoundedSearchCache({ maxEntries: 2, now: () => now });
    cache.set("Artist A", "Track", [result(1)]);
    now += 1;
    cache.set("Artist B", "Track", [result(2)]);

    expect(cache.get("Artist A", "Track")).toEqual([result(1)]);
    cache.set("Artist C", "Track", [result(3)]);

    expect(cache.get("Artist A", "Track")).toEqual([result(1)]);
    expect(cache.get("Artist B", "Track")).toBeNull();
    expect(cache.get("Artist C", "Track")).toEqual([result(3)]);
  });

  it("evicts the oldest entry at 2,048 entries", () => {
    const cache = new BoundedSearchCache();
    for (let index = 0; index < 2_049; index += 1) {
      cache.set(`Artist ${index}`, "Track", [result(index)]);
    }

    expect(cache.size).toBe(2_048);
    expect(cache.get("Artist 0", "Track")).toBeNull();
    expect(cache.get("Artist 2048", "Track")).toEqual([result(2048)]);
  });

  it("replaces an existing entry without increasing cardinality", () => {
    const cache = new BoundedSearchCache();
    cache.set("Artist", "Track", [result(1)]);
    cache.set(" ARTIST ", " track ", [result(2)]);

    expect(cache.size).toBe(1);
    expect(cache.get("artist", "track")).toEqual([result(2)]);
  });

  it("stores at most 40 results per entry", () => {
    const cache = new BoundedSearchCache();
    const results = Array.from({ length: 41 }, (_, index) => result(index));
    cache.set("Artist", "Track", results);

    expect(cache.get("Artist", "Track")).toEqual(results.slice(0, 40));
  });

  it("returns at most five matching normalized artist and title pairs", () => {
    const cache = new BoundedSearchCache();
    for (let index = 0; index < 6; index += 1) {
      cache.set(`Artist ${index}`, `Track ${index}`, [result(index)]);
    }
    cache.set("Other Artist", "Unrelated", [result(7)]);

    expect(cache.suggestions("track", 5)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({
        artist: `artist ${index}`,
        title: `track ${index}`,
      })),
    );
  });
});
