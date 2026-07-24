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
    expect(second.providerStatus).toEqual({ yt: "skipped", sc: "skipped", bc: "skipped", dz: "skipped" });
    expect(extended.cached).toBe(false);
    expect(repeatedExtended.cached).toBe(false);
    expect(partial.cached).toBe(false);
    expect(repeatedPartial.cached).toBe(false);
    expect(calls).toHaveLength(18);
  });

  it("does not cache an incomplete all-source provider fan-out", async () => {
    let partialCalls = 0;
    const partialProviders = allSources.map((source): SearchProvider => ({
      source,
      async search() {
        partialCalls += 1;
        if (source === "sc") throw new Error("provider failure");
        return [track(source === "yt" ? "youtube" : source === "bc" ? "bandcamp" : "deezer")];
      },
    }));
    const partialService = createSearchService({ providers: partialProviders });

    const partialFirst = await partialService.search(command());
    const partialSecond = await partialService.search(command({ requestId: "10000000-0000-4000-8000-000000000002" }));

    expect(partialFirst.cached).toBe(false);
    expect(partialSecond.cached).toBe(false);
    expect(partialCalls).toBe(8);

    let totalCalls = 0;
    const totalService = createSearchService({
      providers: allSources.map((source) => ({
        source,
        async search() {
          totalCalls += 1;
          throw new Error("provider failure");
        },
      })),
    });

    const totalFirst = await totalService.search(command());
    const totalSecond = await totalService.search(command({ requestId: "10000000-0000-4000-8000-000000000002" }));

    expect(totalFirst.cached).toBe(false);
    expect(totalSecond.cached).toBe(false);
    expect(totalCalls).toBe(8);
  });

  it("does not leak sourceUrl through a public projection helper", () => {
    const publicResult = toPublicSearchResult(track("youtube"));

    expect(publicResult).not.toHaveProperty("sourceUrl");
    expect(JSON.stringify(publicResult)).not.toContain("media.example.test");
  });

  it("reports bounded rolling RPM and provider-failure status without retaining queries", async () => {
    let now = 0;
    let failureMode: "none" | "partial" | "total" = "none";
    const sourceNames = { yt: "youtube", sc: "soundcloud", bc: "bandcamp", dz: "deezer" } as const;
    const service = createSearchService({
      now: () => now,
      providers: allSources.map((source) => ({
        source,
        async search() {
          if (failureMode === "total" || (failureMode === "partial" && source === "sc")) {
            throw new Error("provider failure");
          }
          return [track(sourceNames[source])];
        },
      })),
    });

    await service.search(command({ maxResults: 21, title: "Different" }));
    failureMode = "partial";
    await service.search(command({ requestId: "10000000-0000-4000-8000-000000000002", maxResults: 21, title: "Partial" }));
    expect(service.telemetry()).toEqual({ requestsPerMinute: 2, status: "warning" });

    failureMode = "total";
    await service.search(command({ requestId: "10000000-0000-4000-8000-000000000003", maxResults: 21, title: "Total 1" }));
    await service.search(command({ requestId: "10000000-0000-4000-8000-000000000004", maxResults: 21, title: "Total 2" }));
    await service.search(command({ requestId: "10000000-0000-4000-8000-000000000005", maxResults: 21, title: "Total 3" }));
    expect(service.telemetry()).toEqual({ requestsPerMinute: 5, status: "degraded" });

    now = 60_000;
    expect(service.telemetry()).toEqual({ requestsPerMinute: 0, status: "healthy" });
    expect(JSON.stringify(service)).not.toContain("Different");
  });

  it("does not add failure observations for cached hits", async () => {
    let shouldFail = false;
    const service = createSearchService({
      providers: allSources.map((source) => ({
        source,
        async search() {
          if (shouldFail) throw new Error("provider failure");
          const sourceNames = { yt: "youtube", sc: "soundcloud", bc: "bandcamp", dz: "deezer" } as const;
          return [track(sourceNames[source])];
        },
      })),
    });

    await service.search(command());
    shouldFail = true;
    const cached = await service.search(command({ requestId: "10000000-0000-4000-8000-000000000002" }));

    expect(cached.cached).toBe(true);
    expect(cached.providerStatus).toEqual({ yt: "skipped", sc: "skipped", bc: "skipped", dz: "skipped" });
    expect(service.telemetry().status).toBe("healthy");
  });
});
