import type {
  NormalizedTrack,
  YandexPlaylist,
} from "@workspace/tf-integrations-contract";

const API_ORIGIN = "https://api.music.yandex.net";
const CLIENT_HEADER = "YandexMusicAndroid/24023621";
const MAX_TOKEN_LENGTH = 8_192;
const MAX_IDENTIFIER = 2_147_483_647;
const MAX_OFFSET = 1_000_000;
const MAX_ITEMS = 50;
const MAX_TOTAL = 1_000_000;
const MAX_DURATION_MS = 86_400_000;

export type YandexProviderErrorCode =
  | "provider_rejected"
  | "provider_unavailable"
  | "invalid_provider_response";

type YandexProviderOperation =
  | "account.status"
  | "liked.list"
  | "tracks.details"
  | "playlists.list"
  | "playlist-tracks.list";

export interface YandexProviderLogger {
  error(
    event: Readonly<{
      provider: "yandex";
      code: YandexProviderErrorCode;
      operation: YandexProviderOperation;
    }>,
    message: string,
  ): void;
}

export interface YandexProviderOptions {
  readonly fetch: typeof fetch;
  readonly logger?: YandexProviderLogger;
}

export class YandexProviderError extends Error {
  readonly code: YandexProviderErrorCode;

  constructor(code: YandexProviderErrorCode) {
    super("Yandex provider request failed");
    this.name = "YandexProviderError";
    this.code = code;
  }
}

export interface YandexAccount {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
}

export interface YandexTracksPage {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly tracks: readonly NormalizedTrack[];
}

export interface YandexPlaylistsResult {
  readonly playlists: readonly YandexPlaylist[];
  readonly total: number;
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

function assertToken(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 10 ||
    value.length > MAX_TOKEN_LENGTH
  ) {
    throw new YandexProviderError("provider_rejected");
  }
}

function assertPagination(offset: number, limit: number): void {
  if (
    boundedInteger(offset, 0, MAX_OFFSET) === undefined ||
    boundedInteger(limit, 1, MAX_ITEMS) === undefined
  ) {
    throw new YandexProviderError("provider_rejected");
  }
}

function assertIdentifier(value: number): void {
  if (boundedInteger(value, 1, MAX_IDENTIFIER) === undefined) {
    throw new YandexProviderError("provider_rejected");
  }
}

function numericUserId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,9}$/.test(value) ||
    Number(value) > MAX_IDENTIFIER
  ) {
    throw new YandexProviderError("provider_rejected");
  }
  return value;
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

function coverUrl(value: unknown): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 4_000) {
    return undefined;
  }
  return publicHttpsUrl(`https://${value.replace("%%", "200x200")}`);
}

function resultEnvelope(value: unknown): unknown {
  if (!isObject(value)) {
    throw new YandexProviderError("invalid_provider_response");
  }
  return "result" in value ? value.result : value;
}

function accountResult(value: unknown): YandexAccount {
  const result = resultEnvelope(value);
  if (!isObject(result) || !isObject(result.account)) {
    throw new YandexProviderError("invalid_provider_response");
  }
  const uid = boundedInteger(result.account.uid, 1, MAX_IDENTIFIER);
  const login = boundedText(result.account.login, 500);
  const fullName =
    result.account.fullName === undefined
      ? undefined
      : boundedText(result.account.fullName, 500);
  const displayName =
    result.account.displayName === undefined
      ? undefined
      : boundedText(result.account.displayName, 500);
  if (
    uid === undefined ||
    login === undefined ||
    (result.account.fullName !== undefined && fullName === undefined) ||
    (result.account.displayName !== undefined && displayName === undefined)
  ) {
    throw new YandexProviderError("invalid_provider_response");
  }
  return {
    id: String(uid),
    login,
    displayName: fullName ?? displayName ?? login,
  };
}

