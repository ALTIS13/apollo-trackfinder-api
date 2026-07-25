import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import type {
  TfIntegrationsCommand,
  TfIntegrationsErrorResponse,
  TfIntegrationsSuccessResponse,
} from "@workspace/tf-integrations-contract";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import type { TfIntegrationsGateway } from "../lib/tf-integrations-client.js";
import { TfIntegrationsUnavailableError } from "../lib/tf-integrations-client.js";
import { createTfLogger } from "../lib/logger.js";
import type { TfPrincipal } from "../lib/tf-policy.js";
import type { TfSession } from "../lib/tf-session-store.js";
import { AUTH_COOKIE_NAMES } from "./auth.js";
import {
  createYandexRouter,
  type YandexRouteDependencies,
} from "./yandex.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??=
    "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const PLATFORM_SESSION_ID = "30000000-0000-4000-8000-000000000003";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000004";
const TF_SESSION_ID = "50000000-0000-4000-8000-000000000005";
const WEB_ORIGIN = "https://tf.apollot.ru";
const principal = {
  accountId: ACCOUNT_ID,
  tfSessionId: TF_SESSION_ID,
  installationId: INSTALLATION_ID,
  entitlements: ["tf.integrations"],
  sessionExpiresAt: "2026-07-24T04:00:00.000Z",
  policyFreshUntil: "2026-07-24T03:05:00.000Z",
} as const;
const servers: Server[] = [];

type GatewayCommand = TfIntegrationsCommand extends infer Command
  ? Command extends TfIntegrationsCommand
    ? Omit<Command, "schemaVersion" | "requestId">
    : never
  : never;

const track = {
  id: "42",
  title: "Track",
  artist: "Artist",
  album: "Album",
  duration: 180,
  thumbnailUrl: "https://images.example.test/track.jpg",
  providerUrl: "https://music.yandex.ru/track/42",
} as const;

const playlist = {
  uid: 12345,
  kind: 7,
  title: "Playlist",
  description: "Description",
  trackCount: 2,
  thumbnailUrl: "https://images.example.test/playlist.jpg",
  owner: "Owner",
} as const;

function success(
  command: GatewayCommand,
  result: unknown,
): TfIntegrationsSuccessResponse {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    accountId: command.accountId,
    operation: command.operation,
    result,
  } as TfIntegrationsSuccessResponse;
}

function failure(
  command: GatewayCommand,
  code: TfIntegrationsErrorResponse["error"]["code"],
): TfIntegrationsErrorResponse {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    accountId: command.accountId,
    operation: command.operation,
    error: { code },
  };
}

function defaultResult(command: GatewayCommand): unknown {
  switch (command.operation) {
    case "yandex.token.upsert":
      return {
        account: {
          provider: "yandex",
          connected: true,
          account: { id: "12345", displayName: "Yandex User" },
        },
      };
    case "yandex.status":
      return {
        account: {
          provider: "yandex",
          connected: true,
          account: { id: "12345", displayName: "Yandex User" },
        },
      };
    case "yandex.disconnect":
      return { ok: true };
    case "yandex.liked.list":
    case "yandex.playlist-tracks.list":
      return {
        tracks: [track],
        total: 2,
        offset: command.input.offset,
        limit: command.input.limit,
      };
    case "yandex.playlists.list":
      return { playlists: [playlist], total: 1 };
    default:
      throw new Error(`unexpected operation: ${command.operation}`);
  }
}

function yandexDependencies(
  execute: (command: GatewayCommand) => Promise<
    TfIntegrationsSuccessResponse | TfIntegrationsErrorResponse
  > = async (command) => success(command, defaultResult(command)),
) {
  const gateway = {
    execute: vi.fn(execute),
  } as unknown as TfIntegrationsGateway;
  return {
    dependencies: { gateway } satisfies YandexRouteDependencies,
    execute: gateway.execute as ReturnType<typeof vi.fn>,
    gateway,
  };
}

async function startRouterServer(
  dependencies: YandexRouteDependencies,
  currentPrincipal: TfPrincipal = principal,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.tfPrincipal = currentPrincipal;
    next();
  });
  app.use("/api", createYandexRouter(dependencies));
  return startServer(app);
}

