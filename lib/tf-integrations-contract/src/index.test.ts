import { describe, expect, it } from "vitest";
import {
  TF_INTEGRATIONS_COMMAND_PATH,
  tfIntegrationsCommandSchema,
  tfIntegrationsErrorResponseSchema,
  tfIntegrationsSuccessResponseSchema,
} from "./index";

const requestId = "a0000000-0000-4000-8000-000000000001";
const accountId = "b0000000-0000-4000-8000-000000000002";
const callbackUri = "https://tf.example.test/api/spotify/callback";

const track = {
  id: "spotify-track-1",
  title: "Track",
  artist: "Artist",
  album: "Album",
  duration: 180,
  thumbnailUrl: "https://images.example.test/track.jpg",
  providerUrl: "https://open.spotify.com/track/spotify-track-1",
} as const;

const spotifyAccount = {
  provider: "spotify",
  connected: true,
  account: {
    id: "spotify-user-1",
    displayName: "Spotify User",
  },
} as const;

const yandexAccount = {
  provider: "yandex",
  connected: true,
  account: {
    id: "yandex-user-1",
    displayName: "Yandex User",
  },
} as const;

const commands = [
  {
    operation: "spotify.oauth.authorize",
    input: { state: "s".repeat(32), callbackUri },
  },
  {
    operation: "spotify.oauth.complete",
    input: { code: "c".repeat(8), callbackUri },
  },
  { operation: "spotify.status", input: {} },
  { operation: "spotify.disconnect", input: {} },
  { operation: "spotify.liked.list", input: { offset: 0, limit: 50 } },
  { operation: "spotify.playlists.list", input: {} },
  {
    operation: "spotify.playlist-tracks.list",
    input: { playlistId: "playlist-1", offset: 0, limit: 50 },
  },
  { operation: "spotify.top-tracks.list", input: { timeRange: "medium_term" } },
  { operation: "yandex.token.upsert", input: { token: "t".repeat(10) } },
  { operation: "yandex.status", input: {} },
  { operation: "yandex.disconnect", input: {} },
  { operation: "yandex.liked.list", input: { offset: 0, limit: 50 } },
  { operation: "yandex.playlists.list", input: {} },
  {
    operation: "yandex.playlist-tracks.list",
    input: { uid: 1, kind: 1, offset: 0, limit: 50 },
  },
] as const;

