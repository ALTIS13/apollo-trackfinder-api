import { randomBytes, randomUUID } from "node:crypto";

import {
  tfIntegrationOperationSchema,
  tfIntegrationsCommandSchema,
  type TfIntegrationsCommand,
} from "@workspace/tf-integrations-contract";
import type {
  Provider,
  ProviderAccountRecord,
  ProviderAccountRepository,
} from "@workspace/tf-integrations-db";
import { describe, expect, it } from "vitest";

import {
  ProviderTokenVault,
  parseProviderTokenKeyring,
  type SpotifySecret,
} from "./token-keyring.js";
import {
  TfIntegrationsService,
  type SpotifyProviderAdapter,
  type YandexProviderAdapter,
} from "./service.js";

const accountId = "5d8b0f1c-31cc-4c12-a826-65b922719af5";
const otherAccountId = "a40594ce-951f-4acf-82c3-816372e2c17d";
const requestId = "8be4ab5a-8550-4adf-92c7-a87eb23b40a1";

const normalizedTrack = {
  id: "track-1",
  title: "Track One",
  artist: "Artist One",
  album: "Album One",
  duration: 180,
  thumbnailUrl: "https://i.scdn.co/image/track",
  providerUrl: "https://open.spotify.com/track/track-1",
} as const;

function command(
  operation: string,
  input: Readonly<Record<string, unknown>>,
  signedAccountId = accountId,
): TfIntegrationsCommand {
  return tfIntegrationsCommandSchema.parse({
    schemaVersion: 1,
    requestId,
    accountId: signedAccountId,
    operation,
    input,
  });
}

function vault(activeKeyId = "active-key"): ProviderTokenVault {
  return new ProviderTokenVault(
    parseProviderTokenKeyring(
      JSON.stringify({
        activeKeyId,
        keys: {
          [activeKeyId]: randomBytes(32).toString("base64url"),
        },
      }),
    ),
  );
}

class MemoryRepository implements ProviderAccountRepository {
  readonly records = new Map<string, ProviderAccountRecord>();
  readonly events: string[] = [];
  deleteRecords = true;

  key(account: string, provider: Provider): string {
    return `${account}:${provider}`;
  }

