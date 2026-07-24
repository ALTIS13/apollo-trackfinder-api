import { describe, expect, it } from "vitest";
import {
  tfSearchArtistDiscoveryCommandSchema,
  tfSearchArtistDiscoveryResponseSchema,
  tfSearchCommandSchema,
  tfSearchResponseSchema,
  tfSearchResultSourceSchema,
  tfSearchSourceSchema,
  tfSearchSuggestionsCommandSchema,
  tfSearchSuggestionsResponseSchema,
} from "./index";

const requestId = "10000000-0000-4000-8000-000000000001";

const command = {
  schemaVersion: 1,
  requestId,
  artist: "Artist",
  title: "Track",
  mode: "auto",
  sources: ["yt", "sc", "bc", "dz"],
  maxResults: 20,
} as const;

const result = {
  id: "yt_example",
  title: "Track",
  artist: "Artist",
  type: "original",
  duration: 180,
  source: "youtube",
  thumbnailUrl: "https://images.example.test/track.jpg",
  quality: ["128", "320"],
  viewCount: 1_000,
  score: 99.5,
  sourceUrl: "https://www.youtube.com/watch?v=example",
} as const;

const response = {
  schemaVersion: 1,
  requestId,
  query: "Artist Track",
  results: [result],
  cached: false,
  sources: ["yt", "sc", "bc", "dz"],
  fallbackAvailable: false,
  providerStatus: {
    yt: "ok",
    sc: "failed",
    bc: "skipped",
    dz: "ok",
  },
} as const;

describe("tf search contract", () => {
  it("accepts every command and result source enum value", () => {
    expect(tfSearchSourceSchema.options).toEqual(["yt", "sc", "bc", "dz"]);
    expect(tfSearchResultSourceSchema.options).toEqual([
      "youtube",
      "soundcloud",
      "bandcamp",
      "deezer",
    ]);
  });

  it("accepts a strict bounded search command", () => {
    expect(tfSearchCommandSchema.parse(command)).toEqual(command);
    expect(tfSearchCommandSchema.safeParse({ ...command, accountId: "secret" }).success).toBe(false);
    expect(tfSearchCommandSchema.safeParse({ ...command, maxResults: 41 }).success).toBe(false);
    expect(tfSearchCommandSchema.safeParse({ ...command, sources: ["yt", "yt"] }).success).toBe(false);
    expect(tfSearchCommandSchema.safeParse({ ...command, artist: " Artist " }).success).toBe(true);
    expect(tfSearchCommandSchema.safeParse({ ...command, artist: " ".repeat(201) }).success).toBe(false);
    expect(tfSearchCommandSchema.safeParse({ ...command, title: " ".repeat(301) }).success).toBe(false);
  });

  it("accepts a strict bounded response with internal source URLs", () => {
    expect(tfSearchResponseSchema.parse(response)).toEqual(response);
    expect(tfSearchResponseSchema.safeParse({ ...response, requestId: "not-a-uuid" }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: Array.from({ length: 41 }, () => result) }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, sourceUrl: "http://example.test" }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, duration: Number.POSITIVE_INFINITY }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, providerStatus: { ...response.providerStatus, yt: "partial" } }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, providerStatus: { yt: "ok" } }).success).toBe(false);
  });

  it("enforces result string, collection, and numeric bounds", () => {
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, id: "id" }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, title: " ".repeat(501) }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, artist: " ".repeat(301) }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, quality: ["128", "128"] }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, viewCount: Number.MAX_SAFE_INTEGER + 1 }] }).success).toBe(false);
    expect(tfSearchResponseSchema.safeParse({ ...response, results: [{ ...result, score: 1_001 }] }).success).toBe(false);
  });

  it("accepts strict bounded suggestions DTOs", () => {
    const suggestionsCommand = { schemaVersion: 1, requestId, query: "Artist", limit: 5 };
    const suggestionsResponse = {
      schemaVersion: 1,
      requestId,
      suggestions: [{ artist: "Artist", title: "Track" }],
    };

    expect(tfSearchSuggestionsCommandSchema.parse(suggestionsCommand)).toEqual(suggestionsCommand);
    expect(tfSearchSuggestionsCommandSchema.safeParse({ ...suggestionsCommand, query: "x" }).success).toBe(false);
    expect(tfSearchSuggestionsCommandSchema.safeParse({ ...suggestionsCommand, limit: 6 }).success).toBe(false);
    expect(tfSearchSuggestionsResponseSchema.parse(suggestionsResponse)).toEqual(suggestionsResponse);
    expect(tfSearchSuggestionsResponseSchema.safeParse({ ...suggestionsResponse, suggestions: Array.from({ length: 6 }, () => suggestionsResponse.suggestions[0]) }).success).toBe(false);
    expect(tfSearchSuggestionsResponseSchema.safeParse({ ...suggestionsResponse, suggestions: [{ ...suggestionsResponse.suggestions[0], accountId: "secret" }] }).success).toBe(false);
  });

  it("accepts a strict artist-only discovery command without a title sentinel", () => {
    const discoveryCommand = {
      schemaVersion: 1,
      requestId,
      artist: "Artist",
      sources: ["yt", "sc"],
      limitPerSource: 6,
    } as const;
    const discoveryResponse = {
      schemaVersion: 1,
      requestId,
      query: "Artist",
      results: [result],
      sources: ["yt", "sc"],
      providerStatus: {
        yt: "ok",
        sc: "failed",
        bc: "skipped",
        dz: "skipped",
      },
    } as const;

    expect(tfSearchArtistDiscoveryCommandSchema.parse(discoveryCommand)).toEqual(
      discoveryCommand,
    );
    expect(
      tfSearchArtistDiscoveryCommandSchema.safeParse({
        ...discoveryCommand,
        title: "Artist",
      }).success,
    ).toBe(false);
    expect(
      tfSearchArtistDiscoveryCommandSchema.safeParse({
        ...discoveryCommand,
        artist: "   ",
      }).success,
    ).toBe(false);
    expect(
      tfSearchArtistDiscoveryCommandSchema.safeParse({
        ...discoveryCommand,
        sources: ["yt", "yt"],
      }).success,
    ).toBe(false);
    expect(
      tfSearchArtistDiscoveryCommandSchema.safeParse({
        ...discoveryCommand,
        limitPerSource: 1.5,
      }).success,
    ).toBe(false);
    expect(
      tfSearchArtistDiscoveryResponseSchema.parse(discoveryResponse),
    ).toEqual(discoveryResponse);
    expect(
      tfSearchArtistDiscoveryResponseSchema.safeParse({
        ...discoveryResponse,
        query: "Artist Artist",
      }).success,
    ).toBe(true);
    expect(
      tfSearchArtistDiscoveryResponseSchema.safeParse({
        ...discoveryResponse,
        results: Array.from({ length: 41 }, () => result),
      }).success,
    ).toBe(false);
  });
});
