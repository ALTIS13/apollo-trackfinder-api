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
  TfIntegrationsCommandContext,
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
const initialGeneration = "11111111-1111-4111-8111-111111111111";

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
  readonly mutationContexts: TfIntegrationsCommandContext[] = [];
  deleteRecords = true;
  generation = 1;

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

  async upsert(
    record: Omit<ProviderAccountRecord, "generation">,
    context: TfIntegrationsCommandContext,
  ): Promise<void> {
    this.events.push(`upsert:${record.accountId}:${record.provider}`);
    this.mutationContexts.push(context);
    const generation = `${String(this.generation).padStart(8, "0")}-0000-4000-8000-000000000001`;
    this.generation += 1;
    this.records.set(this.key(record.accountId, record.provider), {
      ...record,
      generation,
    });
  }

  async updateTokenEnvelopeIfGeneration(
    account: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: ProviderAccountRecord["tokenEnvelope"],
    context: TfIntegrationsCommandContext,
  ): Promise<boolean> {
    const key = this.key(account, provider);
    const current = this.records.get(key);
    const matched = current?.generation === generation;
    this.events.push(`cas:${account}:${provider}:${String(matched)}`);
    this.mutationContexts.push(context);
    if (matched) {
      this.records.set(key, { ...current, tokenEnvelope });
    }
    return matched;
  }

  async delete(
    account: string,
    provider: Provider,
    context: TfIntegrationsCommandContext,
  ): Promise<boolean> {
    this.events.push(`delete:${account}:${provider}`);
    this.mutationContexts.push(context);
    if (!this.deleteRecords) {
      return this.records.has(this.key(account, provider));
    }
    return this.records.delete(this.key(account, provider));
  }

  async isMigrationCurrent(): Promise<boolean> {
    return true;
  }
}

