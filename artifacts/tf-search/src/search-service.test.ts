import { describe, expect, it } from "vitest";
import type {
  TfSearchCommand,
  TfSearchResult,
  TfSearchSource,
} from "@workspace/tf-search-contract";
import { BoundedSearchCache } from "./cache.js";
import {
  createSearchService,
  toPublicSearchResult,
  type InternalTrack,
  type SearchProvider,
} from "./search-service.js";

const requestId = "10000000-0000-4000-8000-000000000001";
const allSources = ["yt", "sc", "bc", "dz"] as const;

function command(overrides: Partial<TfSearchCommand> = {}): TfSearchCommand {
  return {
    schemaVersion: 1,
    requestId,
    artist: "Artist",
    title: "Track",
    mode: "auto",
    sources: [...allSources],
    maxResults: 20,
    ...overrides,
  };
}

function track(
  source: TfSearchResult["source"],
  overrides: Partial<InternalTrack> = {},
): InternalTrack {
  return {
    id: `${source}_example`,
    title: "Track",
    artist: "Artist",
    type: "original",
    duration: 180,
    source,
    thumbnailUrl: "https://images.example.test/track.jpg",
    quality: ["128"],
    viewCount: 1_000,
    score: 0,
    sourceUrl: `https://media.example.test/${source}`,
    ...overrides,
  };
}

function provider(
  source: TfSearchSource,
  results: readonly InternalTrack[] = [],
  calls: Array<{ source: TfSearchSource; query: string; limit: number }> = [],
): SearchProvider {
  return {
    source,
    async search(query, limit) {
      calls.push({ source, query, limit });
      return results;
    },
  };
}

function providers(
  calls: Array<{ source: TfSearchSource; query: string; limit: number }> = [],
): SearchProvider[] {
  return [
    provider("yt", [track("youtube")], calls),
    provider("sc", [track("soundcloud")], calls),
    provider("bc", [track("bandcamp")], calls),
    provider("dz", [track("deezer")], calls),
  ];
}

describe("search service", () => {
  it("fans out only to selected sources and uses the approved limits", async () => {
    const calls: Array<{ source: TfSearchSource; query: string; limit: number }> = [];
    const service = createSearchService({ providers: providers(calls) });

    const response = await service.search(command({ sources: ["yt", "bc", "dz"], maxResults: 9 }));

    expect(calls).toEqual([
      { source: "yt", query: "Artist Track", limit: 9 },
      { source: "bc", query: "Artist Track", limit: 5 },
      { source: "dz", query: "Artist Track", limit: 5 },
    ]);
    expect(response.providerStatus).toEqual({ yt: "ok", sc: "skipped", bc: "ok", dz: "ok" });
  });

  it("preserves original remix live cover tier ordering and source boosts", async () => {
    const service = createSearchService({
      providers: [
        provider("yt", [track("youtube", { type: "original", viewCount: 0 })]),
        provider("sc", [track("soundcloud", { id: "sc_original", type: "original", viewCount: 0 })]),
        provider("bc", [track("bandcamp", { type: "remix", title: "Track Remix" })]),
        provider("dz", [track("deezer", { type: "live", title: "Track Live" }), track("deezer", { id: "dz_cover", type: "cover", title: "Track Cover" })]),
      ],
    });

    const response = await service.search(command());

    expect(response.results.map((result) => result.type)).toEqual(["original", "original", "remix", "live", "cover"]);
    expect(response.results.slice(0, 2).map((result) => result.source)).toEqual(["soundcloud", "youtube"]);
  });

  it("returns partial results and sanitized failed provider statuses", async () => {
    const leakedError = "Artist Track https://media.example.test/secret Authorization: Basic hidden";
    const failingProvider: SearchProvider = {
      source: "sc",
      async search() {
        throw new Error(leakedError);
      },
    };
    const logs: string[] = [];
    const service = createSearchService({
      providers: [provider("yt", [track("youtube")]), failingProvider],
      logger: { warn: (event) => logs.push(JSON.stringify(event)) },
    });

    const response = await service.search(command({ sources: ["yt", "sc"] }));

    expect(response.results).toHaveLength(1);
    expect(response.providerStatus).toEqual({ yt: "ok", sc: "failed", bc: "skipped", dz: "skipped" });
    expect(JSON.stringify(response)).not.toContain(leakedError);
    expect(logs.join("\n")).not.toContain("Artist");
    expect(logs.join("\n")).not.toContain("media.example.test");
    expect(logs.join("\n")).not.toContain("Authorization");
  });

  it("returns an empty successful response after total provider failure", async () => {
    const failed = (source: TfSearchSource): SearchProvider => ({
      source,
      async search() {
        throw new Error("provider response body must not escape");
      },
    });
    const service = createSearchService({ providers: allSources.map(failed) });

    const response = await service.search(command());

    expect(response.results).toEqual([]);
    expect(response.cached).toBe(false);
    expect(response.providerStatus).toEqual({ yt: "failed", sc: "failed", bc: "failed", dz: "failed" });
  });

  it("caches only all-source non-extended searches", async () => {
    const calls: Array<{ source: TfSearchSource; query: string; limit: number }> = [];
    const service = createSearchService({ providers: providers(calls), cache: new BoundedSearchCache() });

    const first = await service.search(command({ sources: ["dz", "bc", "sc", "yt"], mode: "manual" }));
    const second = await service.search(command({ requestId: "10000000-0000-4000-8000-000000000002" }));
    const extended = await service.search(command({
      requestId: "10000000-0000-4000-8000-000000000003",
      maxResults: 21,
    }));
    const repeatedExtended = await service.search(command({
      requestId: "10000000-0000-4000-8000-000000000004",
      maxResults: 21,
    }));
    const partial = await service.search(command({
      requestId: "10000000-0000-4000-8000-000000000005",
      sources: ["yt", "sc", "bc"],
    }));
    const repeatedPartial = await service.search(command({
      requestId: "10000000-0000-4000-8000-000000000006",
      sources: ["yt", "sc", "bc"],
    }));

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(extended.cached).toBe(false);
    expect(repeatedExtended.cached).toBe(false);
    expect(partial.cached).toBe(false);
    expect(repeatedPartial.cached).toBe(false);
    expect(calls).toHaveLength(18);
  });

  it("does not leak sourceUrl through a public projection helper", () => {
    const publicResult = toPublicSearchResult(track("youtube"));

    expect(publicResult).not.toHaveProperty("sourceUrl");
    expect(JSON.stringify(publicResult)).not.toContain("media.example.test");
  });

  it("reports bounded rolling RPM without retaining queries", async () => {
    let now = 0;
    const service = createSearchService({ providers: [], now: () => now });

    await service.search(command({ sources: ["yt"] }));
    await service.search(command({ sources: ["yt"], title: "Different" }));
    expect(service.telemetry()).toEqual({ requestsPerMinute: 2, status: "healthy" });

    now = 60_000;
    expect(service.telemetry()).toEqual({ requestsPerMinute: 0, status: "healthy" });
    expect(JSON.stringify(service)).not.toContain("Different");
  });
});