describe("tf integrations contract", () => {
  it("accepts every documented operation with canonical account and request IDs", () => {
    expect(TF_INTEGRATIONS_COMMAND_PATH).toBe("/v1/commands");

    for (const command of commands) {
      expect(
        tfIntegrationsCommandSchema.parse({
          schemaVersion: 1,
          requestId,
          accountId,
          ...command,
        }),
      ).toEqual({ schemaVersion: 1, requestId, accountId, ...command });
    }
  });

  it("rejects unknown keys, noncanonical UUID aliases, and mismatched operation payloads", () => {
    const command = {
      schemaVersion: 1,
      requestId,
      accountId,
      operation: "spotify.oauth.complete",
      input: { code: "c".repeat(8), callbackUri },
    } as const;

    expect(
      tfIntegrationsCommandSchema.safeParse({ ...command, extra: true })
        .success,
    ).toBe(false);
    expect(
      tfIntegrationsCommandSchema.safeParse({
        ...command,
        requestId: requestId.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsCommandSchema.safeParse({
        ...command,
        accountId: `{${accountId}}`,
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsCommandSchema.safeParse({
        ...command,
        operation: "spotify.status",
      }).success,
    ).toBe(false);
  });

  it("bounds provider codes, tokens, state, callback URI, identifiers, offsets, limits, and arrays", () => {
    const command = (operation: string, input: object) =>
      tfIntegrationsCommandSchema.safeParse({
        schemaVersion: 1,
        requestId,
        accountId,
        operation,
        input,
      }).success;

    expect(
      command("spotify.oauth.complete", {
        code: "c".repeat(8_193),
        callbackUri,
      }),
    ).toBe(false);
    expect(command("yandex.token.upsert", { token: "t".repeat(8_193) })).toBe(
      false,
    );
    expect(
      command("spotify.oauth.authorize", {
        state: "s".repeat(8_193),
        callbackUri,
      }),
    ).toBe(false);
    expect(
      command("spotify.oauth.complete", {
        code: "code",
        callbackUri: "x".repeat(4_097),
      }),
    ).toBe(false);
    expect(
      command("spotify.playlist-tracks.list", {
        playlistId: "p".repeat(513),
        offset: 0,
        limit: 1,
      }),
    ).toBe(false);
    expect(
      command("yandex.playlist-tracks.list", {
        uid: 0,
        kind: 1,
        offset: 0,
        limit: 1,
      }),
    ).toBe(false);
    expect(command("spotify.liked.list", { offset: 1_000_001, limit: 1 })).toBe(
      false,
    );
    expect(command("yandex.liked.list", { offset: 0, limit: 51 })).toBe(false);

    const response = {
      schemaVersion: 1,
      requestId,
      operation: "spotify.liked.list",
      result: { offset: 0, limit: 50, total: 50, tracks: [track] },
    } as const;
      expect(tfIntegrationsSuccessResponseSchema.parse(response)).toEqual(
        response,
      );
      expect(
        tfIntegrationsSuccessResponseSchema.safeParse({
          ...response,
          result: {
            ...response.result,
            tracks: [{ ...track, providerUrl: null }],
          },
        }).success,
      ).toBe(false);
      expect(
        tfIntegrationsSuccessResponseSchema.safeParse({
        ...response,
        result: {
          ...response.result,
          tracks: Array.from({ length: 51 }, () => track),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only the exact HTTPS TF Spotify callback URI shape", () => {
    const command = (callback: string) =>
      tfIntegrationsCommandSchema.safeParse({
        schemaVersion: 1,
        requestId,
        accountId,
        operation: "spotify.oauth.authorize",
        input: { state: "s".repeat(32), callbackUri: callback },
      }).success;

    expect(command(callbackUri)).toBe(true);
    expect(command("http://tf.example.test/api/spotify/callback")).toBe(false);
    expect(
      command("https://user:pass@tf.example.test/api/spotify/callback"),
    ).toBe(false);
    expect(
      command("https://tf.example.test/api/spotify/callback?code=secret"),
    ).toBe(false);
    expect(
      command("https://tf.example.test/api/spotify/callback#fragment"),
    ).toBe(false);
    expect(command("https://tf.example.test/api/spotify/callback/other")).toBe(
      false,
    );
  });

  it("correlates success and error responses by schema version, request ID, and operation", () => {
    const success = {
      schemaVersion: 1,
      requestId,
      operation: "spotify.status",
      result: { account: spotifyAccount },
    } as const;
    const error = {
      schemaVersion: 1,
      requestId,
      operation: "yandex.status",
      error: { code: "not_connected" },
    } as const;

    expect(tfIntegrationsSuccessResponseSchema.parse(success)).toEqual(success);
    expect(tfIntegrationsErrorResponseSchema.parse(error)).toEqual(error);
    expect(
      tfIntegrationsSuccessResponseSchema.safeParse({
        ...success,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsErrorResponseSchema.safeParse({
        ...error,
        requestId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsSuccessResponseSchema.safeParse({
        ...success,
        operation: "spotify.disconnect",
      }).success,
    ).toBe(false);
  });

  it("cannot serialize provider tokens or credentials in any success or error result", () => {
    const success = {
      schemaVersion: 1,
      requestId,
      operation: "yandex.token.upsert",
      result: { account: yandexAccount },
    } as const;
    const error = {
      schemaVersion: 1,
      requestId,
      operation: "spotify.oauth.complete",
      error: { code: "provider_rejected" },
    } as const;

    expect(
      tfIntegrationsSuccessResponseSchema.safeParse({
        ...success,
        result: { ...success.result, token: "provider-token" },
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsSuccessResponseSchema.safeParse({
        ...success,
        result: {
          account: {
            ...yandexAccount,
            account: { ...yandexAccount.account, credential: "secret" },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsErrorResponseSchema.safeParse({
        ...error,
        error: { ...error.error, accessToken: "provider-token" },
      }).success,
    ).toBe(false);
    expect(
      tfIntegrationsErrorResponseSchema.safeParse({
        ...error,
        refreshToken: "secret",
      }).success,
    ).toBe(false);
  });
});