function executionContext(
  controller = new AbortController(),
  deadlineAt = Date.now() + 5_000,
): TfIntegrationsCommandContext {
  return { signal: controller.signal, deadlineAt };
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
      return {
        id: "12345",
        login: "yandex-user",
        displayName: "Yandex User",
      };
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
  limits: Partial<
    Pick<
      ConstructorParameters<typeof TfIntegrationsService>[0],
      "providerConcurrency" | "providerQueueLimit"
    >
  > = {},
): TfIntegrationsService {
  return new TfIntegrationsService({
    repository,
    tokenVault,
    spotify,
    yandex,
    logger,
    ...limits,
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
      generation: initialGeneration,
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
    generation: initialGeneration,
    tokenEnvelope: tokenVault.encrypt("yandex", targetAccountId, {
      oauthToken: "stored-yandex-token",
    }),
    providerUserId: "12345",
    providerLogin: "yandex-user",
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
    expect(
      tokenVault.decrypt("spotify", accountId, stored.tokenEnvelope),
    ).toEqual({
      accessToken,
      refreshToken,
      expiresAt: "2026-07-25T13:00:00.000Z",
    });
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
      generation: initialGeneration,
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
      `cas:${accountId}:spotify:true`,
    ]);
    expect(result).toMatchObject({
      operation: "spotify.liked.list",
      result: { total: 1, tracks: [normalizedTrack] },
    });
  });

  it("never restores a disconnected row when an in-flight refresh completes", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    let finishRefresh: ((value: SpotifySecret) => void) | undefined;
    let refreshStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const likedCalls: string[] = [];
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async refresh() {
          refreshStarted?.();
          const secret = await new Promise<SpotifySecret>((resolve) => {
            finishRefresh = resolve;
          });
          return { refreshed: true, secret };
        },
        async likedTracks(input) {
          likedCalls.push(input.accessToken);
          return { offset: 0, limit: 1, total: 0, tracks: [] };
        },
      }),
    );

    const pending = target.execute(
      command("spotify.liked.list", { offset: 0, limit: 1 }),
    );
    await started;
    await target.execute(command("spotify.disconnect", {}));
    finishRefresh?.({
      accessToken: "stale-refreshed-access",
      refreshToken: "stored-refresh",
      expiresAt: "2026-07-25T14:00:00.000Z",
    });

    await expect(pending).resolves.toMatchObject({
      operation: "spotify.liked.list",
      error: { code: "not_connected" },
    });
    expect(repository.records.has(`${accountId}:spotify`)).toBe(false);
    expect(likedCalls).toEqual([]);
    expect(repository.events).toContain(`cas:${accountId}:spotify:false`);
  });

  it("never overwrites a reconnected row when an older refresh completes", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    let finishRefresh: ((value: SpotifySecret) => void) | undefined;
    let refreshStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async refresh() {
          refreshStarted?.();
          const secret = await new Promise<SpotifySecret>((resolve) => {
            finishRefresh = resolve;
          });
          return { refreshed: true, secret };
        },
      }),
    );

    const pending = target.execute(
      command("spotify.liked.list", { offset: 0, limit: 1 }),
    );
    await started;
    await target.execute(
      command("spotify.oauth.complete", {
        code: "new-connection-code",
        callbackUri: "https://tf.apollot.ru/api/spotify/callback",
      }),
    );
    const replacement = repository.records.get(`${accountId}:spotify`)!;
    const replacementSecret = tokenVault.decrypt(
      "spotify",
      accountId,
      replacement.tokenEnvelope,
    );
    finishRefresh?.({
      accessToken: "stale-refreshed-access",
      refreshToken: "stored-refresh",
      expiresAt: "2026-07-25T14:00:00.000Z",
    });

    await expect(pending).resolves.toMatchObject({
      operation: "spotify.liked.list",
      error: { code: "not_connected" },
    });
    expect(repository.records.get(`${accountId}:spotify`)).toEqual(replacement);
    expect(replacement.generation).not.toBe(initialGeneration);
    expect(replacementSecret).toMatchObject({
      accessToken: "spotify-access",
      refreshToken: "spotify-refresh",
    });
  });

  it("propagates one command abort signal through refresh and provider I/O", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    const controller = new AbortController();
    const received: AbortSignal[] = [];
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async refresh(secret, context) {
          received.push(context.signal);
          return { refreshed: false, secret };
        },
        async likedTracks(input) {
          expect(input.signal).toBeDefined();
          received.push(input.signal!);
          return {
            offset: input.offset,
            limit: input.limit,
            total: 0,
            tracks: [],
          };
        },
      }),
    );

    await expect(
      target.execute(
        command("spotify.liked.list", { offset: 0, limit: 1 }),
        executionContext(controller),
      ),
    ).resolves.toMatchObject({
      operation: "spotify.liked.list",
      result: { total: 0 },
    });
    expect(received).toEqual([controller.signal, controller.signal]);
  });

  it("does not upsert credentials after either provider boundary aborts", async () => {
    const spotifyController = new AbortController();
    const spotifyRepository = new MemoryRepository();
    const spotifyTarget = service(
      spotifyRepository,
      vault(),
      spotifyAdapter({
        async exchangeCode() {
          spotifyController.abort();
          return {
            secret: {
              accessToken: "cancelled-access",
              refreshToken: "cancelled-refresh",
              expiresAt: "2026-07-25T13:00:00.000Z",
            },
            account: {
              id: "cancelled-spotify-user",
              displayName: "Cancelled Spotify User",
            },
          };
        },
      }),
    );

    await expect(
      spotifyTarget.execute(
        command("spotify.oauth.complete", {
          code: "cancelled-code",
          callbackUri: "https://tf.apollot.ru/api/spotify/callback",
        }),
        executionContext(spotifyController),
      ),
    ).resolves.toMatchObject({
      operation: "spotify.oauth.complete",
      error: { code: "provider_unavailable" },
    });
    expect(spotifyRepository.records.size).toBe(0);
    expect(spotifyRepository.events).toEqual([]);

    const yandexController = new AbortController();
    const yandexRepository = new MemoryRepository();
    const yandexTarget = service(
      yandexRepository,
      vault(),
      spotifyAdapter(),
      yandexAdapter({
        async validateToken() {
          yandexController.abort();
          return {
            id: "cancelled-yandex-user",
            login: "cancelled-login",
            displayName: "Cancelled Yandex User",
          };
        },
      }),
    );

    await expect(
      yandexTarget.execute(
        command("yandex.token.upsert", { token: "cancelled-token" }),
        executionContext(yandexController),
      ),
    ).resolves.toMatchObject({
      operation: "yandex.token.upsert",
      error: { code: "provider_unavailable" },
    });
    expect(yandexRepository.records.size).toBe(0);
    expect(yandexRepository.events).toEqual([]);
  });

  it("keeps disconnect records when cancellation or the absolute deadline arrives first", async () => {
    const tokenVault = vault();
    const spotifyRepository = new MemoryRepository();
    spotifyRepository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      service(spotifyRepository, tokenVault).execute(
        command("spotify.disconnect", {}),
        executionContext(cancelled),
      ),
    ).resolves.toMatchObject({
      operation: "spotify.disconnect",
      error: { code: "provider_unavailable" },
    });
    expect(spotifyRepository.records.has(`${accountId}:spotify`)).toBe(true);
    expect(spotifyRepository.events).toEqual([]);

    const yandexRepository = new MemoryRepository();
    yandexRepository.records.set(
      `${accountId}:yandex`,
      storedRecord(tokenVault, "yandex"),
    );
    await expect(
      service(yandexRepository, tokenVault).execute(
        command("yandex.disconnect", {}),
        executionContext(new AbortController(), Date.now() - 1),
      ),
    ).resolves.toMatchObject({
      operation: "yandex.disconnect",
      error: { code: "provider_unavailable" },
    });
    expect(yandexRepository.records.has(`${accountId}:yandex`)).toBe(true);
    expect(yandexRepository.events).toEqual([]);
  });

  it("does not persist an in-flight refresh after its provider boundary aborts", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    const original = storedRecord(tokenVault, "spotify");
    repository.records.set(`${accountId}:spotify`, original);
    const controller = new AbortController();
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async refresh() {
          controller.abort();
          return {
            refreshed: true,
            secret: {
              accessToken: "cancelled-refreshed-access",
              refreshToken: "cancelled-refreshed-refresh",
              expiresAt: "2026-07-25T14:00:00.000Z",
            },
          };
        },
      }),
    );

    await expect(
      target.execute(
        command("spotify.liked.list", { offset: 0, limit: 1 }),
        executionContext(controller),
      ),
    ).resolves.toMatchObject({
      operation: "spotify.liked.list",
      error: { code: "provider_unavailable" },
    });
    expect(repository.records.get(`${accountId}:spotify`)).toEqual(original);
    expect(repository.events).toEqual([`get:${accountId}:spotify`]);
  });

  it("passes the exact command context through every repository mutation path", async () => {
    const context = executionContext();
    const tokenVault = vault();

    const upsertRepository = new MemoryRepository();
    await service(upsertRepository, tokenVault).execute(
      command("spotify.oauth.complete", {
        code: "provider-code",
        callbackUri: "https://tf.apollot.ru/api/spotify/callback",
      }),
      context,
    );

    const deleteRepository = new MemoryRepository();
    deleteRepository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    await service(deleteRepository, tokenVault).execute(
      command("spotify.disconnect", {}),
      context,
    );

    const refreshRepository = new MemoryRepository();
    refreshRepository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    await service(
      refreshRepository,
      tokenVault,
      spotifyAdapter({
        async refresh() {
          return {
            refreshed: true,
            secret: {
              accessToken: "refreshed-access",
              refreshToken: "refreshed-refresh",
              expiresAt: "2026-07-25T14:00:00.000Z",
            },
          };
        },
      }),
    ).execute(command("spotify.liked.list", { offset: 0, limit: 1 }), context);

    expect([
      ...upsertRepository.mutationContexts,
      ...deleteRepository.mutationContexts,
      ...refreshRepository.mutationContexts,
    ]).toEqual([context, context, context]);
  });

  it("bounds provider I/O concurrency and queues only a finite command backlog", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(
      `${accountId}:spotify`,
      storedRecord(tokenVault, "spotify"),
    );
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstTwoStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstTwoStarted = resolve;
    });
    const target = service(
      repository,
      tokenVault,
      spotifyAdapter({
        async likedTracks(input) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (active === 2) firstTwoStarted?.();
          await blocked;
          active -= 1;
          return {
            offset: input.offset,
            limit: input.limit,
            total: 0,
            tracks: [],
          };
        },
      }),
      yandexAdapter(),
      undefined,
      { providerConcurrency: 2, providerQueueLimit: 2 },
    );

    const commands = Array.from({ length: 3 }, () =>
      target.execute(
        command("spotify.liked.list", { offset: 0, limit: 1 }),
        executionContext(),
      ),
    );
    await started;
    expect(maximumActive).toBe(2);
    release?.();
    await expect(Promise.all(commands)).resolves.toHaveLength(3);
    expect(maximumActive).toBe(2);
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
          return {
            id: "12345",
            login: "yandex-user",
            displayName: "Yandex User",
          };
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
          account: {
            id: "12345",
            login: "yandex-user",
            displayName: "Yandex User",
          },
        },
      },
    });
    const stored = repository.records.get(`${accountId}:yandex`)!;
    expect(JSON.stringify(stored.tokenEnvelope)).not.toContain(oauthToken);
    expect(stored.providerLogin).toBe("yandex-user");
    expect(
      tokenVault.decrypt("yandex", accountId, stored.tokenEnvelope),
    ).toEqual({ oauthToken });
    expect(JSON.stringify(result)).not.toContain(oauthToken);

    await expect(
      target.execute(command("yandex.status", {})),
    ).resolves.toMatchObject({
      operation: "yandex.status",
      result: {
        account: {
          provider: "yandex",
          connected: true,
          account: {
            id: "12345",
            login: "yandex-user",
            displayName: "Yandex User",
          },
        },
      },
    });
  });

  it("fails closed when legacy stored Yandex metadata has no login", async () => {
    const tokenVault = vault();
    const repository = new MemoryRepository();
    repository.records.set(`${accountId}:yandex`, {
      accountId,
      provider: "yandex",
      generation: initialGeneration,
      tokenEnvelope: tokenVault.encrypt("yandex", accountId, {
        oauthToken: "stored-yandex-token",
      }),
      providerUserId: "12345",
      displayName: "Yandex User",
    });
    const target = service(repository, tokenVault);

    await expect(
      target.execute(command("yandex.status", {})),
    ).resolves.toMatchObject({
      operation: "yandex.status",
      error: { code: "invalid_provider_response" },
    });
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
        return {
          id: "12345",
          login: "yandex-user",
          displayName: "Yandex User",
        };
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
