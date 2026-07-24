import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "./app.js";
import { createTfLogger } from "./lib/logger.js";
import type { TfSearchGateway } from "./lib/tf-search-client.js";
import type { TfSession } from "./lib/tf-session-store.js";
import { AUTH_COOKIE_NAMES } from "./routes/auth.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const WEB_ORIGIN = "https://tf.apollot.ru";
const SIBLING_ORIGIN = "https://web.apollot.ru";
const LOOPBACK_ORIGIN = "http://127.0.0.1:3000";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const TF_SESSION_ID = "40000000-0000-4000-8000-000000000004";
const servers: Server[] = [];

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

interface AuthFixtureOptions {
  readonly sessionEntitlements?: readonly string[];
  readonly policyEntitlements?: readonly string[];
  readonly snapshotFresh?: boolean;
  readonly searchGateway?: TfSearchGateway;
}

function session(options: AuthFixtureOptions = {}): TfSession {
  return {
    id: TF_SESSION_ID,
    accountId: ACCOUNT_ID,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements: [...(options.sessionEntitlements ?? ["tf.search"])],
    assertionExpiresAt: new Date(
      Date.now() + (options.snapshotFresh === false ? -1_000 : 300_000),
    ).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function authDependencies(options: AuthFixtureOptions = {}) {
  const currentSession = session(options);
  const sessionHandle = opaque();
  const csrfToken = opaque();
  const ticket = opaque();
  const observation = {
    revision: opaque(),
    session: currentSession,
  };
  const activePolicy = {
    active: true as const,
    accountId: ACCOUNT_ID,
    sessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    accountStatus: "active" as const,
    entitlements: [...(options.policyEntitlements ?? ["tf.search"])],
    expiresAt: currentSession.expiresAt,
  };
  const platform = {
    createAuthorizationUrl: vi.fn(),
    exchangeCode: vi.fn(),
    introspect: vi.fn().mockResolvedValue(activePolicy),
  };
  const sessionStore = {
    createTransaction: vi.fn(),
    consumeTransaction: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn().mockResolvedValue(currentSession),
    observeSession: vi.fn().mockResolvedValue(observation),
    refreshSession: vi.fn().mockResolvedValue({
      ...currentSession,
      assertionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    revokeSession: vi.fn().mockResolvedValue(true),
    issueProviderOAuthState: vi.fn(),
    consumeProviderOAuthState: vi.fn(),
    issueWebSocketTicket: vi.fn().mockResolvedValue(ticket),
  };
  return {
    auth: {
      platform,
      sessionStore,
      webOrigin: WEB_ORIGIN,
      secureCookies: true,
    },
    csrfToken,
    sessionHandle,
    sessionStore,
    ticket,
  };
}

async function startAuthenticatedApp(options: AuthFixtureOptions = {}) {
  const dependencies = authDependencies(options);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const app = createApiApp({
    auth: dependencies.auth,
    nodeEnv: "production",
    requestLogger: createTfLogger(sink),
    ...(options.searchGateway === undefined
      ? {}
      : { tracks: { searchGateway: options.searchGateway } }),
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    ...dependencies,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function browserCookies(sessionHandle: string, csrfToken: string): string {
  return `${AUTH_COOKIE_NAMES.session}=${sessionHandle}; ${AUTH_COOKIE_NAMES.csrf}=${csrfToken}`;
}

afterEach(async () => {
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

describe("credentialed TF browser boundary", () => {
  it("allows only the configured web origin in production CORS", async () => {
    const current = await startAuthenticatedApp();
    const cookie = browserCookies(current.sessionHandle, current.csrfToken);

    for (const disallowedOrigin of [SIBLING_ORIGIN, LOOPBACK_ORIGIN]) {
      const response = await fetch(`${current.origin}/api/auth/me`, {
        headers: {
          cookie,
          origin: disallowedOrigin,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(
        response.headers.get("access-control-allow-credentials"),
      ).toBeNull();
    }

    const allowed = await fetch(`${current.origin}/api/auth/me`, {
      headers: {
        cookie,
        origin: WEB_ORIGIN,
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });

  it("rejects unsafe regular API requests before policy without all browser proofs", async () => {
    const current = await startAuthenticatedApp();
    const canary = `private-csrf-${opaque()}`;
    const attempts = [
      {
        origin: WEB_ORIGIN,
        cookie: `${AUTH_COOKIE_NAMES.session}=${current.sessionHandle}`,
      },
      {
        origin: SIBLING_ORIGIN,
        cookie: browserCookies(current.sessionHandle, current.csrfToken),
        "x-csrf-token": current.csrfToken,
      },
      {
        origin: WEB_ORIGIN,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${current.csrfToken}`,
        "x-csrf-token": current.csrfToken,
      },
      {
        origin: WEB_ORIGIN,
        cookie: browserCookies(current.sessionHandle, current.csrfToken),
        "x-csrf-token": canary,
      },
    ];

    for (const headers of attempts) {
      const response = await fetch(`${current.origin}/api/ws/tickets`, {
        method: "POST",
        headers,
      });
      const body = await response.text();
      expect(response.status).toBe(403);
      expect(body).toBe('{"error":"forbidden"}');
      expect(body).not.toContain(canary);
    }
    expect(current.sessionStore.observeSession).not.toHaveBeenCalled();
    expect(current.sessionStore.issueWebSocketTicket).not.toHaveBeenCalled();
  });

  it("allows a valid CSRF-bound mutation through policy and routing", async () => {
    const current = await startAuthenticatedApp();
    const response = await fetch(`${current.origin}/api/ws/tickets`, {
      method: "POST",
      headers: {
        cookie: browserCookies(current.sessionHandle, current.csrfToken),
        origin: WEB_ORIGIN,
        "x-csrf-token": current.csrfToken,
      },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ticket: current.ticket });
    expect(current.sessionStore.observeSession).toHaveBeenCalledOnce();
    expect(current.sessionStore.issueWebSocketTicket).toHaveBeenCalledWith(
      current.sessionHandle,
    );
  });

  it("does not dispatch search when tf.search is absent or revoked", async () => {
    const searchGateway = {
      search: vi.fn(),
      suggestions: vi.fn(),
    } satisfies TfSearchGateway;
    const absent = await startAuthenticatedApp({
      sessionEntitlements: [],
      searchGateway,
    });
    const revoked = await startAuthenticatedApp({
      sessionEntitlements: ["tf.search"],
      policyEntitlements: [],
      snapshotFresh: false,
      searchGateway,
    });

    for (const current of [absent, revoked]) {
      const response = await fetch(`${current.origin}/api/tracks/search`, {
        method: "POST",
        headers: {
          cookie: browserCookies(current.sessionHandle, current.csrfToken),
          origin: WEB_ORIGIN,
          "x-csrf-token": current.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ artist: "Artist", title: "Track" }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "module_access_denied",
      });
    }
    expect(searchGateway.search).not.toHaveBeenCalled();
    expect(searchGateway.suggestions).not.toHaveBeenCalled();
  });

  it("returns the current CSRF token from me and supports browser logout", async () => {
    const current = await startAuthenticatedApp();
    const cookie = browserCookies(current.sessionHandle, current.csrfToken);
    const me = await fetch(`${current.origin}/api/auth/me`, {
      headers: {
        cookie,
        origin: WEB_ORIGIN,
      },
    });
    const body = (await me.json()) as Record<string, unknown>;

    expect(me.status).toBe(200);
    expect(body).toMatchObject({
      accountId: ACCOUNT_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.search"],
      csrfToken: current.csrfToken,
    });
    expect(body).not.toHaveProperty("sessionId");
    expect(body).not.toHaveProperty("platformSessionId");
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).not.toHaveProperty("providerCredentials");

    const logout = await fetch(`${current.origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: WEB_ORIGIN,
        "x-csrf-token": String(body.csrfToken),
      },
    });
    expect(logout.status).toBe(204);
    expect(current.sessionStore.revokeSession).toHaveBeenCalledWith(
      current.sessionHandle,
    );
  });

  it("keeps service module heartbeats outside browser session CSRF", async () => {
    const current = await startAuthenticatedApp();
    const response = await fetch(
      `${current.origin}/api/internal/modules/search-media/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: SIBLING_ORIGIN,
        },
        body: "{}",
      },
    );

    expect(response.status).not.toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "heartbeat_disabled",
    });
  });
});