function normalizedTrack(value: unknown): NormalizedTrack {
  if (
    !isObject(value) ||
    !Array.isArray(value.artists) ||
    value.artists.length < 1 ||
    value.artists.length > MAX_ITEMS ||
    !Array.isArray(value.albums) ||
    value.albums.length < 1 ||
    value.albums.length > MAX_ITEMS ||
    !isObject(value.albums[0])
  ) {
    throw new YandexProviderError("invalid_provider_response");
  }
  const id = boundedInteger(value.id, 1, MAX_IDENTIFIER);
  const title = boundedText(value.title, 500);
  const durationMs =
    value.durationMs === undefined
      ? 0
      : boundedInteger(value.durationMs, 0, MAX_DURATION_MS);
  const artists = value.artists.map((artist) =>
    isObject(artist) ? boundedText(artist.name, 300) : undefined,
  );
  const artist = artists.join(", ");
  const album = boundedText(value.albums[0].title, 500);
  const thumbnailUrl = coverUrl(value.albums[0].coverUri);
  if (
    id === undefined ||
    title === undefined ||
    durationMs === undefined ||
    artists.some((entry) => entry === undefined) ||
    artist.length > 300 ||
    album === undefined ||
    thumbnailUrl === undefined
  ) {
    throw new YandexProviderError("invalid_provider_response");
  }
  return {
    id: String(id),
    title,
    artist,
    album,
    duration: Math.floor(durationMs / 1_000),
    thumbnailUrl,
    providerUrl: `https://music.yandex.ru/track/${id}`,
  };
}

function likedReferences(value: unknown): readonly {
  readonly id: number;
  readonly albumId?: number;
}[] {
  const result = resultEnvelope(value);
  if (
    !isObject(result) ||
    !isObject(result.library) ||
    !Array.isArray(result.library.tracks) ||
    result.library.tracks.length > MAX_TOTAL
  ) {
    throw new YandexProviderError("invalid_provider_response");
  }
  return result.library.tracks.map((reference) => {
    if (!isObject(reference)) {
      throw new YandexProviderError("invalid_provider_response");
    }
    const id = boundedInteger(reference.id, 1, MAX_IDENTIFIER);
    const albumId =
      reference.albumId === undefined
        ? undefined
        : boundedInteger(reference.albumId, 1, MAX_IDENTIFIER);
    if (
      id === undefined ||
      (reference.albumId !== undefined && albumId === undefined)
    ) {
      throw new YandexProviderError("invalid_provider_response");
    }
    return albumId === undefined ? { id } : { id, albumId };
  });
}

function trackDetails(value: unknown): readonly NormalizedTrack[] {
  const result = resultEnvelope(value);
  if (!Array.isArray(result) || result.length > MAX_ITEMS) {
    throw new YandexProviderError("invalid_provider_response");
  }
  return result.map(normalizedTrack);
}

function playlistsResult(value: unknown): YandexPlaylistsResult {
  const result = resultEnvelope(value);
  if (!Array.isArray(result) || result.length > MAX_ITEMS) {
    throw new YandexProviderError("invalid_provider_response");
  }
  const playlists = result.map((playlist): YandexPlaylist => {
    if (
      !isObject(playlist) ||
      !isObject(playlist.owner) ||
      (playlist.cover !== undefined && !isObject(playlist.cover))
    ) {
      throw new YandexProviderError("invalid_provider_response");
    }
    const uid = boundedInteger(playlist.uid, 1, MAX_IDENTIFIER);
    const kind = boundedInteger(playlist.kind, 1, MAX_IDENTIFIER);
    const title = boundedText(playlist.title, 500);
    const description =
      playlist.description === undefined
        ? ""
        : typeof playlist.description === "string" &&
            playlist.description.trim().length <= 4_096
          ? playlist.description.trim()
          : undefined;
    const trackCount = boundedInteger(playlist.trackCount, 0, MAX_TOTAL);
    const displayName =
      playlist.owner.displayName === undefined
        ? undefined
        : boundedText(playlist.owner.displayName, 500);
    const name =
      playlist.owner.name === undefined
        ? undefined
        : boundedText(playlist.owner.name, 500);
    const login = boundedText(playlist.owner.login, 500);
    const thumbnailUrl = coverUrl(
      isObject(playlist.cover) ? playlist.cover.uri : undefined,
    );
    if (
      uid === undefined ||
      kind === undefined ||
      title === undefined ||
      description === undefined ||
      trackCount === undefined ||
      login === undefined ||
      (playlist.owner.displayName !== undefined &&
        displayName === undefined) ||
      (playlist.owner.name !== undefined && name === undefined) ||
      thumbnailUrl === undefined
    ) {
      throw new YandexProviderError("invalid_provider_response");
    }
    return {
      uid,
      kind,
      title,
      description,
      trackCount,
      thumbnailUrl,
      owner: displayName ?? name ?? login,
    };
  });
  return { playlists, total: playlists.length };
}