  async get(
    account: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord | null> {
    this.events.push(`get:${account}:${provider}`);
    return this.records.get(this.key(account, provider)) ?? null;
  }

  async upsert(record: ProviderAccountRecord): Promise<void> {
    this.events.push(`upsert:${record.accountId}:${record.provider}`);
    this.records.set(this.key(record.accountId, record.provider), record);
  }

  async delete(account: string, provider: Provider): Promise<boolean> {
    this.events.push(`delete:${account}:${provider}`);
    if (!this.deleteRecords) {
      return this.records.has(this.key(account, provider));
    }
    return this.records.delete(this.key(account, provider));
  }

  async isMigrationCurrent(): Promise<boolean> {
    return true;
  }
}

function spotifyAdapter(
  overrides: Partial<SpotifyProviderAdapter> = {},
): SpotifyProviderAdapter {
  return {
    authorizationUrl: () =>
      "https://accounts.spotify.com/authorize?client_id=client&response_type=code&redirect_uri=https%3A%2F%2Ftf.apollot.ru%2Fapi%2Fspotify%2Fcallback&state=state&scope=user-library-read",
    async exchangeCode() {
      return {
        secret: {
          accessToken: "spotify-access",
          refreshToken: "spotify-refresh",
          expiresAt: "2026-07-25T13:00:00.000Z",
        },
        account: { id: "spotify-user", displayName: "Spotify User" },
      };
    },
    async refresh(secret) {
      return { refreshed: false, secret };
    },
    async likedTracks(input) {
      return {
        offset: input.offset,
        limit: input.limit,
        total: 1,
        tracks: [normalizedTrack],
      };
    },
    async playlists() {
      return {
        playlists: [
          {
            id: "spotify-playlist",
            name: "Spotify Playlist",
            description: "",
            trackCount: 1,
            thumbnailUrl: null,
            owner: "Spotify Owner",
          },
        ],
        total: 1,
      };
    },
    async playlistTracks(input) {
      return {
        offset: input.offset,
        limit: input.limit,
        total: 1,
        tracks: [normalizedTrack],
      };
    },
    async topTracks() {
      return { tracks: [normalizedTrack] };
    },
    ...overrides,
  };
}

function yandexAdapter(
  overrides: Partial<YandexProviderAdapter> = {},
): YandexProviderAdapter {
  return {
    async validateToken() {
      return { id: "12345", displayName: "Yandex User" };
    },
    async likedTracks(input) {
      return {
        offset: input.offset,
        limit: input.limit,
        total: 1,
        tracks: [
          {
            ...normalizedTrack,
            thumbnailUrl: null,
            providerUrl: "https://music.yandex.ru/track/track-1",
          },
        ],
      };
    },
    async playlists() {
      return {
        playlists: [
          {
            uid: 12345,
            kind: 8,
            title: "Yandex Playlist",
            description: "",
            trackCount: 1,
            thumbnailUrl: null,
            owner: "Yandex Owner",
          },
        ],
        total: 1,
      };
    },
    async playlistTracks(input) {
      return {
        offset: input.offset,
        limit: input.limit,
        total: 1,
        tracks: [
          {
            ...normalizedTrack,
            thumbnailUrl: null,
            providerUrl: "https://music.yandex.ru/track/track-1",
          },
        ],
      };
    },
    ...overrides,
  };
}

function service(
  repository: ProviderAccountRepository,
  tokenVault: ProviderTokenVault,
  spotify: SpotifyProviderAdapter = spotifyAdapter(),
  yandex: YandexProviderAdapter = yandexAdapter(),
  logger?: ConstructorParameters<typeof TfIntegrationsService>[0]["logger"],
): TfIntegrationsService {
  return new TfIntegrationsService({
    repository,
    tokenVault,
    spotify,
    yandex,
    logger,
  });
}

function storedRecord(
  tokenVault: ProviderTokenVault,
  provider: Provider,
  targetAccountId = accountId,
): ProviderAccountRecord {
  if (provider === "spotify") {
    return {
      accountId: targetAccountId,
      provider,
      tokenEnvelope: tokenVault.encrypt("spotify", targetAccountId, {
        accessToken: "stored-access",
        refreshToken: "stored-refresh",
        expiresAt: "2026-07-25T13:00:00.000Z",
      }),
      providerUserId: "spotify-user",
      displayName: "Spotify User",
    };
  }
  return {
    accountId: targetAccountId,
    provider,
    tokenEnvelope: tokenVault.encrypt("yandex", targetAccountId, {
      oauthToken: "stored-yandex-token",
    }),
    providerUserId: "12345",
    displayName: "Yandex User",
  };
}

describe("TfIntegrationsService", () => {
  it("stores Spotify exchange tokens encrypted and returns only account summary", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    const accessToken = `access-${randomUUID()}`;
    const refreshToken = `refresh-${randomUUID()}`;
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async exchangeCode() {
          return {
            secret: {
              accessToken,
              refreshToken,
              expiresAt: "2026-07-25T13:00:00.000Z",
            },
            account: {
              id: "spotify-user",
              displayName: "Spotify User",
            },
          };
        },
      }),
    );

