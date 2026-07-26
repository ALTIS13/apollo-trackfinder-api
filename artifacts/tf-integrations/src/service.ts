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
  TfIntegrationsCommandContext,
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

export type TfIntegrationsExecutionContext = TfIntegrationsCommandContext;

const DEFAULT_PROVIDER_CONCURRENCY = 8;
const DEFAULT_PROVIDER_QUEUE_LIMIT = 24;
const MAX_PROVIDER_CONCURRENCY = 32;
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const inertSignal = new AbortController().signal;

function defaultExecutionContext(): TfIntegrationsExecutionContext {
  return {
    signal: inertSignal,
    deadlineAt: Date.now() + DEFAULT_COMMAND_TIMEOUT_MS,
  };
}

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
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
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

function requireActive(context: TfIntegrationsExecutionContext): void {
  if (
    context.signal.aborted ||
    !Number.isSafeInteger(context.deadlineAt) ||
    Date.now() >= context.deadlineAt
  ) {
    throw new ServiceError("provider_unavailable");
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
    context: TfIntegrationsExecutionContext = defaultExecutionContext(),
  ): Promise<TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse> {
    try {
      requireActive(context);
      switch (command.operation) {
        case "spotify.oauth.authorize": {
          const authorizationUrl = this.#spotify.authorizationUrl(
            command.input,
          );
          requireActive(context);
          return this.#success(command, {
            authorizationUrl,
          });
        }

        case "spotify.oauth.complete": {
          const exchange = await this.#provider(context, () =>
            this.#spotify.exchangeCode({
              ...command.input,
              signal: context.signal,
            }),
          );
          const tokenEnvelope = this.#encryptSpotify(
            command.accountId,
            exchange.secret,
            context,
          );
          await this.#upsert(
            {
              accountId: command.accountId,
              provider: "spotify",
              tokenEnvelope,
              providerUserId: exchange.account.id,
              displayName: exchange.account.displayName,
            },
            context,
          );
          return this.#success(command, {
            account: this.#connectedSpotifyAccount(exchange.account),
          });
        }

        case "spotify.status":
          return await this.#status(command, "spotify", context);

        case "spotify.disconnect":
          await this.#delete(command.accountId, "spotify", context);
          return this.#success(command, { ok: true });

        case "spotify.liked.list": {
          const secret = await this.#refreshedSpotifySecret(
            command.accountId,
            context,
          );
          const result = await this.#provider(context, () =>
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
            context,
          );
          const result = await this.#provider(context, () =>
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
            context,
          );
          const result = await this.#provider(context, () =>
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
            context,
          );
          const result = await this.#provider(context, () =>
            this.#spotify.topTracks({
              accessToken: secret.accessToken,
              ...command.input,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.token.upsert": {
          const account = await this.#provider(context, () =>
            this.#yandex.validateToken({
              oauthToken: command.input.token,
              signal: context.signal,
            }),
          );
          const tokenEnvelope = this.#encryptYandex(
            command.accountId,
            {
              oauthToken: command.input.token,
            },
            context,
          );
          await this.#upsert(
            {
              accountId: command.accountId,
              provider: "yandex",
              tokenEnvelope,
              providerUserId: account.id,
              displayName: account.displayName,
              providerLogin: account.login,
            },
            context,
          );
          return this.#success(command, {
            account: this.#connectedYandexAccount(account),
          });
        }

        case "yandex.status":
          return await this.#status(command, "yandex", context);

        case "yandex.disconnect":
          await this.#delete(command.accountId, "yandex", context);
          return this.#success(command, { ok: true });

        case "yandex.liked.list": {
          const { record, secret } = await this.#yandexAccount(
            command.accountId,
            context,
          );
          const result = await this.#provider(context, () =>
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
            context,
          );
          const result = await this.#provider(context, () =>
            this.#yandex.playlists({
              oauthToken: secret.oauthToken,
              userId: record.providerUserId,
              signal: context.signal,
            }),
          );
          return this.#success(command, result);
        }

        case "yandex.playlist-tracks.list": {
          const { secret } = await this.#yandexAccount(
            command.accountId,
            context,
          );
          const result = await this.#provider(context, () =>
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
        error instanceof ServiceError ? error.code : providerErrorCode(error);
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
    context: TfIntegrationsExecutionContext,
  ): Promise<TfIntegrationsSuccessResponse> {
    const record = await this.#get(command.accountId, provider, context);
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
    context: TfIntegrationsExecutionContext,
  ): Promise<SpotifySecret> {
    const record = await this.#requiredRecord(accountId, "spotify", context);
    const secret = this.#decryptSpotify(accountId, record, context);
    const refresh = await this.#provider(context, () =>
      this.#spotify.refresh(secret, { signal: context.signal }),
    );
    if (
      !isObject(refresh) ||
      typeof refresh.refreshed !== "boolean" ||
      !isObject(refresh.secret)
    ) {
      throw new ServiceError("invalid_provider_response");
    }
    if (!refresh.refreshed) {
      requireActive(context);
      return secret;
    }
    const refreshedSecret = refresh.secret as SpotifySecret;
    const tokenEnvelope = this.#encryptSpotify(
      accountId,
      refreshedSecret,
      context,
    );
    const updated = await this.#updateTokenEnvelopeIfGeneration(
      accountId,
      "spotify",
      record.generation,
      tokenEnvelope,
      context,
    );
    if (!updated) {
      throw new ServiceError("not_connected");
    }
    return refreshedSecret;
  }

  async #yandexAccount(
    accountId: string,
    context: TfIntegrationsExecutionContext,
  ): Promise<{
    readonly record: ProviderAccountRecord;
    readonly secret: YandexSecret;
  }> {
    const record = await this.#requiredRecord(accountId, "yandex", context);
    return {
      record,
      secret: this.#decryptYandex(accountId, record, context),
    };
  }

  async #requiredRecord(
    accountId: string,
    provider: Provider,
    context: TfIntegrationsExecutionContext,
  ): Promise<ProviderAccountRecord> {
    const record = await this.#get(accountId, provider, context);
    if (record === null) {
      throw new ServiceError("not_connected");
    }
    return record;
  }

  async #get(
    accountId: string,
    provider: Provider,
    context: TfIntegrationsExecutionContext,
  ): Promise<ProviderAccountRecord | null> {
    requireActive(context);
    let record: ProviderAccountRecord | null;
    try {
      record = await this.#repository.get(accountId, provider);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
    return record;
  }

  async #upsert(
    record: ProviderAccountWrite,
    context: TfIntegrationsExecutionContext,
  ): Promise<void> {
    requireActive(context);
    try {
      await this.#repository.upsert(record, context);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
  }

  async #updateTokenEnvelopeIfGeneration(
    accountId: string,
    provider: Provider,
    generation: string,
    tokenEnvelope: ProviderAccountRecord["tokenEnvelope"],
    context: TfIntegrationsExecutionContext,
  ): Promise<boolean> {
    requireActive(context);
    let updated: boolean;
    try {
      updated = await this.#repository.updateTokenEnvelopeIfGeneration(
        accountId,
        provider,
        generation,
        tokenEnvelope,
        context,
      );
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
    return updated;
  }

  async #delete(
    accountId: string,
    provider: Provider,
    context: TfIntegrationsExecutionContext,
  ): Promise<void> {
    requireActive(context);
    try {
      await this.#repository.delete(accountId, provider, context);
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
  }

  #encryptSpotify(
    accountId: string,
    secret: SpotifySecret,
    context: TfIntegrationsExecutionContext,
  ) {
    requireActive(context);
    let tokenEnvelope: ProviderAccountRecord["tokenEnvelope"];
    try {
      tokenEnvelope = this.#tokenVault.encrypt("spotify", accountId, secret);
    } catch {
      throw new ServiceError("invalid_provider_response");
    }
    requireActive(context);
    return tokenEnvelope;
  }

  #encryptYandex(
    accountId: string,
    secret: YandexSecret,
    context: TfIntegrationsExecutionContext,
  ) {
    requireActive(context);
    let tokenEnvelope: ProviderAccountRecord["tokenEnvelope"];
    try {
      tokenEnvelope = this.#tokenVault.encrypt("yandex", accountId, secret);
    } catch {
      throw new ServiceError("invalid_provider_response");
    }
    requireActive(context);
    return tokenEnvelope;
  }

  #decryptSpotify(
    accountId: string,
    record: ProviderAccountRecord,
    context: TfIntegrationsExecutionContext,
  ): SpotifySecret {
    requireActive(context);
    let secret: SpotifySecret;
    try {
      secret = this.#tokenVault.decrypt(
        "spotify",
        accountId,
        record.tokenEnvelope,
      );
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
    return secret;
  }

  #decryptYandex(
    accountId: string,
    record: ProviderAccountRecord,
    context: TfIntegrationsExecutionContext,
  ): YandexSecret {
    requireActive(context);
    let secret: YandexSecret;
    try {
      secret = this.#tokenVault.decrypt(
        "yandex",
        accountId,
        record.tokenEnvelope,
      );
    } catch {
      throw new ServiceError("storage_unavailable");
    }
    requireActive(context);
    return secret;
  }

  async #provider<T>(
    context: TfIntegrationsExecutionContext,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    requireActive(context);
    let result: T;
    try {
      result = await this.#providerLimiter.run(context.signal, operation);
    } catch (error) {
      throw new ServiceError(providerErrorCode(error));
    }
    requireActive(context);
    return result;
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