function playlistTracksResult(
  value: unknown,
  offset: number,
  limit: number,
): YandexTracksPage {
  const result = resultEnvelope(value);
  if (
    !isObject(result) ||
    boundedInteger(result.kind, 1, MAX_IDENTIFIER) === undefined ||
    boundedText(result.title, 500) === undefined ||
    !Array.isArray(result.tracks) ||
    result.tracks.length > MAX_TOTAL
  ) {
    throw new YandexProviderError("invalid_provider_response");
  }
  const entries = result.tracks.map((entry) => {
    if (
      !isObject(entry) ||
      boundedInteger(entry.id, 1, MAX_IDENTIFIER) === undefined ||
      boundedText(entry.timestamp, 128) === undefined ||
      (entry.track !== undefined && !isObject(entry.track))
    ) {
      throw new YandexProviderError("invalid_provider_response");
    }
    return entry.track;
  });
  return {
    offset,
    limit,
    total: entries.length,
    tracks: entries
      .slice(offset, offset + limit)
      .filter((track) => track !== undefined)
      .map(normalizedTrack),
  };
}

export class YandexProvider {
  readonly #fetch: typeof fetch;
  readonly #logger?: YandexProviderLogger;

  constructor(options: YandexProviderOptions) {
    this.#fetch = options.fetch;
    this.#logger = options.logger;
  }

  async validateToken(input: {
    readonly oauthToken: string;
  }): Promise<YandexAccount> {
    assertToken(input.oauthToken);
    return accountResult(
      await this.#get(
        "account.status",
        input.oauthToken,
        new URL("/account/status", API_ORIGIN),
      ),
    );
  }

  async likedTracks(input: {
    readonly oauthToken: string;
    readonly userId: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<YandexTracksPage> {
    assertToken(input.oauthToken);
    const userId = numericUserId(input.userId);
    assertPagination(input.offset, input.limit);
    const references = likedReferences(
      await this.#get(
        "liked.list",
        input.oauthToken,
        new URL(`/users/${userId}/likes/tracks`, API_ORIGIN),
      ),
    );
    const page = references.slice(input.offset, input.offset + input.limit);
    if (page.length === 0) {
      return {
        offset: input.offset,
        limit: input.limit,
        total: references.length,
        tracks: [],
      };
    }
    const url = new URL("/tracks", API_ORIGIN);
    url.search = new URLSearchParams({
      "track-ids": page
        .map(({ id, albumId }) =>
          albumId === undefined ? String(id) : `${id}:${albumId}`,
        )
        .join(","),
    }).toString();
    return {
      offset: input.offset,
      limit: input.limit,
      total: references.length,
      tracks: trackDetails(
        await this.#get("tracks.details", input.oauthToken, url),
      ),
    };
  }

  async playlists(input: {
    readonly oauthToken: string;
    readonly userId: string;
  }): Promise<YandexPlaylistsResult> {
    assertToken(input.oauthToken);
    const userId = numericUserId(input.userId);
    return playlistsResult(
      await this.#get(
        "playlists.list",
        input.oauthToken,
        new URL(`/users/${userId}/playlists/list`, API_ORIGIN),
      ),
    );
  }

  async playlistTracks(input: {
    readonly oauthToken: string;
    readonly uid: number;
    readonly kind: number;
    readonly offset: number;
    readonly limit: number;
  }): Promise<YandexTracksPage> {
    assertToken(input.oauthToken);
    assertIdentifier(input.uid);
    assertIdentifier(input.kind);
    assertPagination(input.offset, input.limit);
    return playlistTracksResult(
      await this.#get(
        "playlist-tracks.list",
        input.oauthToken,
        new URL(`/users/${input.uid}/playlists/${input.kind}`, API_ORIGIN),
      ),
      input.offset,
      input.limit,
    );
  }

  async #get(
    operation: YandexProviderOperation,
    oauthToken: string,
    url: URL,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `OAuth ${oauthToken}`,
          "X-Yandex-Music-Client": CLIENT_HEADER,
        },
        redirect: "error",
      });
    } catch {
      this.#log("provider_unavailable", operation);
      throw new YandexProviderError("provider_unavailable");
    }
    if (!response.ok) {
      const code =
        response.status >= 400 && response.status < 500
          ? "provider_rejected"
          : "provider_unavailable";
      this.#log(code, operation);
      throw new YandexProviderError(code);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      this.#log("invalid_provider_response", operation);
      throw new YandexProviderError("invalid_provider_response");
    }
  }

  #log(
    code: YandexProviderErrorCode,
    operation: YandexProviderOperation,
  ): void {
    try {
      this.#logger?.error(
        { provider: "yandex", code, operation },
        "Yandex provider request failed",
      );
    } catch {
      // Logging must not alter provider behavior.
    }
  }
}
