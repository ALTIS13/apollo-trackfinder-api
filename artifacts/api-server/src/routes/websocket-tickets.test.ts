import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import {
  TfSessionNotFoundError,
  TfSessionStoreUnavailableError,
  type TfSession,
} from "../lib/tf-session-store.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const HANDLE = randomBytes(32).toString("base64url");
const TICKET = randomBytes(32).toString("base64url");
const REVISION = randomBytes(32).toString("base64url");
const servers: Server[] = [];

function session(
  entitlements: readonly string[] = ["tf.downloads", "tf.search"],
): TfSession {
  return {
    id: randomUUID(),
    accountId: ACCOUNT_ID,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements,
    assertionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function dependencies(entitlements?: readonly string[]) {
  const tfSession = session(entitlements);
  const introspection = {
    active: true as const,
    accountId: ACCOUNT_ID,
    sessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    accountStatus: "active" as const,
    entitlements: [...tfSession.entitlements],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return {
    platform: {
      createAuthorizationUrl: vi.fn(),
      exchangeCode: vi.fn(),
      introspect: vi.fn().mockResolvedValue(introspection),
    },
    sessionStore: {
      createTransaction: vi.fn(),
      consumeTransaction: vi.fn(),
      createSession: vi.fn(),
      getSession: vi.fn(),
      observeSession: vi
        .fn()
        .mockResolvedValue({ revision: REVISION, session: tfSession }),
      refreshSession: vi.fn().mockResolvedValue(tfSession),
      revokeSession: vi.fn(),
      issueProviderOAuthState: vi.fn(),
      consumeProviderOAuthState: vi.fn(),
      issueWebSocketTicket: vi.fn().mockResolvedValue(TICKET),
      consumeWebSocketTicket: vi.fn(),
    },
    webOrigin: "https://tf.apollot.ru",
    secureCookies: true,
  };
}

async function start(
  auth = dependencies(),
): Promise<{
  readonly origin: string;
  readonly auth: ReturnType<typeof dependencies>;
}> {
  const server = createApiApp({ auth }).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, auth };
}

async function rawPost(
  origin: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const url = new URL("/api/ws/tickets", origin);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const source = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: source.length === 0 ? null : JSON.parse(source),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("POST /api/ws/tickets", () => {
  it("issues one no-store ticket from the live-authorized TF cookie", async () => {
    const { origin, auth } = await start();

    const response = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
      headers: { cookie: `__Host-apollo_tf=${HANDLE}` },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ticket: TICKET });
    expect(auth.platform.introspect).toHaveBeenCalledOnce();
    expect(auth.sessionStore.issueWebSocketTicket).toHaveBeenCalledWith(HANDLE);
  });

  it("maps missing auth and missing entitlement to exact sanitized denials", async () => {
    const withoutSearch = dependencies([]);
    const { origin } = await start(withoutSearch);

    const missingCookie = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
    });
    const missingEntitlement = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
      headers: { cookie: `__Host-apollo_tf=${HANDLE}` },
    });

    expect(missingCookie.status).toBe(401);
    await expect(missingCookie.json()).resolves.toEqual({
      error: "unauthorized",
    });
    expect(missingEntitlement.status).toBe(403);
    await expect(missingEntitlement.json()).resolves.toEqual({
      error: "module_access_denied",
    });
    expect(
      withoutSearch.sessionStore.issueWebSocketTicket,
    ).not.toHaveBeenCalled();
  });

  it("rejects every query parameter and request body field", async () => {
    const { origin, auth } = await start();

    const responses = await Promise.all([
      fetch(`${origin}/api/ws/tickets?extra=1`, {
        method: "POST",
        headers: { cookie: `__Host-apollo_tf=${HANDLE}` },
      }),
      fetch(`${origin}/api/ws/tickets`, {
        method: "POST",
        headers: {
          cookie: `__Host-apollo_tf=${HANDLE}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      fetch(`${origin}/api/ws/tickets`, {
        method: "POST",
        headers: {
          cookie: `__Host-apollo_tf=${HANDLE}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400,
    ]);
    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual([
      { error: "invalid_request" },
      { error: "invalid_request" },
      { error: "invalid_request" },
    ]);
    expect(auth.sessionStore.issueWebSocketTicket).not.toHaveBeenCalled();
  });

  it("rejects every positive Content-Length and any Transfer-Encoding before issuance", async () => {
    const { origin, auth } = await start();

    const textBody = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
      headers: {
        cookie: `__Host-apollo_tf=${HANDLE}`,
        "content-type": "text/plain",
      },
      body: "x",
    });
    const chunked = await rawPost(origin, {
      cookie: `__Host-apollo_tf=${HANDLE}`,
      "transfer-encoding": "chunked",
    });

    expect(textBody.status).toBe(400);
    await expect(textBody.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(chunked).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(auth.sessionStore.issueWebSocketTicket).not.toHaveBeenCalled();
  });

  it("maps ticket storage failure to sanitized 503", async () => {
    const auth = dependencies();
    auth.sessionStore.issueWebSocketTicket.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const { origin } = await start(auth);

    const response = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
      headers: { cookie: `__Host-apollo_tf=${HANDLE}` },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "policy_unavailable",
    });
  });

  it("maps an authenticated session lost during atomic issuance to 401", async () => {
    const auth = dependencies();
    auth.sessionStore.issueWebSocketTicket.mockRejectedValue(
      new TfSessionNotFoundError(),
    );
    const { origin } = await start(auth);

    const response = await fetch(`${origin}/api/ws/tickets`, {
      method: "POST",
      headers: { cookie: `__Host-apollo_tf=${HANDLE}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
    });
  });
});
