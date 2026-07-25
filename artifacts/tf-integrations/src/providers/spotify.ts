import type {
  NormalizedTrack,
  SpotifyPlaylist,
} from "@workspace/tf-integrations-contract";

import type { SpotifySecret } from "../token-keyring.js";
import {
  ProviderHttpFailure,
  cancelProviderResponseBody,
  fetchProviderResponse,
  readBoundedProviderJson,
} from "./provider-http.js";

const ACCOUNTS_ORIGIN = "https://accounts.spotify.com";
const API_ORIGIN = "https://api.spotify.com";
const TOKEN_ENDPOINT = `${ACCOUNTS_ORIGIN}/api/token`;
const API_ROOT = `${API_ORIGIN}/v1`;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_OFFSET = 1_000_000;
const MAX_ITEMS = 50;
const MAX_TOTAL = 1_000_000;
const MAX_DURATION_MS = 86_400_000;
const PLAYLIST_FIELDS =
  "items(track(id,name,artists,album,duration_ms,external_urls)),total";
const SPOTIFY_SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

export type ProviderErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "invalid_provider_response";

export interface ProviderLogger {
  error(
    event: Readonly<{
      provider: "spotify";
      code: ProviderErrorCode;
      operation: SpotifyProviderOperation;
    }>,
    message: string,
  ): void;
}

type SpotifyProviderOperation =
  | "oauth.exchange"
  | "oauth.refresh"
  | "account.profile"
  | "liked.list"
  | "playlists.list"
  | "playlist-tracks.list"
  | "top-tracks.list";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super("Spotify provider request failed");
    this.name = "ProviderError";
    this.code = code;
  }
}

export interface SpotifyProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUri: string;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly logger?: ProviderLogger;
}

export interface SpotifyAccount {
  readonly id: string;
  readonly displayName: string;
}

export interface SpotifyExchangeResult {
  readonly secret: SpotifySecret;
  readonly account: SpotifyAccount;
}

export interface SpotifyRefreshResult {
  readonly refreshed: boolean;
  readonly secret: SpotifySecret;
}

export interface TracksPage {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly tracks: readonly NormalizedTrack[];
}

export interface SpotifyPlaylistsResult {
  readonly playlists: readonly SpotifyPlaylist[];
  readonly total: number;
}

export interface SpotifyTracksResult {
  readonly tracks: readonly NormalizedTrack[];
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= maxLength
    ? trimmed
    : undefined;
}

function boundedToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_TOKEN_LENGTH
    ? value
    : undefined;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function exactCallbackUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      value.length <= 4_096 &&
      parsed.protocol === "https:" &&
      parsed.pathname === "/api/spotify/callback" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function assertTextInput(value: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new ProviderError("provider_rejected");
  }
}

function assertTokenInput(value: string): void {
  if (boundedToken(value) === undefined) {
    throw new ProviderError("provider_rejected");
  }
}

function assertPagination(offset: number, limit: number): void {
  if (
    boundedInteger(offset, 0, MAX_OFFSET) === undefined ||
    boundedInteger(limit, 1, MAX_ITEMS) === undefined
  ) {
    throw new ProviderError("provider_rejected");
  }
}

function tokenResponse(
  value: unknown,
  requireRefreshToken: boolean,
): {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
} {
  if (!isObject(value)) {
    throw new ProviderError("invalid_provider_response");
  }
  const accessToken = boundedToken(value.access_token);
  const refreshToken =
    value.refresh_token === undefined
      ? undefined
      : boundedToken(value.refresh_token);
  const expiresIn = boundedInteger(value.expires_in, 1, 86_400);
  if (
    accessToken === undefined ||
    expiresIn === undefined ||
    (value.refresh_token !== undefined && refreshToken === undefined) ||
    (requireRefreshToken && refreshToken === undefined)
  ) {
    throw new ProviderError("invalid_provider_response");
  }
  return { accessToken, refreshToken, expiresIn };
}

