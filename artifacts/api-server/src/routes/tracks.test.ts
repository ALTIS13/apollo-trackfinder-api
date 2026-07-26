import { once } from "node:events";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TfSearchGateway,
} from "../lib/tf-search-client.js";
import { createTracksRouter, type TrackRouteDependencies } from "./tracks.js";

const ytdlpMocks = vi.hoisted(() => ({
  getStreamUrl: vi.fn(),
  spawnAudioDownload: vi.fn(),
}));

vi.mock("../lib/ytdlp.js", () => ({
  getStreamUrl: ytdlpMocks.getStreamUrl,
  spawnAudioDownload: ytdlpMocks.spawnAudioDownload,
}));

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const principal = {
  accountId: ACCOUNT_ID,
  tfSessionId: "40000000-0000-4000-8000-000000000004",
  installationId: "30000000-0000-4000-8000-000000000003",
  entitlements: [
    "tf.collections",
    "tf.downloads",
    "tf.integrations",
    "tf.search",
  ],
  sessionExpiresAt: "2026-07-24T04:00:00.000Z",
  policyFreshUntil: "2026-07-24T03:05:00.000Z",
} as const;
const servers: Server[] = [];

function result(
  index = 0,
  overrides: Partial<{
    readonly id: string;
    readonly score: number;
    readonly source: "youtube" | "soundcloud" | "bandcamp" | "deezer";
    readonly sourceUrl: string;
  }> = {},
) {
  return {
    id: overrides.id ?? `yt_result_${index}`,
    title: `Track ${index}`,
    artist: "Artist",
    type: "original" as const,
    duration: 180,
    source: overrides.source ?? ("youtube" as const),
    thumbnailUrl: null,
    quality: ["128", "320"],
    viewCount: 42,
    score: overrides.score ?? 90 - index,
    sourceUrl:
      overrides.sourceUrl ??
      `https://www.youtube.com/watch?v=result-${index}`,
  };
}

function searchResponse(
  overrides: Partial<{
    readonly results: ReturnType<typeof result>[];
    readonly cached: boolean;
    readonly sources: ("yt" | "sc" | "bc" | "dz")[];
    readonly fallbackAvailable: boolean;
  }> = {},
) {
  return {
    schemaVersion: 1 as const,
    requestId: "10000000-0000-4000-8000-000000000001",
    query: "Artist Track",
    results: overrides.results ?? [result()],
    cached: overrides.cached ?? false,
    sources: overrides.sources ?? ["yt", "sc", "bc", "dz"],
    fallbackAvailable: overrides.fallbackAvailable ?? false,
    providerStatus: {
      yt: "ok" as const,
      sc: "ok" as const,
      bc: "ok" as const,
      dz: "ok" as const,
    },
  };
}

function artistDiscoveryResponse(
  overrides: Partial<{
    readonly query: string;
    readonly results: ReturnType<typeof result>[];
  }> = {},
) {
  return {
    schemaVersion: 1 as const,
    requestId: "10000000-0000-4000-8000-000000000001",
    query: overrides.query ?? "Artist",
    results: overrides.results ?? [result()],
    sources: ["yt", "sc"] as const,
    providerStatus: {
      yt: "ok" as const,
      sc: "ok" as const,
      bc: "skipped" as const,
      dz: "skipped" as const,
    },
  };
}

function searchGateway() {
  return {
    search: vi.fn().mockResolvedValue(searchResponse()),
    discoverArtist: vi.fn().mockResolvedValue(artistDiscoveryResponse()),
    suggestions: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      suggestions: [{ artist: "Artist", title: "Track" }],
    }),
  } satisfies TfSearchGateway;
}

function routeDependencies(
  overrides: Partial<TrackRouteDependencies> = {},
) {
  const dependencies = {
    searchGateway: searchGateway(),
    loadRecentTracks: vi.fn().mockResolvedValue([
      {
        trackId: "recent-track",
        artist: "Artist",
        title: "Title",
      },
    ]),
    recordPlay: vi.fn().mockResolvedValue(undefined),
    loadTopArtists: vi.fn().mockResolvedValue([]),
    enqueueDownload: vi.fn().mockResolvedValue({
      jobId: "job-created",
      position: 1,
    }),
    listDownloadJobs: vi.fn().mockResolvedValue([]),
    getDownloadJobStatus: vi.fn().mockResolvedValue({
      id: "job-1",
      state: "waiting",
    }),
  };
  return Object.assign(
    dependencies,
    overrides,
  ) satisfies TrackRouteDependencies;
}

