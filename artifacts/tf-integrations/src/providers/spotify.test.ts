import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ProviderError,
  SpotifyProvider,
  type SpotifyProviderOptions,
} from "./spotify.js";

type RecordedRequest = {
  readonly url: string;
  readonly init: RequestInit;
};

const now = Date.parse("2026-07-25T12:00:00.000Z");
const callbackUri = "https://tf.apollot.ru/api/spotify/callback";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetch(responses: readonly Response[]): {
  readonly requests: RecordedRequest[];
  readonly fetch: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: (async (
      input: Parameters<typeof fetch>[0],
      init: RequestInit = {},
    ) => {
      expect(init.redirect).toBe("error");
      requests.push({ url: String(input), init });
      const response = responses[index++];
      if (response === undefined) {
        throw new Error("unexpected fetch");
      }
      return response;
    }) as typeof fetch,
  };
}

function makeProvider(
  responses: readonly Response[],
  overrides: Partial<SpotifyProviderOptions> = {},
): {
  readonly provider: SpotifyProvider;
  readonly requests: RecordedRequest[];
} {
  const recorded = recordingFetch(responses);
  return {
    provider: new SpotifyProvider({
      clientId: "spotify-client",
      clientSecret: "spotify-credential",
      callbackUri,
      fetch: recorded.fetch,
      now: () => now,
      ...overrides,
    }),
    requests: recorded.requests,
  };
}

function spotifyTrack(id = "track-1") {
  return {
    id,
    name: "Track One",
    artists: [{ name: "Artist One" }, { name: "Artist Two" }],
    album: {
      name: "Album One",
      images: [
        { url: "https://i.scdn.co/image/small", width: 64, height: 64 },
        { url: "https://i.scdn.co/image/large", width: 640, height: 640 },
      ],
    },
    duration_ms: 182_999,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

function expectRedirectError(requests: readonly RecordedRequest[]): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.init.redirect).toBe("error");
  }
}

