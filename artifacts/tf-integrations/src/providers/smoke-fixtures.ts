import type {
  SpotifyProviderAdapter,
  YandexProviderAdapter,
} from "../service.js";

class SmokeFixtureProviderError extends Error {
  readonly code = "provider_unavailable";

  constructor() {
    super("Smoke fixture provider unavailable");
    this.name = "SmokeFixtureProviderError";
  }
}

function providerUnavailable<T>(): Promise<T> {
  return Promise.reject(new SmokeFixtureProviderError());
}

function spotifyAuthorizationUrl(input: {
  readonly callbackUri: string;
  readonly state: string;
}): string {
  const url = new URL("/authorize", "https://accounts.spotify.com");
  url.searchParams.set("client_id", "spotify-smoke-fixture");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.callbackUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", "user-library-read");
  return url.toString();
}

export function createSmokeFixtureProviders(): {
  readonly spotify: SpotifyProviderAdapter;
  readonly yandex: YandexProviderAdapter;
} {
  return {
    spotify: {
      authorizationUrl: spotifyAuthorizationUrl,
      async exchangeCode() {
        return {
          account: {
            id: "spotify-smoke-fixture",
            displayName: "Spotify Smoke Fixture",
          },
          secret: {
            accessToken: "spotify-smoke-access",
            refreshToken: "spotify-smoke-refresh",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      },
      async refresh(secret) {
        return { refreshed: false, secret };
      },
      likedTracks: () => providerUnavailable(),
      playlists: () => providerUnavailable(),
      playlistTracks: () => providerUnavailable(),
      topTracks: () => providerUnavailable(),
    },
    yandex: {
      async validateToken() {
        return {
          id: "424242",
          login: "yandex-smoke-fixture",
          displayName: "Yandex Smoke Fixture",
        };
      },
      likedTracks: () => providerUnavailable(),
      playlists: () => providerUnavailable(),
      playlistTracks: () => providerUnavailable(),
    },
  };
}