function accountProfile(value: unknown): SpotifyAccount {
  if (!isObject(value)) {
    throw new ProviderError("invalid_provider_response");
  }
  const id = boundedText(value.id, MAX_IDENTIFIER_LENGTH);
  const displayName =
    value.display_name === null || value.display_name === undefined
      ? id
      : boundedText(value.display_name, 500);
  if (id === undefined || displayName === undefined) {
    throw new ProviderError("invalid_provider_response");
  }
  return { id, displayName };
}

function normalizedTrack(value: unknown): NormalizedTrack {
  if (!isObject(value)) {
    throw new ProviderError("invalid_provider_response");
  }
  const id = boundedText(value.id, MAX_IDENTIFIER_LENGTH);
  const title = boundedText(value.name, 500);
  const durationMs = boundedInteger(value.duration_ms, 0, MAX_DURATION_MS);
  if (
    id === undefined ||
    title === undefined ||
    durationMs === undefined ||
    !Array.isArray(value.artists) ||
    value.artists.length < 1 ||
    value.artists.length > MAX_ITEMS ||
    !isObject(value.album) ||
    !Array.isArray(value.album.images) ||
    value.album.images.length > MAX_ITEMS ||
    !isObject(value.external_urls)
  ) {
    throw new ProviderError("invalid_provider_response");
  }

  const artists = value.artists.map((artist) =>
    isObject(artist) ? boundedText(artist.name, 300) : undefined,
  );
  if (artists.some((artist) => artist === undefined)) {
    throw new ProviderError("invalid_provider_response");
  }
  const artist = artists.join(", ");
  const album = boundedText(value.album.name, 500);
  const providerUrl = publicHttpsUrl(value.external_urls.spotify);
  if (
    artist.length > 300 ||
    album === undefined ||
    providerUrl === undefined
  ) {
    throw new ProviderError("invalid_provider_response");
  }

  let thumbnailUrl: string | null = null;
  let widest = -1;
  for (const image of value.album.images) {
    if (!isObject(image)) {
      throw new ProviderError("invalid_provider_response");
    }
    const imageUrl = publicHttpsUrl(image.url);
    const width =
      image.width === undefined
        ? 0
        : boundedInteger(image.width, 0, 100_000);
    if (imageUrl === undefined || width === undefined) {
      throw new ProviderError("invalid_provider_response");
    }
    if (width > widest) {
      widest = width;
      thumbnailUrl = imageUrl;
    }
  }

  return {
    id,
    title,
    artist,
    album,
    duration: Math.floor(durationMs / 1_000),
    thumbnailUrl,
    providerUrl,
  };
}

function pageTotal(value: unknown): number {
  const total = boundedInteger(value, 0, MAX_TOTAL);
  if (total === undefined) {
    throw new ProviderError("invalid_provider_response");
  }
  return total;
}