async function providerOutcomeWithin(
  pending: Promise<unknown>,
  timeoutMs = 100,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("SpotifyProvider", () => {
  it("builds the fixed authorization URL with existing read scopes and exact callback", () => {
    const { provider } = makeProvider([]);
    const state = `state-${randomUUID()}`;

    const authorizationUrl = provider.authorizationUrl({
      state,
      callbackUri,
    });
    const parsed = new URL(authorizationUrl);

    expect(parsed.origin).toBe("https://accounts.spotify.com");
    expect(parsed.pathname).toBe("/authorize");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      response_type: "code",
      client_id: "spotify-client",
      scope:
        "user-library-read playlist-read-private playlist-read-collaborative user-top-read user-read-recently-played",
      redirect_uri: callbackUri,
      state,
    });
    expect(() =>
      provider.authorizationUrl({
        state,
        callbackUri: "https://tf.apollot.ru/api/spotify/callback?next=private",
      }),
    ).toThrow(ProviderError);
  });

  it("requires the command callback to equal the configured runtime callback", async () => {
    const { provider, requests } = makeProvider([]);
    const otherOriginCallback =
      "https://attacker.example/api/spotify/callback";

    expect(() =>
      provider.authorizationUrl({
        state: "state",
        callbackUri: otherOriginCallback,
      }),
    ).toThrow(ProviderError);
    await expect(
      provider.exchangeCode({
        code: "bounded-code",
        callbackUri: otherOriginCallback,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(requests).toHaveLength(0);

    expect(() =>
      makeProvider([], {
        callbackUri: "http://tf.example.test/api/spotify/callback",
      }),
    ).toThrow(ProviderError);

    const deploymentCallback =
      "https://api.deployment.example/api/spotify/callback";
    const configuredProvider = makeProvider([], {
      callbackUri: deploymentCallback,
    }).provider;
    expect(
      new URL(
        configuredProvider.authorizationUrl({
          state: "state",
          callbackUri: deploymentCallback,
        }),
      ).searchParams.get("redirect_uri"),
    ).toBe(deploymentCallback);
  });

  it("exchanges a bounded code and requires access, refresh, and expiry values", async () => {
    const accessToken = `access-${randomUUID()}`;
    const refreshToken = `refresh-${randomUUID()}`;
    const { provider, requests } = makeProvider([
      jsonResponse({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 3_600,
        token_type: "Bearer",
        scope: "user-library-read",
      }),
      jsonResponse({
        id: "spotify-user",
        display_name: "Spotify User",
        external_urls: {
          spotify: "https://open.spotify.com/user/spotify-user",
        },
      }),
    ]);

    await expect(
      provider.exchangeCode({ code: "bounded-code", callbackUri }),
    ).resolves.toEqual({
      secret: {
        accessToken,
        refreshToken,
        expiresAt: "2026-07-25T13:00:00.000Z",
      },
      account: { id: "spotify-user", displayName: "Spotify User" },
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://accounts.spotify.com/api/token",
      "https://api.spotify.com/v1/me",
    ]);
    expect(String(requests[0]!.init.body)).toContain(
      "grant_type=authorization_code",
    );
    expect(String(requests[0]!.init.body)).toContain("code=bounded-code");
    expect(String(requests[0]!.init.body)).toContain(
      `redirect_uri=${encodeURIComponent(callbackUri)}`,
    );
    expect(requests[1]!.init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    });
    expectRedirectError(requests);

    const missingRefresh = makeProvider([
      jsonResponse({ access_token: "access", expires_in: 3_600 }),
    ]).provider;
    await expect(
      missingRefresh.exchangeCode({ code: "bounded-code", callbackUri }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
    await expect(
      provider.exchangeCode({ code: "x".repeat(8_193), callbackUri }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
  });

  it.each([
    {
      field: "missing access token",
      response: { refresh_token: "refresh", expires_in: 3_600 },
    },
    {
      field: "non-string access token",
      response: {
        access_token: 42,
        refresh_token: "refresh",
        expires_in: 3_600,
      },
    },
    {
      field: "missing expiry",
      response: { access_token: "access", refresh_token: "refresh" },
    },
    {
      field: "non-integer expiry",
      response: {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: "3600",
      },
    },
    {
      field: "zero expiry",
      response: {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 0,
      },
    },
    {
      field: "oversized expiry",
      response: {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 86_401,
      },
    },
  ])("rejects an exchange response with $field", async ({ response }) => {
    const { provider } = makeProvider([jsonResponse(response)]);
    await expect(
      provider.exchangeCode({ code: "bounded-code", callbackUri }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("refreshes within 60 seconds of expiry and preserves a missing replacement refresh token", async () => {
    const replacementAccess = `access-${randomUUID()}`;
    const existingRefresh = `refresh-${randomUUID()}`;
    const { provider, requests } = makeProvider([
      jsonResponse({
        access_token: replacementAccess,
        expires_in: 1_800,
        token_type: "Bearer",
      }),
    ]);

    await expect(
      provider.refresh({
        accessToken: "expiring-access",
        refreshToken: existingRefresh,
        expiresAt: "2026-07-25T12:01:00.000Z",
      }),
    ).resolves.toEqual({
      refreshed: true,
      secret: {
        accessToken: replacementAccess,
        refreshToken: existingRefresh,
        expiresAt: "2026-07-25T12:30:00.000Z",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://accounts.spotify.com/api/token");
    expect(String(requests[0]!.init.body)).toContain(
      `refresh_token=${encodeURIComponent(existingRefresh)}`,
    );
    expectRedirectError(requests);

    const fresh = makeProvider([]).provider;
    await expect(
      fresh.refresh({
        accessToken: "fresh-access",
        refreshToken: existingRefresh,
        expiresAt: "2026-07-25T12:01:00.001Z",
      }),
    ).resolves.toEqual({
      refreshed: false,
      secret: {
        accessToken: "fresh-access",
        refreshToken: existingRefresh,
        expiresAt: "2026-07-25T12:01:00.001Z",
      },
    });
  });

  it("calls only fixed Spotify HTTPS endpoints with bounded query values", async () => {
    const { provider, requests } = makeProvider([
      jsonResponse({ items: [{ track: spotifyTrack("liked") }], total: 1 }),
      jsonResponse({
        items: [
          {
            id: "playlist-1",
            name: "Playlist One",
            description: "",
            tracks: { total: 1 },
            images: [{ url: "https://i.scdn.co/image/playlist" }],
            owner: { display_name: "Owner" },
          },
        ],
        total: 1,
      }),
      jsonResponse({
        items: [{ track: spotifyTrack("playlist-track") }],
        total: 1,
      }),
      jsonResponse({ items: [spotifyTrack("top")] }),
    ]);

    await provider.likedTracks({
      accessToken: "access",
      offset: 1_000_000,
      limit: 50,
    });
    await provider.playlists({ accessToken: "access" });
    await provider.playlistTracks({
      accessToken: "access",
      playlistId: "playlist / identifier",
      offset: 0,
      limit: 1,
    });
    await provider.topTracks({
      accessToken: "access",
      timeRange: "long_term",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.spotify.com/v1/me/tracks?offset=1000000&limit=50",
      "https://api.spotify.com/v1/me/playlists?limit=50",
      "https://api.spotify.com/v1/playlists/playlist%20%2F%20identifier/tracks?offset=0&limit=1&fields=items%28track%28id%2Cname%2Cartists%2Calbum%2Cduration_ms%2Cexternal_urls%29%29%2Ctotal",
      "https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=long_term",
    ]);
    expectRedirectError(requests);

    await expect(
      provider.likedTracks({
        accessToken: "access",
        offset: 1_000_001,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(
      provider.playlistTracks({
        accessToken: "access",
        playlistId: "x".repeat(513),
        offset: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
  });

  it("forwards the command abort signal to every fixed Spotify request", async () => {
    const controller = new AbortController();
    const { provider, requests } = makeProvider([
      jsonResponse({ items: [], total: 0 }),
    ]);

    await provider.likedTracks({
      accessToken: "access",
      offset: 0,
      limit: 1,
      signal: controller.signal,
    });

    expect(requests[0]?.init.signal).toBe(controller.signal);
  });

  it("cancels non-OK and oversized declared response bodies before throwing", async () => {
    const nonOk = new Response("provider-error-body", { status: 503 });
    const nonOkCancel = vi.spyOn(nonOk.body!, "cancel");
    const nonOkProvider = makeProvider([nonOk]).provider;
    await expect(
      nonOkProvider.likedTracks({
        accessToken: "access",
        offset: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(nonOkCancel).toHaveBeenCalledOnce();

    const declaredOversized = new Response("{}", {
      status: 200,
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
    const oversizedCancel = vi.spyOn(
      declaredOversized.body!,
      "cancel",
    );
    const oversizedProvider = makeProvider([declaredOversized]).provider;
    await expect(
      oversizedProvider.playlists({ accessToken: "access" }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it("bounds streaming JSON and cancels stalled or non-terminating bodies on abort", async () => {
    let oversizedCancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        oversizedCancelled = true;
      },
    });
    const oversizedProvider = makeProvider([
      new Response(oversizedStream, { status: 200 }),
    ]).provider;
    const oversizedOutcome = await providerOutcomeWithin(
      oversizedProvider.likedTracks({
        accessToken: "access",
        offset: 0,
        limit: 1,
      }),
    );
    expect(oversizedOutcome).toMatchObject({
      error: expect.objectContaining({
        code: "invalid_provider_response",
      }),
    });
    expect(oversizedCancelled).toBe(true);

    let stalledCancelled = false;
    const stalledStream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        stalledCancelled = true;
      },
    });
    const stalledProvider = makeProvider([
      new Response(stalledStream, { status: 200 }),
    ]).provider;
    const controller = new AbortController();
    const stalled = stalledProvider.likedTracks({
      accessToken: "access",
      offset: 0,
      limit: 1,
      signal: controller.signal,
    });
    controller.abort();
    const stalledOutcome = await providerOutcomeWithin(stalled);
    expect(stalledOutcome).toMatchObject({
      error: expect.objectContaining({ code: "provider_unavailable" }),
    });
    expect(stalledCancelled).toBe(true);
  });

  it("drains finite malformed JSON and returns only a stable provider error", async () => {
    const malformed = makeProvider([
      new Response("{", { status: 200 }),
    ]).provider;

    await expect(
      malformed.playlists({ accessToken: "access" }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects dot-segment playlist IDs before constructing a provider path", async () => {
    const { provider, requests } = makeProvider([
      jsonResponse({
        items: [{ track: spotifyTrack("playlist-track") }],
        total: 1,
      }),
    ]);

    for (const playlistId of [".", ".."]) {
      await expect(
        provider.playlistTracks({
          accessToken: "access",
          playlistId,
          offset: 0,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "provider_rejected" });
    }
    expect(requests).toHaveLength(0);

    await expect(
      provider.playlistTracks({
        accessToken: "access",
        playlistId: "playlist..safe",
        offset: 0,
        limit: 1,
      }),
    ).resolves.toMatchObject({ total: 1 });
    expect(requests[0]!.url).toBe(
      "https://api.spotify.com/v1/playlists/playlist..safe/tracks?offset=0&limit=1&fields=items%28track%28id%2Cname%2Cartists%2Calbum%2Cduration_ms%2Cexternal_urls%29%29%2Ctotal",
    );
  });

  it("strictly validates and normalizes liked tracks, playlists, playlist tracks, and top tracks", async () => {
    const expectedTrack = {
      id: "track-1",
      title: "Track One",
      artist: "Artist One, Artist Two",
      album: "Album One",
      duration: 182,
      thumbnailUrl: "https://i.scdn.co/image/large",
      providerUrl: "https://open.spotify.com/track/track-1",
    };
    const { provider } = makeProvider([
      jsonResponse({ items: [{ track: spotifyTrack() }], total: 7 }),
      jsonResponse({
        items: [
          {
            id: "playlist-1",
            name: "Playlist One",
            description: "Description",
            tracks: { total: 7 },
            images: [{ url: "https://i.scdn.co/image/playlist" }],
            owner: { display_name: "Playlist Owner" },
          },
        ],
        total: 1,
      }),
      jsonResponse({ items: [{ track: spotifyTrack() }], total: 7 }),
      jsonResponse({ items: [spotifyTrack()] }),
    ]);

    await expect(
      provider.likedTracks({ accessToken: "access", offset: 5, limit: 2 }),
    ).resolves.toEqual({
      offset: 5,
      limit: 2,
      total: 7,
      tracks: [expectedTrack],
    });
    await expect(
      provider.playlists({ accessToken: "access" }),
    ).resolves.toEqual({
      playlists: [
        {
          id: "playlist-1",
          name: "Playlist One",
          description: "Description",
          trackCount: 7,
          thumbnailUrl: "https://i.scdn.co/image/playlist",
          owner: "Playlist Owner",
        },
      ],
      total: 1,
    });
    await expect(
      provider.playlistTracks({
        accessToken: "access",
        playlistId: "playlist-1",
        offset: 5,
        limit: 2,
      }),
    ).resolves.toEqual({
      offset: 5,
      limit: 2,
      total: 7,
      tracks: [expectedTrack],
    });
    await expect(
      provider.topTracks({
        accessToken: "access",
        timeRange: "medium_term",
      }),
    ).resolves.toEqual({ tracks: [expectedTrack] });

    const malformed = makeProvider([
      jsonResponse({
        items: [
          {
            track: {
              ...spotifyTrack(),
              duration_ms: "182999",
            },
          },
        ],
        total: 1,
      }),
    ]).provider;
    await expect(
      malformed.likedTracks({ accessToken: "access", offset: 0, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects a malformed playlist-track response independently", async () => {
    const malformedPlaylistTracks = makeProvider([
      jsonResponse({
        items: [
          {
            track: {
              ...spotifyTrack(),
              external_urls: {
                spotify: "http://open.spotify.com/track/track-1",
              },
            },
          },
        ],
        total: 1,
      }),
    ]).provider;
    await expect(
      malformedPlaylistTracks.playlistTracks({
        accessToken: "access",
        playlistId: "playlist-1",
        offset: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects a malformed top-track response independently", async () => {
    const malformedTopTracks = makeProvider([
      jsonResponse({
        items: [{ ...spotifyTrack(), artists: [{ name: 42 }] }],
      }),
    ]).provider;
    await expect(
      malformedTopTracks.topTracks({
        accessToken: "access",
        timeRange: "medium_term",
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("returns stable provider errors without raw body, token, code, URL query, or credentials", async () => {
    const tokenCanary = `token-${randomUUID()}`;
    const codeCanary = `code-${randomUUID()}`;
    const bodyCanary = `body-${randomUUID()}`;
    const credentialCanary = `credential-${randomUUID()}`;
    const queryCanary = `query-${randomUUID()}`;
    const logged: unknown[] = [];
    const { provider } = makeProvider(
      [
        new Response(bodyCanary, {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
      ],
      {
        clientSecret: credentialCanary,
        logger: {
          error(event, message) {
            logged.push(event, message);
          },
        },
      },
    );

    let caught: unknown;
    try {
      await provider.exchangeCode({
        code: codeCanary,
        callbackUri: `${callbackUri}?${queryCanary}`,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "provider_rejected" });

    const failed = makeProvider(
      [
        new Response(bodyCanary, {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
      ],
      {
        clientSecret: credentialCanary,
        logger: {
          error(event, message) {
            logged.push(event, message);
          },
        },
      },
    ).provider;
    try {
      await failed.likedTracks({
        accessToken: tokenCanary,
        offset: 0,
        limit: 1,
      });
    } catch (error) {
      caught = error;
    }

    const exposed = JSON.stringify({ caught: String(caught), logged });
    expect(caught).toMatchObject({ code: "provider_rejected" });
    expect(exposed).not.toContain(tokenCanary);
    expect(exposed).not.toContain(codeCanary);
    expect(exposed).not.toContain(bodyCanary);
    expect(exposed).not.toContain(credentialCanary);
    expect(exposed).not.toContain(queryCanary);
    expect(exposed).not.toContain(callbackUri);
  });
});
