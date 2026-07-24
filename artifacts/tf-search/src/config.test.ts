import { describe, expect, it } from "vitest";
import { parseTfSearchRuntimeConfig } from "./config.js";

const commandSecret = "c".repeat(32);
const heartbeatSecret = "h".repeat(32);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PORT: "8080",
    TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: "/run/secrets/command",
    TF_SEARCH_HEARTBEAT_SECRET_FILE: "/run/secrets/heartbeat",
    TF_SEARCH_HEARTBEAT_API_ORIGIN: "https://api.example.test",
    APOLLO_API_VERSION: "2026.7.24",
    ...overrides,
  };
}

function secretReader(values: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = values[path];
    if (value === undefined) throw new Error("unreadable");
    return value;
  };
}

describe("TF search runtime configuration", () => {
  it("loads, trims, and validates distinct file-backed secrets", async () => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment(),
        secretReader({
          "/run/secrets/command": ` ${commandSecret}\n`,
          "/run/secrets/heartbeat": `\n${heartbeatSecret} `,
        }),
      ),
    ).resolves.toEqual({
      port: 8080,
      internalAuthSecret: commandSecret,
      heartbeatSecret,
      heartbeatApiOrigin: "https://api.example.test",
      version: "2026.7.24",
      fixtureAdapters: false,
    });
  });

  it.each([
    ["missing command secret path", environment({ TF_SEARCH_INTERNAL_AUTH_SECRET_FILE: undefined })],
    ["missing heartbeat secret path", environment({ TF_SEARCH_HEARTBEAT_SECRET_FILE: undefined })],
    ["unreadable secret", environment()],
  ])("rejects %s", async (_name, env) => {
    await expect(parseTfSearchRuntimeConfig(env, secretReader({}))).rejects.toThrow(
      "invalid runtime configuration",
    );
  });

  it.each([
    ["empty", ""],
    ["short", "s".repeat(31)],
    ["long", "s".repeat(513)],
  ])("rejects a %s secret", async (_name, invalidSecret) => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment(),
        secretReader({
          "/run/secrets/command": invalidSecret,
          "/run/secrets/heartbeat": heartbeatSecret,
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("rejects matching command and heartbeat secrets", async () => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment(),
        secretReader({
          "/run/secrets/command": commandSecret,
          "/run/secrets/heartbeat": commandSecret,
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("enables deterministic fixtures only for the explicitly gated test runtime", async () => {
    const read = secretReader({
      "/run/secrets/command": commandSecret,
      "/run/secrets/heartbeat": heartbeatSecret,
    });

    await expect(
      parseTfSearchRuntimeConfig(
        environment({
          NODE_ENV: "test",
          TF_SEARCH_SMOKE_FIXTURES: "true",
        }),
        read,
      ),
    ).resolves.toMatchObject({ fixtureAdapters: true });

    for (const NODE_ENV of ["development", "production", undefined]) {
      await expect(
        parseTfSearchRuntimeConfig(
          environment({
            NODE_ENV,
            TF_SEARCH_SMOKE_FIXTURES: "true",
          }),
          read,
        ),
      ).rejects.toThrow("invalid runtime configuration");
    }
  });

  it.each(["false", "yes", "1"])(
    "rejects an invalid deterministic fixture flag %s",
    async (TF_SEARCH_SMOKE_FIXTURES) => {
      await expect(
        parseTfSearchRuntimeConfig(
          environment({
            NODE_ENV: "test",
            TF_SEARCH_SMOKE_FIXTURES,
          }),
          secretReader({
            "/run/secrets/command": commandSecret,
            "/run/secrets/heartbeat": heartbeatSecret,
          }),
        ),
      ).rejects.toThrow("invalid runtime configuration");
    },
  );

  it.each([undefined, "0", "8080.5", "65536", "text"])
  ("rejects invalid port %s", async (PORT) => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment({ PORT }),
        secretReader({
          "/run/secrets/command": commandSecret,
          "/run/secrets/heartbeat": heartbeatSecret,
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it.each([
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test/?query=yes",
    "https://api.example.test/#fragment",
    "https://api.example.test/",
  ])("rejects non-origin heartbeat URL %s", async (origin) => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment({ TF_SEARCH_HEARTBEAT_API_ORIGIN: origin }),
        secretReader({
          "/run/secrets/command": commandSecret,
          "/run/secrets/heartbeat": heartbeatSecret,
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("permits private HTTP only with its exact opt-in flag", async () => {
    const read = secretReader({
      "/run/secrets/command": commandSecret,
      "/run/secrets/heartbeat": heartbeatSecret,
    });

    await expect(
      parseTfSearchRuntimeConfig(
        environment({ TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://api:8080" }),
        read,
      ),
    ).rejects.toThrow("invalid runtime configuration");

    await expect(
      parseTfSearchRuntimeConfig(
        environment({
          TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://api:8080",
          TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
        }),
        read,
      ),
    ).resolves.toMatchObject({ heartbeatApiOrigin: "http://api:8080" });

    await expect(
      parseTfSearchRuntimeConfig(
        environment({
          TF_SEARCH_HEARTBEAT_API_ORIGIN: "http://public.example.test",
          TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP: "true",
        }),
        read,
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it.each([
    "2026-07-24T12:34:56Z",
    "2026-07-24T12:34:56+00:00",
    "2026-07-24T12:34:56+23:59",
    "2026-07-24T12:34:56-23:59",
  ])(
    "accepts HTTPS without the insecure transport flag and valid deployed metadata %s",
    async (APOLLO_DEPLOYED_AT) => {
      await expect(
        parseTfSearchRuntimeConfig(
          environment({ APOLLO_DEPLOYED_AT }),
          secretReader({
            "/run/secrets/command": commandSecret,
            "/run/secrets/heartbeat": heartbeatSecret,
          }),
        ),
      ).resolves.toMatchObject({ deployedAt: APOLLO_DEPLOYED_AT });
    },
  );

  it.each([
    "2026-07-24T12:34:56",
    "2026-07-24T12:34:56+0300",
    "2026-07-24T12:34:56+99:99",
    "2026-07-24T12:34:56+24:00",
    "2026-07-24T12:34:56+23:60",
    "not-a-date",
  ])
  ("rejects invalid deployed timestamp %s", async (APOLLO_DEPLOYED_AT) => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment({ APOLLO_DEPLOYED_AT }),
        secretReader({
          "/run/secrets/command": commandSecret,
          "/run/secrets/heartbeat": heartbeatSecret,
        }),
      ),
    ).rejects.toThrow("invalid runtime configuration");
  });

  it("treats an empty optional deployed timestamp as absent", async () => {
    await expect(
      parseTfSearchRuntimeConfig(
        environment({ APOLLO_DEPLOYED_AT: "" }),
        secretReader({
          "/run/secrets/command": commandSecret,
          "/run/secrets/heartbeat": heartbeatSecret,
        }),
      ),
    ).resolves.not.toHaveProperty("deployedAt");
  });
});