async function startServer(app: ReturnType<typeof express>): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
}

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function authFixture() {
  const sessionHandle = opaque();
  const csrfToken = opaque();
  const currentSession: TfSession = {
    id: TF_SESSION_ID,
    accountId: ACCOUNT_ID,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements: ["tf.integrations"],
    assertionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const sessionStore = {
    createTransaction: vi.fn(),
    consumeTransaction: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn().mockResolvedValue(currentSession),
    observeSession: vi.fn().mockResolvedValue({
      revision: opaque(),
      session: currentSession,
    }),
    refreshSession: vi.fn().mockResolvedValue(currentSession),
    revokeSession: vi.fn(),
    issueProviderOAuthState: vi.fn(),
    consumeProviderOAuthState: vi.fn(),
    issueWebSocketTicket: vi.fn(),
  };
  const platform = {
    createAuthorizationUrl: vi.fn(),
    exchangeCode: vi.fn(),
    introspect: vi.fn().mockResolvedValue({
      active: true,
      accountId: ACCOUNT_ID,
      sessionId: PLATFORM_SESSION_ID,
      installationId: INSTALLATION_ID,
      accountStatus: "active",
      entitlements: ["tf.integrations"],
      expiresAt: currentSession.expiresAt,
    }),
  };
  return {
    auth: {
      platform,
      sessionStore,
      webOrigin: WEB_ORIGIN,
      secureCookies: true,
    },
    cookie: `${AUTH_COOKIE_NAMES.session}=${sessionHandle}; ${AUTH_COOKIE_NAMES.csrf}=${csrfToken}`,
    csrfToken,
  };
}

function quietLogger() {
  return createTfLogger(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

afterEach(async () => {
  vi.doUnmock("@workspace/db/schema");
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Yandex gateway routes", () => {
  it("derives accountId only from tfPrincipal for every Yandex command", async () => {
    const current = yandexDependencies();
    const baseUrl = await startRouterServer(current.dependencies);
    const alias = `sessionId=${OTHER_ACCOUNT_ID}&sid=${OTHER_ACCOUNT_ID}`;
    const headers = { "x-client-session": OTHER_ACCOUNT_ID };

    await fetch(`${baseUrl}/yandex/token?${alias}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        token: "yandex-provider-token",
        accountId: OTHER_ACCOUNT_ID,
      }),
    });
    await fetch(`${baseUrl}/yandex/status?${alias}`, { headers });
    await fetch(`${baseUrl}/yandex/logout?${alias}`, {
      method: "POST",
      headers,
    });
    await fetch(`${baseUrl}/yandex/liked?offset=0&limit=1&${alias}`, {
      headers,
    });
    await fetch(`${baseUrl}/yandex/playlists?${alias}`, { headers });
    await fetch(
      `${baseUrl}/yandex/playlists/12345/7/tracks?offset=0&limit=1&${alias}`,
      { headers },
    );

    expect(current.execute).toHaveBeenCalledTimes(6);
    for (const [command] of current.execute.mock.calls as [
      GatewayCommand,
    ][]) {
      expect(command.accountId).toBe(ACCOUNT_ID);
      expect(JSON.stringify(command)).not.toContain(OTHER_ACCOUNT_ID);
    }
  });

  it("keeps token acceptance behind policy and CSRF and returns the existing public shape", async () => {
    const current = yandexDependencies();
    const auth = authFixture();
    const app = createApiApp({
      auth: auth.auth,
      integrationsGateway: current.gateway,
      nodeEnv: "production",
      requestLogger: quietLogger(),
    });
    const baseUrl = await startServer(app);
    const body = JSON.stringify({ token: "yandex-provider-token" });

    const rejected = await fetch(`${baseUrl}/yandex/token`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        origin: WEB_ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": "invalid",
      },
      body,
    });
    expect(rejected.status).toBe(403);
    expect(current.execute).not.toHaveBeenCalled();

    const accepted = await fetch(`${baseUrl}/yandex/token`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        origin: WEB_ORIGIN,
        "content-type": "application/json",
        "x-csrf-token": auth.csrfToken,
      },
      body,
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      ok: true,
      displayName: "Yandex User",
      login: null,
      userId: "12345",
    });
    expect(current.execute).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      operation: "yandex.token.upsert",
      input: { token: "yandex-provider-token" },
    });
  });

  it("preserves status, logout, liked, playlists, and playlist-track shapes", async () => {
    const current = yandexDependencies();
    const baseUrl = await startRouterServer(current.dependencies);

    const status = await fetch(`${baseUrl}/yandex/status`);
    const logout = await fetch(`${baseUrl}/yandex/logout`, { method: "POST" });
    const liked = await fetch(
      `${baseUrl}/yandex/liked?offset=0&limit=1`,
    );
    const playlists = await fetch(`${baseUrl}/yandex/playlists`);
    const playlistTracks = await fetch(
      `${baseUrl}/yandex/playlists/12345/7/tracks?offset=0&limit=1`,
    );

    await expect(status.json()).resolves.toEqual({
      connected: true,
      displayName: "Yandex User",
      login: null,
      userId: "12345",
    });
    await expect(logout.json()).resolves.toEqual({ ok: true });
    await expect(liked.json()).resolves.toEqual({
      tracks: [
        {
          id: "42",
          title: "Track",
          artist: "Artist",
          album: "Album",
          durationMs: 180_000,
          thumbnailUrl: "https://images.example.test/track.jpg",
          trackUrl: "https://music.yandex.ru/track/42",
        },
      ],
      total: 2,
      offset: 0,
      limit: 1,
    });
    await expect(playlists.json()).resolves.toEqual({
      playlists: [playlist],
      total: 1,
    });
    await expect(playlistTracks.json()).resolves.toEqual({
      tracks: [
        {
          id: "42",
          title: "Track",
          artist: "Artist",
          album: "Album",
          durationMs: 180_000,
          thumbnailUrl: "https://images.example.test/track.jpg",
          trackUrl: "https://music.yandex.ru/track/42",
        },
      ],
      total: 2,
      offset: 0,
      limit: 1,
    });
  });

  it("maps integration errors to existing sanitized Yandex errors", async () => {
    const canary = "private-yandex-token-canary";
    const current = yandexDependencies(async (command) => {
      if (command.operation === "yandex.token.upsert") {
        return failure(command, "provider_rejected");
      }
      if (command.operation === "yandex.status") {
        throw new TfIntegrationsUnavailableError();
      }
      if (command.operation === "yandex.disconnect") {
        return failure(command, "storage_unavailable");
      }
      return failure(command, "not_connected");
    });
    const baseUrl = await startRouterServer(current.dependencies);

    const token = await fetch(`${baseUrl}/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: canary }),
    });
    const status = await fetch(`${baseUrl}/yandex/status`);
    const logout = await fetch(`${baseUrl}/yandex/logout`, { method: "POST" });
    const liked = await fetch(`${baseUrl}/yandex/liked`);

    expect(token.status).toBe(401);
    await expect(token.json()).resolves.toEqual({
      error: "auth_failed",
      message: "Could not authenticate with Yandex Music. Check your token.",
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({ connected: false });
    expect(logout.status).toBe(503);
    await expect(logout.json()).resolves.toEqual({
      error: "yandex_unavailable",
    });
    expect(liked.status).toBe(401);
    await expect(liked.json()).resolves.toEqual({
      error: "not_connected",
      message: "Yandex Music session not found",
    });
  });

  it("never imports or calls the TF provider token tables", async () => {
    vi.resetModules();
    vi.doMock("@workspace/db/schema", () => {
      throw new Error("provider token table import attempted");
    });
    const isolatedRoute = await import("./yandex.js");
    const current = yandexDependencies();
    const baseUrl = await startRouterServer(current.dependencies);

    expect(isolatedRoute.createYandexRouter).toBeTypeOf("function");
    const response = await fetch(`${baseUrl}/yandex/status`);
    expect(response.status).toBe(200);
    expect(current.execute).toHaveBeenCalledOnce();
  });
});
