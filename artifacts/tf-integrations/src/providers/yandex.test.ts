import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  YandexProvider,
  YandexProviderError,
  type YandexProviderOptions,
} from "./yandex.js";

type RecordedRequest = {
  readonly url: string;
  readonly init: RequestInit;
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProvider(
  responses: readonly Response[],
  overrides: Partial<YandexProviderOptions> = {},
): {
  readonly provider: YandexProvider;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const provider = new YandexProvider({
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
    ...overrides,
  });
  return { provider, requests };
}

function yandexTrack(id = 101) {
  return {
    id,
    title: "Yandex Track",
    artists: [{ name: "Artist One" }, { name: "Artist Two" }],
    albums: [
      {
        title: "Yandex Album",
        coverUri: "avatars.yandex.net/get-music-content/123/%%",
        year: 2026,
      },
    ],
    durationMs: 241_999,
  };
}

function expectedTrack(id = 101) {
  return {
    id: String(id),
    title: "Yandex Track",
    artist: "Artist One, Artist Two",
    album: "Yandex Album",
    duration: 241,
    thumbnailUrl:
      "https://avatars.yandex.net/get-music-content/123/200x200",
    providerUrl: `https://music.yandex.ru/track/${id}`,
  };
}

function expectFixedRequest(
  request: RecordedRequest,
  token: string,
): void {
  expect(request.url).toMatch(/^https:\/\/api\.music\.yandex\.net\//);
  expect(request.init.redirect).toBe("error");
  expect(request.init.headers).toEqual({
    Accept: "application/json",
    Authorization: `OAuth ${token}`,
    "X-Yandex-Music-Client": "YandexMusicAndroid/24023621",
  });
}

describe("YandexProvider", () => {
  it("validates a token only through the fixed account status endpoint", async () => {
    const token = `oauth-${randomUUID()}`;
    const { provider, requests } = makeProvider([
      jsonResponse({
        invocationInfo: { reqId: "public-request-id" },
        result: {
          account: {
            uid: 12345,
            login: "yandex-login",
            displayName: "Display Name",
            fullName: "Full Name",
          },
        },
      }),
    ]);

    await expect(provider.validateToken({ oauthToken: token })).resolves.toEqual(
      {
        id: "12345",
        displayName: "Full Name",
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://api.music.yandex.net/account/status",
    );
    expectFixedRequest(requests[0]!, token);

    await expect(
      provider.validateToken({ oauthToken: "short" }),
    ).rejects.toBeInstanceOf(YandexProviderError);
    expect(requests).toHaveLength(1);
  });

  it("uses fixed Yandex Music headers and HTTPS endpoint templates", async () => {
    const token = `oauth-${randomUUID()}`;
    const { provider, requests } = makeProvider([
      jsonResponse({ result: [] }),
      jsonResponse({
        result: {
          kind: 8,
          title: "Playlist",
          tracks: [],
        },
      }),
    ]);

    await provider.playlists({ oauthToken: token, userId: "12345" });
    await provider.playlistTracks({
      oauthToken: token,
      uid: 12345,
      kind: 8,
      offset: 0,
      limit: 50,
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.music.yandex.net/users/12345/playlists/list",
      "https://api.music.yandex.net/users/12345/playlists/8",
    ]);
    for (const request of requests) {
      expectFixedRequest(request, token);
    }
    await expect(
      provider.playlists({
        oauthToken: token,
        userId: "../private?path=canary",
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(requests).toHaveLength(2);
  });

  it("bounds liked pagination and fetches only the requested track detail page", async () => {
    const token = `oauth-${randomUUID()}`;
    const { provider, requests } = makeProvider([
      jsonResponse({
        result: {
          library: {
            tracks: [
              { id: 101, albumId: 201 },
              { id: 102, albumId: 202 },
              { id: 103, albumId: 203 },
              { id: 104 },
            ],
          },
        },
      }),
      jsonResponse({ result: [yandexTrack(102), yandexTrack(103)] }),
    ]);

    await expect(
      provider.likedTracks({
        oauthToken: token,
        userId: "12345",
        offset: 1,
        limit: 2,
      }),
    ).resolves.toEqual({
      offset: 1,
      limit: 2,
      total: 4,
      tracks: [expectedTrack(102), expectedTrack(103)],
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.music.yandex.net/users/12345/likes/tracks",
      "https://api.music.yandex.net/tracks?track-ids=102%3A202%2C103%3A203",
    ]);
    for (const request of requests) {
      expectFixedRequest(request, token);
    }
    await expect(
      provider.likedTracks({
        oauthToken: token,
        userId: "12345",
        offset: 1_000_001,
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(
      provider.likedTracks({
        oauthToken: token,
        userId: "12345",
        offset: 0,
        limit: 51,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(requests).toHaveLength(2);
  });

  it("strictly validates and normalizes playlists and playlist tracks", async () => {
    const token = `oauth-${randomUUID()}`;
    const { provider } = makeProvider([
      jsonResponse({
        result: [
          {
            uid: 12345,
            kind: 8,
            title: "Playlist",
            description: "Description",
            trackCount: 3,
            cover: {
              uri: "avatars.yandex.net/get-music-content/456/%%",
            },
            owner: {
              login: "owner-login",
              name: "Owner Name",
              displayName: "Owner Display",
            },
          },
        ],
      }),
      jsonResponse({
        result: {
          kind: 8,
          title: "Playlist",
          tracks: [
            {
              id: 101,
              timestamp: "2026-07-25T12:00:00Z",
              track: yandexTrack(),
            },
          ],
        },
      }),
    ]);

    await expect(
      provider.playlists({ oauthToken: token, userId: "12345" }),
    ).resolves.toEqual({
      playlists: [
        {
          uid: 12345,
          kind: 8,
          title: "Playlist",
          description: "Description",
          trackCount: 3,
          thumbnailUrl:
            "https://avatars.yandex.net/get-music-content/456/200x200",
          owner: "Owner Display",
        },
      ],
      total: 1,
    });
    await expect(
      provider.playlistTracks({
        oauthToken: token,
        uid: 12345,
        kind: 8,
        offset: 0,
        limit: 1,
      }),
    ).resolves.toEqual({
      offset: 0,
      limit: 1,
      total: 1,
      tracks: [expectedTrack()],
    });

    const malformed = makeProvider([
      jsonResponse({
        result: [
          {
            uid: 12345,
            kind: "8",
            title: "Playlist",
            trackCount: 1,
            owner: { login: "owner" },
          },
        ],
      }),
    ]).provider;
    await expect(
      malformed.playlists({ oauthToken: token, userId: "12345" }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects a malformed account response independently", async () => {
    const token = `oauth-${randomUUID()}`;
    const malformedAccount = makeProvider([
      jsonResponse({
        result: {
          account: {
            uid: "12345",
            login: "yandex-login",
          },
        },
      }),
    ]).provider;
    await expect(
      malformedAccount.validateToken({ oauthToken: token }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects a malformed liked-detail response independently", async () => {
    const token = `oauth-${randomUUID()}`;
    const malformedLikedDetails = makeProvider([
      jsonResponse({
        result: {
          library: { tracks: [{ id: 101, albumId: 201 }] },
        },
      }),
      jsonResponse({
        result: [{ ...yandexTrack(), durationMs: "241999" }],
      }),
    ]).provider;
    await expect(
      malformedLikedDetails.likedTracks({
        oauthToken: token,
        userId: "12345",
        offset: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("rejects a malformed playlist-track response independently", async () => {
    const token = `oauth-${randomUUID()}`;
    const malformedPlaylistTrack = makeProvider([
      jsonResponse({
        result: {
          kind: 8,
          title: "Playlist",
          tracks: [
            {
              id: 101,
              timestamp: "2026-07-25T12:00:00Z",
              track: { ...yandexTrack(), artists: [] },
            },
          ],
        },
      }),
    ]).provider;
    await expect(
      malformedPlaylistTrack.playlistTracks({
        oauthToken: token,
        uid: 12345,
        kind: 8,
        offset: 0,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("returns stable provider errors without token, raw response, or private path values", async () => {
    const tokenCanary = `oauth-${randomUUID()}`;
    const bodyCanary = `body-${randomUUID()}`;
    const pathCanary = `private-${randomUUID()}`;
    const logged: unknown[] = [];
    const { provider } = makeProvider(
      [
        new Response(bodyCanary, {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
      ],
      {
        logger: {
          error(event, message) {
            logged.push(event, message);
          },
        },
      },
    );

    let caught: unknown;
    try {
      await provider.playlists({
        oauthToken: tokenCanary,
        userId: pathCanary,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "provider_rejected" });

    const unavailable = makeProvider(
      [
        new Response(bodyCanary, {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
      ],
      {
        logger: {
          error(event, message) {
            logged.push(event, message);
          },
        },
      },
    ).provider;
    try {
      await unavailable.validateToken({ oauthToken: tokenCanary });
    } catch (error) {
      caught = error;
    }

    const exposed = JSON.stringify({ caught: String(caught), logged });
    expect(caught).toMatchObject({ code: "provider_unavailable" });
    expect(exposed).not.toContain(tokenCanary);
    expect(exposed).not.toContain(bodyCanary);
    expect(exposed).not.toContain(pathCanary);
  });
});