async function startTracksServer(
  dependencies: TrackRouteDependencies,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.tfPrincipal = principal;
    next();
  });
  app.use("/api", createTracksRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("TF search module routing", () => {
  it("preserves the public search response while stripping module-only fields", async () => {
    const gateway = searchGateway();
    gateway.search.mockResolvedValue(
      searchResponse({
        sources: ["yt"],
        fallbackAvailable: true,
      }),
    );
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );

    const response = await fetch(`${baseUrl}/tracks/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artist: "Artist",
        title: "Track",
        mode: "manual",
        sources: ["yt"],
        maxResults: 7,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(gateway.search).toHaveBeenCalledWith({
      artist: "Artist",
      title: "Track",
      mode: "manual",
      sources: ["yt"],
      maxResults: 7,
    });
    expect(body).toEqual({
      query: "Artist Track",
      results: [
        {
          id: "yt_result_0",
          title: "Track 0",
          artist: "Artist",
          type: "original",
          duration: 180,
          source: "youtube",
          thumbnailUrl: null,
          quality: ["128", "320"],
          viewCount: 42,
          score: 90,
        },
      ],
      cached: false,
      sources: ["yt"],
      fallbackAvailable: true,
    });
    expect(JSON.stringify(body)).not.toContain("sourceUrl");
    expect(JSON.stringify(body)).not.toContain("providerStatus");
  });

  it("maps a failed public search dispatch to the stable unavailable response", async () => {
    const gateway = searchGateway();
    gateway.search.mockRejectedValue(new Error("private module detail"));
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );

    const response = await fetch(`${baseUrl}/tracks/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artist: "Artist", title: "Track" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "search_unavailable",
    });
  });

  it("rejects out-of-contract source and max-result bounds before dispatch", async () => {
    const gateway = searchGateway();
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );

    for (const { body, message } of [
      {
        body: {
          artist: "Artist",
          title: "Track",
          mode: "manual",
          sources: ["yt", "yt"],
        },
        message: "invalid search options",
      },
      {
        body: {
          artist: "Artist",
          title: "Track",
          maxResults: 41,
        },
        message: "artist and title are required",
      },
      {
        body: {
          artist: "Artist",
          title: "Track",
          maxResults: 1.5,
        },
        message: "invalid search options",
      },
    ]) {
      const response = await fetch(`${baseUrl}/tracks/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "bad_request",
        message,
      });
    }
    expect(gateway.search).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only artist or title before gateway dispatch", async () => {
    const gateway = searchGateway();
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );

    for (const body of [
      { artist: "   ", title: "Track" },
      { artist: "Artist", title: "\t\r\n" },
    ]) {
      const response = await fetch(`${baseUrl}/tracks/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "bad_request",
        message: "artist and title are required",
      });
    }

    expect(gateway.search).not.toHaveBeenCalled();
  });

  it("keeps batch concurrency at eight, truncates to five, and applies the score threshold", async () => {
    let active = 0;
    let maximumActive = 0;
    const gateway = searchGateway();
    gateway.search.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return searchResponse({
        results: Array.from({ length: 6 }, (_, index) =>
          result(index, { score: index === 0 ? 80 : 79 - index }),
        ),
      });
    });
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );
    const tracks = Array.from({ length: 17 }, (_, index) => ({
      artist: `Artist ${index}`,
      title: `Track ${index}`,
    }));

    const response = await fetch(`${baseUrl}/tracks/batch-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracks }),
    });
    const body = (await response.json()) as {
      results: {
        matches: Record<string, unknown>[];
        bestScore: number;
        autoSelected: boolean;
      }[];
    };

    expect(response.status).toBe(200);
    expect(gateway.search).toHaveBeenCalledTimes(17);
    expect(maximumActive).toBe(8);
    expect(body.results).toHaveLength(17);
    expect(body.results[0]).toMatchObject({
      bestScore: 80,
      autoSelected: true,
    });
    expect(body.results[0]?.matches).toHaveLength(5);
    expect(JSON.stringify(body)).not.toContain("sourceUrl");

    gateway.search.mockClear();
    const rejected = await fetch(`${baseUrl}/tracks/batch-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tracks: Array.from({ length: 101 }, () => ({
          artist: "Artist",
          title: "Track",
        })),
      }),
    });
    expect(rejected.status).toBe(400);
    expect(gateway.search).not.toHaveBeenCalled();
  });

  it("delegates suggestions to the module cache", async () => {
    const gateway = searchGateway();
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );

    const response = await fetch(`${baseUrl}/tracks/suggest?q=%20ArTiSt%20`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      suggestions: [{ artist: "Artist", title: "Track" }],
    });
    expect(gateway.suggestions).toHaveBeenCalledWith("artist", 5);
  });

  it("keeps recommendation personalization in the API and strips private candidates", async () => {
    const gateway = searchGateway();
    gateway.discoverArtist
      .mockResolvedValueOnce(
        artistDiscoveryResponse({ results: [result(0), result(1)] }),
      )
      .mockResolvedValueOnce(
        artistDiscoveryResponse({
          query: "Second Artist",
          results: [result(0), result(2, { id: "yt_unique" })],
        }),
      );
    const baseUrl = await startTracksServer(
      routeDependencies({
        searchGateway: gateway,
        loadTopArtists: vi.fn().mockResolvedValue(["Artist", "Second Artist"]),
      }),
    );

    const response = await fetch(`${baseUrl}/tracks/recommendations`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(gateway.discoverArtist).toHaveBeenNthCalledWith(1, {
      artist: "Artist",
      sources: ["yt", "sc"],
      limitPerSource: 6,
    });
    expect(gateway.discoverArtist).toHaveBeenNthCalledWith(2, {
      artist: "Second Artist",
      sources: ["yt", "sc"],
      limitPerSource: 6,
    });
    expect(gateway.search).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      results: [
        { id: "yt_result_0" },
        { id: "yt_result_1" },
        { id: "yt_unique" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("sourceUrl");
    expect(JSON.stringify(body)).not.toContain("providerStatus");
  });

  it("isolates artist discovery failures and returns at most 20 deduped public candidates", async () => {
    const gateway = searchGateway();
    const candidates = Array.from({ length: 22 }, (_, index) =>
      result(index, { id: index === 21 ? "yt_result_0" : `candidate_${index}` }),
    );
    gateway.discoverArtist
      .mockRejectedValueOnce(new Error("private module detail"))
      .mockResolvedValueOnce(
        artistDiscoveryResponse({
          query: "Second Artist",
          results: candidates,
        }),
      );
    const baseUrl = await startTracksServer(
      routeDependencies({
        searchGateway: gateway,
        loadTopArtists: vi.fn().mockResolvedValue(["Artist", "Second Artist"]),
      }),
    );

    const response = await fetch(`${baseUrl}/tracks/recommendations`);
    const body = (await response.json()) as {
      results: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(gateway.discoverArtist).toHaveBeenCalledTimes(2);
    expect(body.results).toHaveLength(20);
    expect(new Set(body.results.map((candidate) => candidate["id"])).size).toBe(
      20,
    );
    expect(JSON.stringify(body)).not.toContain("sourceUrl");
    expect(JSON.stringify(body)).not.toContain("providerStatus");
  });

  it("keeps the empty recommendation fallback when every artist discovery fails", async () => {
    const gateway = searchGateway();
    gateway.discoverArtist.mockRejectedValue(new Error("private module detail"));
    const baseUrl = await startTracksServer(
      routeDependencies({
        searchGateway: gateway,
        loadTopArtists: vi.fn().mockResolvedValue(["Artist"]),
      }),
    );

    const response = await fetch(`${baseUrl}/tracks/recommendations`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
  });

  it("uses private module candidates for every Deezer playback and download fallback", async () => {
    const gateway = searchGateway();
    const sourceUrl = "https://www.youtube.com/watch?v=fallback";
    gateway.search.mockResolvedValue(
      searchResponse({
        results: [result(0, { sourceUrl })],
      }),
    );
    ytdlpMocks.getStreamUrl.mockResolvedValue({
      url: "https://media.example.test/audio",
      mimeType: "audio/mpeg",
    });
    ytdlpMocks.spawnAudioDownload.mockImplementation(() => {
      const process = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.kill = vi.fn();
      queueMicrotask(() => {
        process.stdout.end("audio");
        process.emit("close", 0);
      });
      return process;
    });
    const baseUrl = await startTracksServer(
      routeDependencies({ searchGateway: gateway }),
    );
    const deezerUrl =
      "https://cdns-preview-e.dzcdn.net/stream/c-test-preview";
    const trackId = `dz_${Buffer.from(deezerUrl).toString("base64url")}`;
    const query = "artist=Artist&title=Track";

    const stream = await fetch(
      `${baseUrl}/tracks/${trackId}/stream?${query}`,
    );
    const download = await fetch(
      `${baseUrl}/tracks/${trackId}/download?${query}`,
    );
    const audioStream = await fetch(
      `${baseUrl}/tracks/${trackId}/audio-stream?${query}`,
    );
    await Promise.all([download.arrayBuffer(), audioStream.arrayBuffer()]);

    expect(stream.status).toBe(200);
    await expect(stream.json()).resolves.toMatchObject({
      streamUrl: "https://media.example.test/audio",
    });
    expect(download.status).toBe(200);
    expect(audioStream.status).toBe(200);
    expect(gateway.search).toHaveBeenCalledTimes(3);
    expect(ytdlpMocks.getStreamUrl).toHaveBeenCalledWith(sourceUrl);
    expect(ytdlpMocks.spawnAudioDownload).toHaveBeenCalledWith(
      sourceUrl,
      "256",
    );
    expect(ytdlpMocks.spawnAudioDownload).toHaveBeenCalledWith(
      sourceUrl,
      "128",
    );
  });
});

describe("track account ownership", () => {
  it("uses the principal account for recent, play, and recommendations", async () => {
    const dependencies = routeDependencies();
    const baseUrl = await startTracksServer(dependencies);
    const attackerHeaders = { "x-client-session": OTHER_ACCOUNT_ID };

    const recent = await fetch(
      `${baseUrl}/tracks/recent?sessionId=${OTHER_ACCOUNT_ID}&limit=12`,
      { headers: attackerHeaders },
    );
    const play = await fetch(`${baseUrl}/tracks/play`, {
      method: "POST",
      headers: {
        ...attackerHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        trackId: "played-track",
        artist: "Artist",
        title: "Title",
        sessionId: OTHER_ACCOUNT_ID,
      }),
    });
    const recommendations = await fetch(
      `${baseUrl}/tracks/recommendations?sessionId=${OTHER_ACCOUNT_ID}`,
      { headers: attackerHeaders },
    );

    expect(recent.status).toBe(200);
    expect(play.status).toBe(201);
    expect(recommendations.status).toBe(200);
    expect(dependencies.loadRecentTracks).toHaveBeenCalledWith(ACCOUNT_ID, 12);
    expect(dependencies.recordPlay).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      trackId: "played-track",
      artist: "Artist",
      title: "Title",
    });
    expect(dependencies.loadTopArtists).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(
      JSON.stringify(dependencies.loadRecentTracks.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
    expect(JSON.stringify(dependencies.recordPlay.mock.calls)).not.toContain(
      OTHER_ACCOUNT_ID,
    );
    expect(
      JSON.stringify(dependencies.loadTopArtists.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
  });

  it("binds every download queue and lookup operation to the principal account", async () => {
    const dependencies = routeDependencies();
    const baseUrl = await startTracksServer(dependencies);
    const sourceUrl = "https://www.youtube.com/watch?v=account-bound";
    const trackId = `yt_${Buffer.from(sourceUrl, "utf8").toString("base64url")}`;
    const attackerHeaders = { "x-client-session": OTHER_ACCOUNT_ID };

    const queued = await fetch(`${baseUrl}/tracks/download/queue`, {
      method: "POST",
      headers: {
        ...attackerHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: OTHER_ACCOUNT_ID,
        tracks: [
          {
            trackId,
            artist: "Artist",
            title: "Title",
            quality: "192",
            sessionId: OTHER_ACCOUNT_ID,
          },
        ],
      }),
    });
    const jobs = await fetch(
      `${baseUrl}/tracks/download/jobs?sessionId=${OTHER_ACCOUNT_ID}`,
      { headers: attackerHeaders },
    );
    const status = await fetch(
      `${baseUrl}/tracks/download/status/job-1?sessionId=${OTHER_ACCOUNT_ID}`,
      { headers: attackerHeaders },
    );
    const file = await fetch(
      `${baseUrl}/tracks/download/file/job-1?sessionId=${OTHER_ACCOUNT_ID}`,
      { headers: attackerHeaders },
    );

    expect(queued.status).toBe(200);
    expect(jobs.status).toBe(200);
    expect(status.status).toBe(200);
    expect(file.status).toBe(404);
    expect(dependencies.enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        accountId: ACCOUNT_ID,
        trackId,
        artist: "Artist",
        title: "Title",
        quality: "192",
        sourceUrl,
        createdAt: expect.any(String),
      }),
    );
    expect(dependencies.listDownloadJobs).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(dependencies.getDownloadJobStatus).toHaveBeenCalledWith(
      "job-1",
      ACCOUNT_ID,
    );
    for (const spy of [
      dependencies.enqueueDownload,
      dependencies.listDownloadJobs,
      dependencies.getDownloadJobStatus,
    ]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    }
  });
});
