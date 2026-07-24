import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTracksRouter, type TrackRouteDependencies } from "./tracks.js";

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

function routeDependencies() {
  return {
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
    getDownloadFilePath: vi.fn().mockResolvedValue(null),
  } satisfies TrackRouteDependencies;
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
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
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
    expect(dependencies.enqueueDownload).toHaveBeenCalledWith({
      trackId,
      artist: "Artist",
      title: "Title",
      quality: "192",
      sourceUrl,
      sessionId: ACCOUNT_ID,
    });
    expect(dependencies.listDownloadJobs).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(dependencies.getDownloadJobStatus).toHaveBeenCalledWith(
      "job-1",
      ACCOUNT_ID,
    );
    expect(dependencies.getDownloadFilePath).toHaveBeenCalledWith(
      "job-1",
      ACCOUNT_ID,
    );
    for (const spy of [
      dependencies.enqueueDownload,
      dependencies.listDownloadJobs,
      dependencies.getDownloadJobStatus,
      dependencies.getDownloadFilePath,
    ]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(OTHER_ACCOUNT_ID);
    }
  });
});