    const result = await target.execute(
      command("spotify.oauth.complete", {
        code: "provider-code",
        callbackUri: "https://tf.apollot.ru/api/spotify/callback",
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      requestId,
      accountId,
      operation: "spotify.oauth.complete",
      result: {
        account: {
          provider: "spotify",
          connected: true,
          account: { id: "spotify-user", displayName: "Spotify User" },
        },
      },
    });
    const stored = repository.records.get(`${accountId}:spotify`)!;
    expect(JSON.stringify(stored.tokenEnvelope)).not.toContain(accessToken);
    expect(JSON.stringify(stored.tokenEnvelope)).not.toContain(refreshToken);
    expect(tokenVault.decrypt("spotify", accountId, stored.tokenEnvelope)).toEqual(
      {
        accessToken,
        refreshToken,
        expiresAt: "2026-07-25T13:00:00.000Z",
      },
    );
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain(refreshToken);
  });

  it("refreshes and persists Spotify tokens before a library result", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    const expiring: SpotifySecret = {
      accessToken: "expiring-access",
      refreshToken: "stored-refresh",
      expiresAt: "2026-07-25T12:00:30.000Z",
    };
    repository.records.set(`${accountId}:spotify`, {
      accountId,
      provider: "spotify",
      tokenEnvelope: tokenVault.encrypt("spotify", accountId, expiring),
      providerUserId: "spotify-user",
      displayName: "Spotify User",
    });
    const refreshed: SpotifySecret = {
      accessToken: "refreshed-access",
      refreshToken: "stored-refresh",
      expiresAt: "2026-07-25T13:00:00.000Z",
    };
    const events: string[] = [];
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async refresh(secret) {
          events.push(`refresh:${secret.accessToken}`);
          return { refreshed: true, secret: refreshed };
        },
        async likedTracks(input) {
          const persisted = repository.records.get(`${accountId}:spotify`)!;
          expect(
            tokenVault.decrypt("spotify", accountId, persisted.tokenEnvelope),
          ).toEqual(refreshed);
          events.push(`liked:${input.accessToken}`);
          return {
            offset: input.offset,
            limit: input.limit,
            total: 1,
            tracks: [normalizedTrack],
          };
        },
      }),
    );

    const result = await target.execute(
      command("spotify.liked.list", { offset: 0, limit: 1 }),
    );

    expect(events).toEqual([
      "refresh:expiring-access",
      "liked:refreshed-access",
    ]);
    expect(repository.events).toEqual([
      `get:${accountId}:spotify`,
      `upsert:${accountId}:spotify`,
    ]);
    expect(result).toMatchObject({
      operation: "spotify.liked.list",
      result: { total: 1, tracks: [normalizedTrack] },
    });
  });

  it("returns disconnected without a stored provider account", async () => {
    const repository = new MemoryRepository();
    const target = service(repository, vault());

    await expect(
      target.execute(command("spotify.status", {})),
    ).resolves.toMatchObject({
      operation: "spotify.status",
      result: {
        account: { provider: "spotify", connected: false },
      },
    });
    await expect(
      target.execute(command("yandex.status", {})),
    ).resolves.toMatchObject({
      operation: "yandex.status",
      result: {
        account: { provider: "yandex", connected: false },
      },
    });
  });

  it("disconnects only the signed command account", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    repository.records.set(
      `${otherAccountId}:spotify`,
      storedRecord(tokenVault, "spotify", otherAccountId),
    );
    const target = service(repository, tokenVault);

    await expect(
      target.execute(command("spotify.disconnect", {})),
    ).resolves.toMatchObject({
      accountId,
      operation: "spotify.disconnect",
      result: { ok: true },
    });

    expect(repository.records.has(`${accountId}:spotify`)).toBe(false);
    expect(repository.records.has(`${otherAccountId}:spotify`)).toBe(true);
    expect(repository.events).toEqual([`delete:${accountId}:spotify`]);
  });

  it("validates and encrypts a Yandex legacy token before returning summary", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    const oauthToken = `legacy-oauth-${randomUUID()}`;
    const events: string[] = [];
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter(),
      yandexAdapter({
        async validateToken(input) {
          events.push(`validated:${input.oauthToken}`);
          return { id: "12345", displayName: "Yandex User" };
        },
      }),
    );

    const result = await target.execute(
      command("yandex.token.upsert", { token: oauthToken }),
    );

    expect(events).toEqual([`validated:${oauthToken}`]);
    expect(result).toMatchObject({
      operation: "yandex.token.upsert",
      result: {
        account: {
          provider: "yandex",
          connected: true,
          account: { id: "12345", displayName: "Yandex User" },
        },
      },
    });
    const stored = repository.records.get(`${accountId}:yandex`)!;
    expect(JSON.stringify(stored.tokenEnvelope)).not.toContain(oauthToken);
    expect(tokenVault.decrypt("yandex", accountId, stored.tokenEnvelope)).toEqual(
      { oauthToken },
    );
    expect(JSON.stringify(result)).not.toContain(oauthToken);
  });

  it("routes every documented operation and rejects operation/result mismatches", async () => {
    const providerCalls: string[] = [];
    const spotify = spotifyAdapter({
      authorizationUrl(input) {
        providerCalls.push("spotify.oauth.authorize");
        return `https://accounts.spotify.com/authorize?client_id=client&response_type=code&redirect_uri=${encodeURIComponent(input.callbackUri)}&state=${input.state}&scope=user-library-read`;
      },
      async exchangeCode() {
        providerCalls.push("spotify.oauth.complete");
        return spotifyAdapter().exchangeCode({
          code: "unused",
          callbackUri: "https://tf.apollot.ru/api/spotify/callback",
        });
      },
      async refresh(secret) {
        providerCalls.push("spotify.refresh");
        return { refreshed: false, secret };
      },
      async likedTracks(input) {
        providerCalls.push("spotify.liked.list");
        return spotifyAdapter().likedTracks(input);
      },
      async playlists(input) {
        providerCalls.push("spotify.playlists.list");
        return spotifyAdapter().playlists(input);
      },
      async playlistTracks(input) {
        providerCalls.push("spotify.playlist-tracks.list");
        return spotifyAdapter().playlistTracks(input);
      },
      async topTracks(input) {
        providerCalls.push("spotify.top-tracks.list");
        return spotifyAdapter().topTracks(input);
      },
    });
    const yandex = yandexAdapter({
      async validateToken() {
        providerCalls.push("yandex.token.upsert");
        return { id: "12345", displayName: "Yandex User" };
      },
      async likedTracks(input) {
        providerCalls.push("yandex.liked.list");
        return yandexAdapter().likedTracks(input);
      },
      async playlists(input) {
        providerCalls.push("yandex.playlists.list");
        return yandexAdapter().playlists(input);
      },
      async playlistTracks(input) {
        providerCalls.push("yandex.playlist-tracks.list");
        return yandexAdapter().playlistTracks(input);
      },
    });
    const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
      [
        "spotify.oauth.authorize",
        {
          state: "state",
          callbackUri: "https://tf.apollot.ru/api/spotify/callback",
        },
      ],
      [
        "spotify.oauth.complete",
        {
          code: "code",
          callbackUri: "https://tf.apollot.ru/api/spotify/callback",
        },
      ],
      ["spotify.status", {}],
      ["spotify.disconnect", {}],
      ["spotify.liked.list", { offset: 0, limit: 1 }],
      ["spotify.playlists.list", {}],
      [
        "spotify.playlist-tracks.list",
        { playlistId: "playlist", offset: 0, limit: 1 },
      ],
      ["spotify.top-tracks.list", { timeRange: "medium_term" }],
      ["yandex.token.upsert", { token: "yandex-token" }],
      ["yandex.status", {}],
      ["yandex.disconnect", {}],
      ["yandex.liked.list", { offset: 0, limit: 1 }],
      ["yandex.playlists.list", {}],
      [
        "yandex.playlist-tracks.list",
        { uid: 12345, kind: 8, offset: 0, limit: 1 },
      ],
    ];
    const operations: string[] = [];
    for (const [operation, input] of cases) {
      const tokenVault = vault();
      const repository = new MemoryRepository();
      repository.deleteRecords = false;
      repository.records.set(
        `${accountId}:spotify`,
        storedRecord(tokenVault, "spotify"),
      );
      repository.records.set(
        `${accountId}:yandex`,
        storedRecord(tokenVault, "yandex"),
      );
      const response = await service(
        repository,
        tokenVault,
        spotify,
        yandex,
      ).execute(command(operation, input));
      expect(response).not.toHaveProperty("error");
      operations.push(response.operation);
    }

    expect(operations).toEqual(tfIntegrationOperationSchema.options);
    expect(providerCalls).toEqual([
      "spotify.oauth.authorize",
      "spotify.oauth.complete",
      "spotify.refresh",
      "spotify.liked.list",
      "spotify.refresh",
      "spotify.playlists.list",
      "spotify.refresh",
      "spotify.playlist-tracks.list",
      "spotify.refresh",
      "spotify.top-tracks.list",
      "yandex.token.upsert",
      "yandex.liked.list",
      "yandex.playlists.list",
      "yandex.playlist-tracks.list",
    ]);

    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    const mismatched = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async likedTracks() {
          return { tracks: [] } as never;
        },
      }),
    );
    await expect(
      mismatched.execute(
        command("spotify.liked.list", { offset: 0, limit: 1 }),
      ),
    ).resolves.toMatchObject({
      operation: "spotify.liked.list",
      error: { code: "invalid_provider_response" },
    });
  });

  it("never logs or returns token, code, credential, envelope key, or provider body canaries", async () => {
    const tokenCanary = `token-${randomUUID()}`;
    const codeCanary = `code-${randomUUID()}`;
    const credentialCanary = `credential-${randomUUID()}`;
    const keyCanary = `key-${randomUUID()}`;
    const bodyCanary = `body-${randomUUID()}`;
    const logged: unknown[] = [];
    const target = service(
      new MemoryRepository(),
      vault(keyCanary),
      spotifyAdapter({
        async exchangeCode() {
          throw new Error(
            `${tokenCanary}:${codeCanary}:${credentialCanary}:${keyCanary}:${bodyCanary}`,
          );
        },
      }),
      yandexAdapter(),
      {
        error(event, message) {
          logged.push(event, message);
        },
      },
    );

    const result = await target.execute(
      command("spotify.oauth.complete", {
        code: codeCanary,
        callbackUri: "https://tf.apollot.ru/api/spotify/callback",
      }),
    );
    const exposed = JSON.stringify({ result, logged });

    expect(result).toMatchObject({
      operation: "spotify.oauth.complete",
      error: { code: "provider_unavailable" },
    });
    expect(exposed).not.toContain(tokenCanary);
    expect(exposed).not.toContain(codeCanary);
    expect(exposed).not.toContain(credentialCanary);
    expect(exposed).not.toContain(keyCanary);
    expect(exposed).not.toContain(bodyCanary);
  });
});