function trackPage(
  value: unknown,
  offset: number,
  limit: number,
): TracksPage {
  if (
    !isObject(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  ) {
    throw new ProviderError("invalid_provider_response");
  }
  const tracks: NormalizedTrack[] = [];
  for (const item of value.items) {
    if (!isObject(item) || !("track" in item)) {
      throw new ProviderError("invalid_provider_response");
    }
    if (item.track !== null) {
      tracks.push(normalizedTrack(item.track));
    }
  }
  return { offset, limit, total: pageTotal(value.total), tracks };
}

function playlistsResult(value: unknown): SpotifyPlaylistsResult {
  if (
    !isObject(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  ) {
    throw new ProviderError("invalid_provider_response");
  }
  const playlists = value.items.map((item): SpotifyPlaylist => {
    if (
      !isObject(item) ||
      !isObject(item.tracks) ||
      !Array.isArray(item.images) ||
      item.images.length > MAX_ITEMS ||
      !isObject(item.owner)
    ) {
      throw new ProviderError("invalid_provider_response");
    }
    const id = boundedText(item.id, MAX_IDENTIFIER_LENGTH);
    const name = boundedText(item.name, 500);
    const description =
      typeof item.description === "string" &&
      item.description.trim().length <= 4_096
        ? item.description.trim()
        : undefined;
    const trackCount = boundedInteger(item.tracks.total, 0, MAX_TOTAL);
    const owner = boundedText(item.owner.display_name, 500);
    const thumbnailUrl =
      item.images.length === 0
        ? null
        : isObject(item.images[0])
          ? publicHttpsUrl(item.images[0].url)
          : undefined;
    if (
      id === undefined ||
      name === undefined ||
      description === undefined ||
      trackCount === undefined ||
      owner === undefined ||
      thumbnailUrl === undefined
    ) {
      throw new ProviderError("invalid_provider_response");
    }
    return {
      id,
      name,
      description,
      trackCount,
      thumbnailUrl,
      owner,
    };
  });
  return { playlists, total: pageTotal(value.total) };
}

function topTracksResult(value: unknown): SpotifyTracksResult {
  if (
    !isObject(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ITEMS
  ) {
    throw new ProviderError("invalid_provider_response");
  }
  return { tracks: value.items.map(normalizedTrack) };
}

export class SpotifyProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #callbackUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #logger?: ProviderLogger;

  constructor(options: SpotifyProviderOptions) {
    assertTextInput(options.clientId, MAX_TOKEN_LENGTH);
    assertTextInput(options.clientSecret, MAX_TOKEN_LENGTH);
    if (!exactCallbackUri(options.callbackUri)) {
      throw new ProviderError("provider_rejected");
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#callbackUri = options.callbackUri;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  authorizationUrl(input: {
    readonly state: string;
    readonly callbackUri: string;
  }): string {
    assertTextInput(input.state, MAX_TOKEN_LENGTH);
    if (input.callbackUri !== this.#callbackUri) {
      throw new ProviderError("provider_rejected");
    }
    const url = new URL("/authorize", ACCOUNTS_ORIGIN);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#clientId,
      scope: SPOTIFY_SCOPES,
      redirect_uri: this.#callbackUri,
      state: input.state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly callbackUri: string;
    readonly signal?: AbortSignal;
  }): Promise<SpotifyExchangeResult> {
    assertTextInput(input.code, MAX_TOKEN_LENGTH);
    if (input.callbackUri !== this.#callbackUri) {
      throw new ProviderError("provider_rejected");
    }
    const value = await this.#requestJson(
      "oauth.exchange",
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: this.#callbackUri,
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
        }),
      },
      input.signal,
    );
    const tokens = tokenResponse(value, true);
    const account = accountProfile(
      await this.#apiGet(
        "account.profile",
        tokens.accessToken,
        new URL(`${API_ROOT}/me`),
        input.signal,
      ),
    );
    return {
      secret: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken!,
        expiresAt: new Date(
          this.#now() + tokens.expiresIn * 1_000,
        ).toISOString(),
      },
      account,
    };
  }

  async refresh(
    secret: SpotifySecret,
    context: { readonly signal?: AbortSignal } = {},
  ): Promise<SpotifyRefreshResult> {
    assertTokenInput(secret.accessToken);
    assertTokenInput(secret.refreshToken);
    const expiresAt = Date.parse(secret.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new ProviderError("provider_rejected");
    }
    if (expiresAt > this.#now() + 60_000) {
      return { refreshed: false, secret };
    }

    const value = await this.#requestJson(
      "oauth.refresh",
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: secret.refreshToken,
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
        }),
      },
      context.signal,
    );
    const tokens = tokenResponse(value, false);
    return {
      refreshed: true,
      secret: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? secret.refreshToken,
        expiresAt: new Date(
          this.#now() + tokens.expiresIn * 1_000,
        ).toISOString(),
      },
    };
  }

  async likedTracks(input: {
    readonly accessToken: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<TracksPage> {
    assertTokenInput(input.accessToken);
    assertPagination(input.offset, input.limit);
    const url = new URL(`${API_ROOT}/me/tracks`);
    url.search = new URLSearchParams({
      offset: String(input.offset),
      limit: String(input.limit),
    }).toString();
    return trackPage(
      await this.#apiGet(
        "liked.list",
        input.accessToken,
        url,
        input.signal,
      ),
      input.offset,
      input.limit,
    );
  }

  async playlists(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<SpotifyPlaylistsResult> {
    assertTokenInput(input.accessToken);
    const url = new URL(`${API_ROOT}/me/playlists`);
    url.search = new URLSearchParams({ limit: String(MAX_ITEMS) }).toString();
    return playlistsResult(
      await this.#apiGet(
        "playlists.list",
        input.accessToken,
        url,
        input.signal,
      ),
    );
  }

  async playlistTracks(input: {
    readonly accessToken: string;
    readonly playlistId: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<TracksPage> {
    assertTokenInput(input.accessToken);
    assertTextInput(input.playlistId, MAX_IDENTIFIER_LENGTH);
    assertPagination(input.offset, input.limit);
    const playlistId = encodeURIComponent(input.playlistId);
    const pathname = `/v1/playlists/${playlistId}/tracks`;
    const url = new URL(pathname, API_ORIGIN);
    if (url.pathname !== pathname) {
      throw new ProviderError("provider_rejected");
    }
    url.search = new URLSearchParams({
      offset: String(input.offset),
      limit: String(input.limit),
      fields: PLAYLIST_FIELDS,
    }).toString();
    return trackPage(
      await this.#apiGet(
        "playlist-tracks.list",
        input.accessToken,
        url,
        input.signal,
      ),
      input.offset,
      input.limit,
    );
  }

  async topTracks(input: {
    readonly accessToken: string;
    readonly timeRange: "short_term" | "medium_term" | "long_term";
    readonly signal?: AbortSignal;
  }): Promise<SpotifyTracksResult> {
    assertTokenInput(input.accessToken);
    if (
      input.timeRange !== "short_term" &&
      input.timeRange !== "medium_term" &&
      input.timeRange !== "long_term"
    ) {
      throw new ProviderError("provider_rejected");
    }
    const url = new URL(`${API_ROOT}/me/top/tracks`);
    url.search = new URLSearchParams({
      limit: String(MAX_ITEMS),
      time_range: input.timeRange,
    }).toString();
    return topTracksResult(
      await this.#apiGet(
        "top-tracks.list",
        input.accessToken,
        url,
        input.signal,
      ),
    );
  }

  async #apiGet(
    operation: SpotifyProviderOperation,
    accessToken: string,
    url: URL,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#requestJson(operation, url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    }, signal);
  }

  async #requestJson(
    operation: SpotifyProviderOperation,
    url: URL | string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchProviderResponse(
        this.#fetch,
        url,
        { ...init, redirect: "error" },
        signal,
      );
    } catch {
      this.#log("provider_unavailable", operation);
      throw new ProviderError("provider_unavailable");
    }
    if (!response.ok) {
      cancelProviderResponseBody(response);
      const code =
        response.status >= 400 && response.status < 500
          ? "provider_rejected"
          : "provider_unavailable";
      this.#log(code, operation);
      throw new ProviderError(code);
    }
    try {
      return await readBoundedProviderJson(response, signal);
    } catch (error) {
      const code =
        error instanceof ProviderHttpFailure && error.kind === "aborted"
          ? "provider_unavailable"
          : "invalid_provider_response";
      this.#log(code, operation);
      throw new ProviderError(code);
    }
  }

  #log(code: ProviderErrorCode, operation: SpotifyProviderOperation): void {
    try {
      this.#logger?.error(
        { provider: "spotify", code, operation },
        "Spotify provider request failed",
      );
    } catch {
      // Logging must not alter provider behavior.
    }
  }
}
