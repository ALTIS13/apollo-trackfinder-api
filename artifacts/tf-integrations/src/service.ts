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
  ProviderAccountWrite,
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
    readonly signal?: AbortSignal;
  }): Promise<SpotifyExchangeResult>;
  refresh(
    secret: SpotifySecret,
    context: { readonly signal: AbortSignal },
  ): Promise<SpotifyRefreshResult>;
  likedTracks(input: {
    readonly accessToken: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<TracksPage>;
  playlists(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<SpotifyPlaylistsResult>;
  playlistTracks(input: {
    readonly accessToken: string;
    readonly playlistId: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<TracksPage>;
  topTracks(input: {
    readonly accessToken: string;
    readonly timeRange: "short_term" | "medium_term" | "long_term";
    readonly signal?: AbortSignal;
  }): Promise<SpotifyTracksResult>;
}

export interface YandexProviderAdapter {
  validateToken(input: {
    readonly oauthToken: string;
    readonly signal?: AbortSignal;
  }): Promise<YandexAccount>;
  likedTracks(input: {
    readonly oauthToken: string;
    readonly userId: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<YandexTracksPage>;
  playlists(input: {
    readonly oauthToken: string;
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): Promise<YandexPlaylistsResult>;
  playlistTracks(input: {
    readonly oauthToken: string;
    readonly uid: number;
    readonly kind: number;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<YandexTracksPage>;
}

export interface TfIntegrationsServiceOptions {
  readonly repository: ProviderAccountRepository;
  readonly tokenVault: ProviderTokenVault;
  readonly spotify: SpotifyProviderAdapter;
  readonly yandex: YandexProviderAdapter;
  readonly logger?: IntegrationsLogger;
  readonly providerConcurrency?: number;
  readonly providerQueueLimit?: number;
}

export interface TfIntegrationsExecutionContext {
  readonly signal: AbortSignal;
}

const DEFAULT_PROVIDER_CONCURRENCY = 8;
const DEFAULT_PROVIDER_QUEUE_LIMIT = 24;
const MAX_PROVIDER_CONCURRENCY = 32;
const inertSignal = new AbortController().signal;

interface ProviderWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

function providerCapacityError(): Error {
  return new Error("Provider capacity unavailable");
}

class ProviderIoLimiter {
  readonly #concurrency: number;
  readonly #queueLimit: number;
  readonly #queue: ProviderWaiter[] = [];
  #active = 0;

  constructor(concurrency: number, queueLimit: number) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_PROVIDER_CONCURRENCY ||
      !Number.isSafeInteger(queueLimit) ||
      queueLimit < 0 ||
      queueLimit > MAX_PROVIDER_CONCURRENCY
    ) {
      throw new Error("Invalid provider concurrency configuration");
    }
    this.#concurrency = concurrency;
    this.#queueLimit = queueLimit;
  }

  async run<T>(
    signal: AbortSignal,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const release = await this.#acquire(signal);
    try {
      if (signal.aborted) throw providerCapacityError();
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(providerCapacityError());
    }
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#queue.length >= this.#queueLimit) {
      return Promise.reject(providerCapacityError());
    }

    return new Promise((resolve, reject) => {
      const waiter: ProviderWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(providerCapacityError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#startNext();
    };
  }

  #startNext(): void {
    while (
      this.#active < this.#concurrency &&
      this.#queue.length > 0
    ) {
      const waiter = this.#queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(providerCapacityError());
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
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
  readonly #providerLimiter: ProviderIoLimiter;

  constructor(options: TfIntegrationsServiceOptions) {
    this.#repository = options.repository;
    this.#tokenVault = options.tokenVault;
    this.#spotify = options.spotify;
    this.#yandex = options.yandex;
    this.#logger = options.logger ?? noopIntegrationsLogger;
    this.#providerLimiter = new ProviderIoLimiter(
      options.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY,
      options.providerQueueLimit ?? DEFAULT_PROVIDER_QUEUE_LIMIT,
    );
  }

  async execute(
    command: TfIntegrationsCommand,
    context: TfIntegrationsExecutionContext = { signal: inertSignal },
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse> {
    try {
      switch (command.operation) {
        case "spotify.oauth.authorize":
          return this.#success(command, {
            authorizationUrl: this.#spotify.authorizationUrl(command.input),
          });

        case "spotify.oauth.complete": {
          const exchange = await this.#provider(context.signal, () =>
            this.#spotify.exchangeCode({
              ...command.input,
              signal: context.signal,
            }),
          );
          const response = this.#success(command, {
            account: this.#connectedSpotifyAccount(exchange.account),
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
          return await this.#status(command, "spotify");

        case "spotify.disconnect":
          await this.#delete(command.accountId, "spotify");
          return this.#success(command, { ok: true });

        case "spotify.liked.list": {
          const secret = await this.#refreshedSpotifySecret(
            command.accountId,
            context.signal,
          );
          const result = await this.#provider(context.signal, () =>
            this.#spotify.likedTracks({
              accessToken: secret.accessToken,
              ...command.input,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "spotify.playlists.list": {
          const secret = await this.#refreshedSpotifySecret(
            command.accountId,
            context.signal,
          );
          const result = await this.#provider(context.signal, () =>
            this.#spotify.playlists({
              accessToken: secret.accessToken,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "spotify.playlist-tracks.list": {
          const secret = await this.#refreshedSpotifySecret(
            command.accountId,
            context.signal,
          );
          const result = await this.#provider(context.signal, () =>
            this.#spotify.playlistTracks({
              accessToken: secret.accessToken,
              ...command.input,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "spotify.top-tracks.list": {
          const secret = await this.#refreshedSpotifySecret(
            command.accountId,
            context.signal,
          );
          const result = await this.#provider(context.signal, () =>
            this.#spotify.topTracks({
              accessToken: secret.accessToken,
              ...command.input,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.token.upsert": {
          const account = await this.#provider(context.signal, () =>
            this.#yandex.validateToken({
              oauthToken: command.input.token,
              signal: context.signal,
            }),
          );
          const response = this.#success(command, {
            account: this.#connectedYandexAccount(account),
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
            providerLogin: account.login,
          });
          return response;
        }

        case "yandex.status":
          return await this.#status(command, "yandex");

        case "yandex.disconnect":
          await this.#delete(command.accountId, "yandex");
          return this.#success(command, { ok: true });

        case "yandex.liked.list": {
          const { record, secret } = await this.#yandexAccount(
            command.accountId,
          );
          const result = await this.#provider(context.signal, () =>
            this.#yandex.likedTracks({
              oauthToken: secret.oauthToken,
              userId: record.providerUserId,
              ...command.input,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.playlists.list": {
          const { record, secret } = await this.#yandexAccount(
            command.accountId,
          );
          const result = await this.#provider(context.signal, () =>
            this.#yandex.playlists({
              oauthToken: secret.oauthToken,
              userId: record.providerUserId,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.playlist-tracks.list": {
          const { secret } = await this.#yandexAccount(command.accountId);
          const result = await this.#provider(context.signal, () =>
            this.#yandex.playlistTracks({
              oauthToken: secret.oauthToken,
              ...command.input,
              signal: context.signal,
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

  #connectedSpotifyAccount(
    account: Readonly<{ id: string; displayName: string }>,
  ) {
    return {
      provider: "spotify" as const,
      connected: true as const,
      account: { id: account.id, displayName: account.displayName },
    };
  }

  #connectedYandexAccount(
    account: Readonly<{ id: string; login: string; displayName: string }>,
  ) {
    return {
      provider: "yandex" as const,
      connected: true as const,
      account: {
        id: account.id,
        login: account.login,
        displayName: account.displayName,
      },
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
    if (
      record !== null &&
      provider === "yandex" &&
      record.providerLogin === undefined
    ) {
      throw new ServiceError("invalid_provider_response");
    }
    return this.#success(command, {
      account:
        record === null
          ? { provider, connected: false }
          : provider === "spotify"
            ? this.#connectedSpotifyAccount({
                id: record.providerUserId,
                displayName: record.displayName,
              })
            : this.#connectedYandexAccount({
                id: record.providerUserId,
                login: record.providerLogin!,
                displayName: record.displayName,
              }),
    });
  }

  async #refreshedSpotifySecret(
    accountId: string,
    signal: AbortSignal,
  ): Promise<SpotifySecret> {
    const record = await this.#requiredRecord(accountId, "spotify");
    const secret = this.#decryptSpotify(accountId, record);
    const refresh = await this.#provider(signal, () =>
      this.#spotify.refresh(secret, { signal }),
    );
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
    const updated = await this.#updateTokenEnvelopeIfGeneration(
      accountId,
      "spotify",
      record.generation,
      tokenEnvelope,
    );
    if (!updated) {
      throw new ServiceError("not_connected");
    }
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

  async #upsert(record: ProviderAccountWrite): Promise<void> {
    try {
      await this.#repository.upsert(record);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
  }

  async #updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: ProviderAccountRecord["tokenEnvelope"],
  ): Promise<boolean> {
    try {
      return await this.#repository.updateTokenEnvelopeIfGeneration(
        accountId,
        provider,
        generation,
        tokenEnvelope,
      );
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

  async #provider<T>(
    signal: AbortSignal,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await this.#providerLimiter.run(signal, operation);
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
  context?: TfIntegrationsExecutionContext,
): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse> {
  return service.execute(command, context);
}
