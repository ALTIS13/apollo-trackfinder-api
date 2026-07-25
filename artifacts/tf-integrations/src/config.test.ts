import { describe, expect, it } from "vitest";

import { parseTfIntegrationsConfig } from "./config.js";

const commandSecret = "c".repeat(32);
const heartbeatSecret = "h".repeat(32);
const tokenKeyring = JSON.stringify({
  activeKeyId: "2026-07",
  keys: { "2026-07": Buffer.alloc(32, 7).toString("base64url") },
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "8080",
    TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE: "/private/command",
    TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE: "/private/heartbeat",
    TF_INTEGRATIONS_DATABASE_URL_FILE: "/private/database",
    TF_INTEGRATIONS_TOKEN_KEYRING_FILE: "/private/keyring",
    TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE: "/private/spotify-id",
    TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE: "/private/spotify-secret",
    TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI:
      "https://api.example.test/api/spotify/callback",
    TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "https://api.example.test",
    APOLLO_API_VERSION: "2026.7.25",
    ...overrides,
  };
}

function fileValues(
  overrides: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    "/private/command": commandSecret,
    "/private/heartbeat": heartbeatSecret,
    "/private/database":
      "postgres://runtime:database-secret@integrations-db:5432/integrations",
    "/private/keyring": tokenKeyring,
    "/private/spotify-id": "spotify-client-id",
    "/private/spotify-secret": "spotify-client-secret",
    ...overrides,
  };
}

function reader(values: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = values[path];
    if (value === undefined) throw new Error(`unreadable ${path}`);
    return value;
  };
}

describe("TF integrations runtime configuration", () => {
  it("loads every secret from a file and rejects equal command/heartbeat keys", async () => {
    const config = await parseTfIntegrationsConfig(
      environment(),
      reader(
        fileValues({
          "/private/command": ` ${commandSecret}\n`,
          "/private/heartbeat": `\n${heartbeatSecret} `,
        }),
      ),
    );

    expect(config).toMatchObject({
      port: 8080,
      internalAuthSecret: commandSecret,
      heartbeatSecret,
      databaseUrl:
        "postgres://runtime:database-secret@integrations-db:5432/integrations",
      spotifyClientId: "spotify-client-id",
      spotifyClientSecret: "spotify-client-secret",
      spotifyCallbackUri: "https://api.example.test/api/spotify/callback",
      heartbeatApiOrigin: "https://api.example.test",
      version: "2026.7.25",
    });
    expect(config.tokenKeyring).toMatchObject({
      activeKeyId: "2026-07",
      keyIds: ["2026-07"],
    });

    await expect(
      parseTfIntegrationsConfig(
        environment(),
        reader(
          fileValues({
            "/private/heartbeat": commandSecret,
          }),
        ),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("accepts local HTTP only with the explicit flag and a private service hostname", async () => {
    const read = reader(fileValues());
    await expect(
      parseTfIntegrationsConfig(
        environment({
          TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
        }),
        read,
      ),
    ).rejects.toThrow("invalid runtime configuration");

    await expect(
      parseTfIntegrationsConfig(
        environment({
          TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: "http://tf-api:8080",
          TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
        }),
        read,
      ),
    ).resolves.toMatchObject({
      heartbeatApiOrigin: "http://tf-api:8080",
    });

    for (const origin of [
      "http://public.example.test",
      "http://192.168.1.20:8080",
      "http://tf-api.example:8080",
    ]) {
      await expect(
        parseTfIntegrationsConfig(
          environment({
            TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: origin,
            TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
          }),
          read,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it("requires exact HTTPS callback and cross-node heartbeat origins otherwise", async () => {
    const read = reader(fileValues());

    for (const callback of [
      "http://api.example.test/api/spotify/callback",
      "https://api.example.test/api/spotify/callback/",
      "https://api.example.test/api/spotify/callback?code=secret",
      "https://user:pass@api.example.test/api/spotify/callback",
    ]) {
      await expect(
        parseTfIntegrationsConfig(
          environment({ TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI: callback }),
          read,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }

    for (const origin of [
      "https://api.example.test/",
      "https://api.example.test/path",
      "https://user:pass@api.example.test",
      "ftp://api.example.test",
    ]) {
      await expect(
        parseTfIntegrationsConfig(
          environment({ TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN: origin }),
          read,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }

    await expect(
      parseTfIntegrationsConfig(
        environment({
          APOLLO_DEPLOYED_AT: "2026-07-25T12:34:56+03:00",
        }),
        read,
      ),
    ).resolves.toMatchObject({
      spotifyCallbackUri: "https://api.example.test/api/spotify/callback",
      heartbeatApiOrigin: "https://api.example.test",
      deployedAt: "2026-07-25T12:34:56+03:00",
    });
  });

  it("fails closed without database, keyring, or Spotify credential files", async () => {
    for (const path of [
      "/private/database",
      "/private/keyring",
      "/private/spotify-id",
      "/private/spotify-secret",
    ]) {
      const values = { ...fileValues() };
      delete values[path];
      await expect(
        parseTfIntegrationsConfig(environment(), reader(values)),
      ).rejects.toThrow("invalid runtime configuration");
    }

    await expect(
      parseTfIntegrationsConfig(
        environment(),
        reader(fileValues({ "/private/keyring": '{"activeKeyId":"canary"}' })),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });
});
