import {
  tfIntegrationsSuccessResponseSchema,
  type TfIntegrationsCommand,
  type TfIntegrationsErrorResponse,
  type TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";
import type {
  Provider,
  ProviderAccountRecord,
  ProviderAccountRepository,
} from "@workspace/tf-integrations-db";

import {
  noopIntegrationsLogger,
  type IntegrationsLogger,
  type TfIntegrationsErrorCode,
} from "./logger.js";
import type {
  SpotifyAccount,
  SpotifyExchangeResult,
  SpotifyPlaylistsResult,
  SpotifyRefreshResult,
  SpotifyTracksResult,
  TracksPage,
} from "./providers/spotify.js";
import type {
  YandexAccount,
  YandexPlaylistsResult,
  YandexTracksPage,
} from "./providers/yandex.js";
import {
  ProviderTokenVault,
  type SpotifySecret,
  type YandexSecret,
} from "./token-keyring.js";

export interface SpotifyProviderAdapter {
  authorizationUrl(input: {
    readonly state: string;
    readonly callbackUri: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly callbackUri: string;
  }): Promise<SpotifyExchangeResult>;
  refresh(secret: SpotifySecret): Promise<SpotifyRefreshResult>;
  likedTracks(input: {
    readonly accessToken: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<TracksPage>;
  playlists(input: {
    readonly accessToken: string;
  }): Promise<SpotifyPlaylistsResult>;
  playlistTracks(input: {
    readonly accessToken: string;
    readonly playlistId: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<TracksPage>;
  topTracks(input: {
    readonly accessToken: string;
    readonly timeRange: "short_term" | "medium_term" | "long_term";
  }): Promise<SpotifyTracksResult>;
}

export interface YandexProviderAdapter {
  validateToken(input: {
    readonly oauthToken: string;
  }): Promise<YandexAccount>;
  likedTracks(input: {
    readonly oauthToken: string;
    readonly userId: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<YandexTracksPage>;
  playlists(input: {
    readonly oauthToken: string;
    readonly userId: string;
  }): Promise<YandexPlaylistsResult>;
  playlistTracks(input: {
    readonly oauthToken: string;
    readonly uid: number;
    readonly kind: number;
    readonly offset: number;
    readonly limit: number;
  }): Promise<YandexTracksPage>;
}

export interface TfIntegrationsServiceOptions {
  readonly repository: ProviderAccountRepository;
  readonly tokenVault: ProviderTokenVault;
  readonly spotify: SpotifyProviderAdapter;
  readonly yandex: YandexProviderAdapter;
  readonly logger?: IntegrationsLogger;
}

class ServiceError extends Error {
  readonly code: TfIntegrationsErrorCode;

  constructor(code: TfIntegrationsErrorCode) {
    super("TF integrations command failed");
    this.name = "ServiceError";
    this.code = code;
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerErrorCode(error: unknown): TfIntegrationsErrorCode {
  if (
    isObject(error) &&
    (error.code === "provider_rejected" ||
      error.code === "provider_unavailable" ||
      error.code === "invalid_provider_response")
  ) {
    return error.code;
  }
  return "provider_unavailable";
}

export class TfIntegrationsService {
  readonly #repository: ProviderAccountRepository;
  readonly #tokenVault: ProviderTokenVault;
  readonly #spotify: SpotifyProviderAdapter;
  readonly #yandex: YandexProviderAdapter;
  readonly #logger: IntegrationsLogger;

  constructor(options: TfIntegrationsServiceOptions) {
    this.#repository = options.repository;
    this.#tokenVault = options.tokenVault;
    this.#spotify = options.spotify;
    this.#yandex = options.yandex;
    this.#logger = options.logger ?? noopIntegrationsLogger;
  }

  async execute(
    command: TfIntegrationsCommand,
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse> {
    try {
      switch (command.operation) {
        case "spotify.oauth.authorize":
          return this.#success(command, {
            authorizationUrl: this.#spotify.authorizationUrl(command.input),
          });

        case "spotify.oauth.complete": {
          const exchange = await this.#provider(() =>
            this.#spotify.exchangeCode(command.input),
          );
          const response = this.#success(command, {
            account: this.#connectedAccount("spotify", exchange.account),
          });
          const tokenEnvelope = this.#encryptSpotify(
            command.accountId,
            exchange.secret,
          );
          await this.#upsert({
            accountId: command.accountId,
            provider: "spotify",
            tokenEnvelope,
            providerUserId: exchange.account.id,
            displayName: exchange.account.displayName,
          });
          return response;
        }

        case "spotify.status":
          return this.#status(command, "spotify");

        case "spotify.disconnect":
          await this.#delete(command.accountId, "spotify");
          return this.#success(command, { ok: true });

        case "spotify.liked.list": {
          const secret = await this.#refreshedSpotifySecret(command.accountId);
          const result = await this.#provider(() =>
            this.#spotify.likedTracks({
              accessToken: secret.accessToken,
              ...command.input,
            }),
          );
          return this.#success(command, result);
        }

        case "spotify.playlists.list": {
          const secret = await this.#refreshedSpotifySecret(command.accountId);
          const result = await this.#provider(() =>
            this.#spotify.playlists({ accessToken: secret.accessToken }),
          );
          return this.#success(command, result);
        }

        case "spotify.playlist-tracks.list": {
          const secret = await this.#refreshedSpotifySecret(command.accountId);
          const result = await this.#provider(() =>
            this.#spotify.playlistTracks({
              accessToken: secret.accessToken,
              ...command.input,
            }),
          );
          return this.#success(command, result);
        }

        case "spotify.top-tracks.list": {
          const secret = await this.#refreshedSpotifySecret(command.accountId);
          const result = await this.#provider(() =>
            this.#spotify.topTracks({
              accessToken: secret.accessToken,
              ...command.input,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.token.upsert": {
          const account = await this.#provider(() =>
            this.#yandex.validateToken({ oauthToken: command.input.token }),
          );
          const response = this.#success(command, {
            account: this.#connectedAccount("yandex", account),
          });
          const tokenEnvelope = this.#encryptYandex(command.accountId, {
            oauthToken: command.input.token,
          });
          await this.#upsert({
            accountId: command.accountId,
            provider: "yandex",
            tokenEnvelope,
            providerUserId: account.id,
            displayName: account.displayName,
          });
          return response;
        }

        case "yandex.status":
          return this.#status(command, "yandex");

        case "yandex.disconnect":
          await this.#delete(command.accountId, "yandex");
          return this.#success(command, { ok: true });

        case "yandex.liked.list": {
          const { record, secret } = await this.#yandexAccount(
            command.accountId,
          );
          const result = await this.#provider(() =>
            this.#yandex.likedTracks({
              oauthToken: secret.oauthToken,
              userId: record.providerUserId,
              ...command.input,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.playlists.list": {
          const { record, secret } = await this.#yandexAccount(
            command.accountId,
          );
          const result = await this.#provider(() =>
            this.#yandex.playlists({
              oauthToken: secret.oauthToken,
              userId: record.providerUserId,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.playlist-tracks.list": {
          const { secret } = await this.#yandexAccount(command.accountId);
          const result = await this.#provider(() =>
            this.#yandex.playlistTracks({
              oauthToken: secret.oauthToken,
              ...command.input,
            }),
          );
          return this.#success(command, result);
        }

        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    } catch (error) {
      const code =
        error instanceof ServiceError
          ? error.code
          : providerErrorCode(error);
      this.#log(command.operation, code);
      return {
        schemaVersion: 1,
        requestId: command.requestId,
        accountId: command.accountId,
        operation: command.operation,
        error: { code },
      };
    }
  }

  #connectedAccount(
    provider: "spotify" | "yandex",
    account: Readonly<{ id: string; displayName: string }>,
  ) {
    return {
      provider,
      connected: true as const,
      account: { id: account.id, displayName: account.displayName },
    };
  }

  #success(
    command: TfIntegrationsCommand,
    result: unknown,
  ): TfIntegrationsSuccessResponse {
    const parsed = tfIntegrationsSuccessResponseSchema.safeParse({
      schemaVersion: 1,
      requestId: command.requestId,
      accountId: command.accountId,
      operation: command.operation,
      result,
    });
    if (!parsed.success) {
      throw new ServiceError("invalid_provider_response");
    }
    return parsed.data;
  }

  async #status(
    command: TfIntegrationsCommand,
    provider: Provider,
  ): Promise<TfIntegrationsSuccessResponse> {
    const record = await this.#get(command.accountId, provider);
    return this.#success(command, {
      account:
        record === null
          ? { provider, connected: false }
          : this.#connectedAccount(provider, {
              id: record.providerUserId,
              displayName: record.displayName,
            }),
    });
  }

  async #refreshedSpotifySecret(accountId: string): Promise<SpotifySecret> {
    const record = await this.#requiredRecord(accountId, "spotify");
    const secret = this.#decryptSpotify(accountId, record);
    const refresh = await this.#provider(() => this.#spotify.refresh(secret));
    if (
      !isObject(refresh) ||
      typeof refresh.refreshed !== "boolean" ||
      !isObject(refresh.secret)
    ) {
      throw new ServiceError("invalid_provider_response");
    }
    if (!refresh.refreshed) {
      return secret;
    }
    const refreshedSecret = refresh.secret as SpotifySecret;
    const tokenEnvelope = this.#encryptSpotify(accountId, refreshedSecret);
    await this.#upsert({ ...record, tokenEnvelope });
    return refreshedSecret;
  }

  async #yandexAccount(accountId: string): Promise<{
    readonly record: ProviderAccountRecord;
    readonly secret: YandexSecret;
  }> {
    const record = await this.#requiredRecord(accountId, "yandex");
    return {
      record,
      secret: this.#decryptYandex(accountId, record),
    };
  }

  async #requiredRecord(
    accountId: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord> {
    const record = await this.#get(accountId, provider);
    if (record === null) {
      throw new ServiceError("not_connected");
    }
    return record;
  }

  async #get(
    accountId: string,
    provider: Provider,
  ): Promise<ProviderAccountRecord | null> {
    try {
      return await this.#repository.get(accountId, provider);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  async #upsert(record: ProviderAccountRecord): Promise<void> {
    try {
      await this.#repository.upsert(record);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  async #delete(accountId: string, provider: Provider): Promise<void> {
    try {
      await this.#repository.delete(accountId, provider);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  #encryptSpotify(accountId: string, secret: SpotifySecret) {
    try {
      return this.#tokenVault.encrypt("spotify", accountId, secret);
    } catch {
      throw new ServiceError("invalid_provider_response");
    }
  }

  #encryptYandex(accountId: string, secret: YandexSecret) {
    try {
      return this.#tokenVault.encrypt("yandex", accountId, secret);
    } catch {
      throw new ServiceError("invalid_provider_response");
    }
  }

  #decryptSpotify(
    accountId: string,
    record: ProviderAccountRecord,
  ): SpotifySecret {
    try {
      return this.#tokenVault.decrypt(
        "spotify",
        accountId,
        record.tokenEnvelope,
      );
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  #decryptYandex(
    accountId: string,
    record: ProviderAccountRecord,
  ): YandexSecret {
    try {
      return this.#tokenVault.decrypt(
        "yandex",
        accountId,
        record.tokenEnvelope,
      );
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  async #provider<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new ServiceError(providerErrorCode(error));
    }
  }

  #log(
    operation: TfIntegrationsCommand["operation"],
    errorCode: TfIntegrationsErrorCode,
  ): void {
    try {
      this.#logger.error(
        { operation, errorCode },
        "TF integrations command failed",
      );
    } catch {
      // Logging must not alter command behavior.
    }
  }
}

export async function execute(
  service: TfIntegrationsService,
  command: TfIntegrationsCommand,
): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse> {
  return service.execute(command);
}
