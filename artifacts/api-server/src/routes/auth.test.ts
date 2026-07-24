import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import cookieParser from "cookie-parser";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTfLogger } from "../lib/logger.js";
import { PlatformAuthUnavailableError } from "../lib/platform-auth-client.js";
import {
  TfSessionStoreUnavailableError,
  type TfAuthTransaction,
  type TfSession,
} from "../lib/tf-session-store.js";
import { AUTH_COOKIE_NAMES, createAuthRouter } from "./auth.js";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const WEB_ORIGIN = "https://tf.apollot.ru";
const PLATFORM_ORIGIN = "https://api.apollot.ru";
const CALLBACK_URL = "https://api.tf.apollot.ru/api/auth/callback";
const servers: Server[] = [];

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function claims(nonce: string) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: PLATFORM_ORIGIN,
    aud: "apollo-tf" as const,
    sub: ACCOUNT_ID,
    sid: PLATFORM_SESSION_ID,
    installation_id: INSTALLATION_ID,
    nonce,
    account_status: "active" as const,
    entitlements: ["tf.search"] as const,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
  };
}

function transaction(
  overrides: Partial<TfAuthTransaction> = {},
): TfAuthTransaction {
  const now = Date.now();
  return {
    state: opaque(),
    codeVerifier: opaque(),
    nonce: opaque(),
    installationId: INSTALLATION_ID,
    installationLabel: "Apollo TF Web",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<TfSession> = {}): TfSession {
  return {
    id: randomUUID(),
    accountId: ACCOUNT_ID,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements: ["tf.downloads", "tf.search"],
    assertionExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

function activeIntrospection() {
  return {
    active: true as const,
    accountId: ACCOUNT_ID,
    sessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    accountStatus: "active" as const,
    entitlements: ["tf.downloads", "tf.search"] as const,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  };
}

function createDependencies(
  overrides: {
    readonly transaction?: TfAuthTransaction | null;
    readonly tfSession?: TfSession | null;
  } = {},
) {
  const currentTransaction =
    overrides.transaction === undefined ? transaction() : overrides.transaction;
  const currentSession =
    overrides.tfSession === undefined ? session() : overrides.tfSession;
  const assertionClaims =
    currentTransaction === null
      ? claims(opaque())
      : claims(currentTransaction.nonce);
  const platform = {
    createAuthorizationUrl: vi.fn(
      (input: {
        codeChallenge: string;
        state: string;
        nonce: string;
        installationId: string;
        installationLabel: string;
      }) => {
        const url = new URL("/v1/oauth/authorize", PLATFORM_ORIGIN);
        url.searchParams.set("client_id", "apollo-tf-api");
        url.searchParams.set("redirect_uri", CALLBACK_URL);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("code_challenge", input.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("state", input.state);
        url.searchParams.set("nonce", input.nonce);
        url.searchParams.set("installation_id", input.installationId);
        url.searchParams.set("installation_label", input.installationLabel);
        return url.toString();
      },
    ),
    exchangeCode: vi.fn().mockResolvedValue({
      assertion: opaque(),
      claims: assertionClaims,
    }),
    introspect: vi.fn().mockResolvedValue(activeIntrospection()),
  };
  const sessionStore = {
    createTransaction: vi.fn().mockResolvedValue(opaque()),
    consumeTransaction: vi.fn().mockResolvedValue(currentTransaction),
    createSession: vi.fn().mockResolvedValue({
      handle: opaque(),
      session: currentSession ?? session(),
    }),
    getSession: vi.fn().mockResolvedValue(currentSession),
    observeSession: vi.fn(),
    refreshSession: vi.fn(),
    revokeSession: vi.fn().mockResolvedValue(true),
    issueProviderOAuthState: vi.fn(),
    consumeProviderOAuthState: vi.fn(),
    issueWebSocketTicket: vi.fn(),
    consumeWebSocketTicket: vi.fn(),
  };
  return {
    platform,
    sessionStore,
    webOrigin: WEB_ORIGIN,
    secureCookies: true,
  };
}

async function startAuthServer(
  dependencies: ReturnType<typeof createDependencies>,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cookieParser());
  app.use("/api/auth", createAuthRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/auth`;
}

function setCookies(response: Response): string[] {
  return (
    response.headers as unknown as { getSetCookie(): string[] }
  ).getSetCookie();
}

function cookieValue(response: Response, name: string): string {
  const cookie = setCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  );
  if (cookie === undefined) throw new Error(`Missing cookie ${name}`);
  return cookie.slice(name.length + 1).split(";", 1)[0]!;
}

function expectHostCookie(
  cookie: string,
  options: {
    readonly httpOnly: boolean;
    readonly maxAge?: number;
    readonly cleared?: boolean;
  },
): void {
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).not.toContain("Domain=");
  if (options.httpOnly) {
    expect(cookie).toContain("HttpOnly");
  } else {
    expect(cookie).not.toContain("HttpOnly");
  }
  if (options.maxAge !== undefined) {
    expect(cookie).toContain(`Max-Age=${options.maxAge}`);
  }
  if (options.cleared === true) {
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("GET /api/auth/start", () => {
  it("creates exact PKCE/state/nonce transaction before redirecting", async () => {
    const dependencies = createDependencies();
    const baseUrl = await startAuthServer(dependencies);

    const response = await fetch(`${baseUrl}/start`, {
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    const transactionInput =
      dependencies.sessionStore.createTransaction.mock.calls[0]?.[0];
    expect(transactionInput).toMatchObject({
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      installationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      installationLabel: "Apollo TF Web",
    });
    const authorizationInput =
      dependencies.platform.createAuthorizationUrl.mock.calls[0]?.[0];
    expect(authorizationInput).toEqual({
      codeChallenge: createHash("sha256")
        .update(transactionInput.codeVerifier, "ascii")
        .digest("base64url"),
      state: transactionInput.state,
      nonce: transactionInput.nonce,
      installationId: transactionInput.installationId,
      installationLabel: "Apollo TF Web",
    });
    expect(response.headers.get("location")).toBe(
      dependencies.platform.createAuthorizationUrl.mock.results[0]?.value,
    );
    expect(
      dependencies.sessionStore.createTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      dependencies.platform.createAuthorizationUrl.mock.invocationCallOrder[0]!,
    );

    const cookies = setCookies(response);
    const installationCookie = cookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIE_NAMES.installation}=`),
    )!;
    const transactionCookie = cookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIE_NAMES.transaction}=`),
    )!;
    expectHostCookie(installationCookie, {
      httpOnly: true,
      maxAge: 31_536_000,
    });
    expectHostCookie(transactionCookie, {
      httpOnly: true,
      maxAge: 300,
    });
  });

  it("reuses only a valid installation UUID cookie", async () => {
    const valid = createDependencies();
    const validBaseUrl = await startAuthServer(valid);
    await fetch(`${validBaseUrl}/start`, {
      redirect: "manual",
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.installation}=${INSTALLATION_ID}`,
      },
    });
    expect(
      valid.sessionStore.createTransaction.mock.calls[0]?.[0].installationId,
    ).toBe(INSTALLATION_ID);

    const invalid = createDependencies();
    const invalidBaseUrl = await startAuthServer(invalid);
    await fetch(`${invalidBaseUrl}/start`, {
      redirect: "manual",
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.installation}=not-a-uuid`,
      },
    });
    expect(
      invalid.sessionStore.createTransaction.mock.calls[0]?.[0].installationId,
    ).not.toBe("not-a-uuid");
  });

  it.each([
    "?redirect_uri=https://attacker.example/callback",
    "?client_id=attacker",
    "?return_url=https://attacker.example",
    "?state=one&state=two",
  ])("rejects unknown or duplicate local query input %s", async (query) => {
    const dependencies = createDependencies();
    const baseUrl = await startAuthServer(dependencies);

    const response = await fetch(`${baseUrl}/start${query}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "authentication_failed",
    });
    expect(dependencies.sessionStore.createTransaction).not.toHaveBeenCalled();
    expect(dependencies.platform.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("returns sanitized 503 without redirect or cookies when Redis is unavailable", async () => {
    const dependencies = createDependencies();
    dependencies.sessionStore.createTransaction.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const baseUrl = await startAuthServer(dependencies);

    const response = await fetch(`${baseUrl}/start`, {
      redirect: "manual",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(setCookies(response)).toEqual([]);
    await expect(response.json()).resolves.toEqual({
      error: "authentication_unavailable",
    });
  });
});

describe("GET /api/auth/callback", () => {
  it("consumes the transaction and rejects state mismatch before exchange", async () => {
    const stored = transaction();
    const dependencies = createDependencies({ transaction: stored });
    const baseUrl = await startAuthServer(dependencies);
    const handle = opaque();
    const code = opaque();

    const response = await fetch(
      `${baseUrl}/callback?code=${code}&state=${opaque()}`,
      {
        redirect: "manual",
        headers: {
          cookie: `${AUTH_COOKIE_NAMES.transaction}=${handle}`,
        },
      },
    );

    expect(response.status).toBe(400);
    expect(dependencies.sessionStore.consumeTransaction).toHaveBeenCalledWith(
      handle,
    );
    expect(dependencies.platform.exchangeCode).not.toHaveBeenCalled();
    expect(dependencies.sessionStore.createSession).not.toHaveBeenCalled();
    const cleared = setCookies(response).find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIE_NAMES.transaction}=`),
    )!;
    expectHostCookie(cleared, { httpOnly: true, cleared: true });
    expect(await response.text()).not.toContain(code);
    expect(await Promise.resolve(JSON.stringify(dependencies))).not.toContain(
      code,
    );
  });

  it("exchanges, verifies, introspects, binds, and rotates secure cookies", async () => {
    const stored = transaction();
    const createdSession = session();
    const dependencies = createDependencies({
      transaction: stored,
      tfSession: createdSession,
    });
    const sessionHandle = opaque();
    dependencies.sessionStore.createSession.mockResolvedValue({
      handle: sessionHandle,
      session: createdSession,
    });
    const baseUrl = await startAuthServer(dependencies);
    const transactionHandle = opaque();
    const code = opaque();

    const response = await fetch(
      `${baseUrl}/callback?code=${code}&state=${stored.state}`,
      {
        redirect: "manual",
        headers: {
          cookie: `${AUTH_COOKIE_NAMES.transaction}=${transactionHandle}`,
        },
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(WEB_ORIGIN);
    expect(dependencies.platform.exchangeCode).toHaveBeenCalledWith({
      code,
      codeVerifier: stored.codeVerifier,
      expectedNonce: stored.nonce,
    });
    const verifiedClaims =
      dependencies.platform.exchangeCode.mock.results[0]?.value;
    await verifiedClaims;
    expect(dependencies.platform.introspect).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      sessionId: PLATFORM_SESSION_ID,
      installationId: INSTALLATION_ID,
      audience: "apollo-tf",
    });
    expect(dependencies.sessionStore.createSession).toHaveBeenCalledWith({
      assertionClaims: expect.objectContaining({
        sub: ACCOUNT_ID,
        sid: PLATFORM_SESSION_ID,
        installation_id: INSTALLATION_ID,
        nonce: stored.nonce,
      }),
      introspection: expect.objectContaining({
        active: true,
        accountId: ACCOUNT_ID,
        sessionId: PLATFORM_SESSION_ID,
        installationId: INSTALLATION_ID,
        accountStatus: "active",
        entitlements: ["tf.downloads", "tf.search"],
      }),
    });

    const cookies = setCookies(response);
    expectHostCookie(
      cookies.find((cookie) =>
        cookie.startsWith(`${AUTH_COOKIE_NAMES.transaction}=`),
      )!,
      { httpOnly: true, cleared: true },
    );
    expectHostCookie(
      cookies.find((cookie) =>
        cookie.startsWith(`${AUTH_COOKIE_NAMES.session}=`),
      )!,
      { httpOnly: true },
    );
    const csrfCookie = cookies.find((cookie) =>
      cookie.startsWith(`${AUTH_COOKIE_NAMES.csrf}=`),
    )!;
    expectHostCookie(csrfCookie, { httpOnly: false });
    expect(cookieValue(response, AUTH_COOKIE_NAMES.session)).toBe(
      sessionHandle,
    );
    expect(cookieValue(response, AUTH_COOKIE_NAMES.csrf)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it("rejects callback transaction replay before a second exchange", async () => {
    const stored = transaction();
    const dependencies = createDependencies({ transaction: stored });
    dependencies.sessionStore.consumeTransaction
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(null);
    const baseUrl = await startAuthServer(dependencies);
    const handle = opaque();
    const query = `code=${opaque()}&state=${stored.state}`;

    const first = await fetch(`${baseUrl}/callback?${query}`, {
      redirect: "manual",
      headers: { cookie: `${AUTH_COOKIE_NAMES.transaction}=${handle}` },
    });
    const replay = await fetch(`${baseUrl}/callback?${query}`, {
      redirect: "manual",
      headers: { cookie: `${AUTH_COOKIE_NAMES.transaction}=${handle}` },
    });

    expect(first.status).toBe(303);
    expect(replay.status).toBe(400);
    expect(dependencies.platform.exchangeCode).toHaveBeenCalledTimes(1);
    expect(dependencies.sessionStore.createSession).toHaveBeenCalledTimes(1);
  });

  it("rejects Platform code replay generically without creating another session", async () => {
    const firstTransaction = transaction();
    const secondTransaction = transaction({
      state: firstTransaction.state,
      nonce: firstTransaction.nonce,
    });
    const dependencies = createDependencies({
      transaction: firstTransaction,
    });
    dependencies.sessionStore.consumeTransaction
      .mockResolvedValueOnce(firstTransaction)
      .mockResolvedValueOnce(secondTransaction);
    dependencies.platform.exchangeCode
      .mockResolvedValueOnce({
        assertion: opaque(),
        claims: claims(firstTransaction.nonce),
      })
      .mockRejectedValueOnce(new PlatformAuthUnavailableError());
    const baseUrl = await startAuthServer(dependencies);
    const code = opaque();
    const query = `code=${code}&state=${firstTransaction.state}`;

    const first = await fetch(`${baseUrl}/callback?${query}`, {
      redirect: "manual",
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.transaction}=${opaque()}`,
      },
    });
    const replay = await fetch(`${baseUrl}/callback?${query}`, {
      redirect: "manual",
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.transaction}=${opaque()}`,
      },
    });

    expect(first.status).toBe(303);
    expect(replay.status).toBe(503);
    expect(dependencies.sessionStore.createSession).toHaveBeenCalledTimes(1);
    expect(await replay.text()).not.toContain(code);
  });

  it.each([
    ["inactive", { active: false }],
    [
      "account mismatch",
      {
        ...activeIntrospection(),
        accountId: "40000000-0000-4000-8000-000000000004",
      },
    ],
    [
      "session mismatch",
      {
        ...activeIntrospection(),
        sessionId: "40000000-0000-4000-8000-000000000004",
      },
    ],
    [
      "installation mismatch",
      {
        ...activeIntrospection(),
        installationId: "40000000-0000-4000-8000-000000000004",
      },
    ],
  ])(
    "rejects %s introspection before session creation",
    async (_label, result) => {
      const stored = transaction();
      const dependencies = createDependencies({ transaction: stored });
      dependencies.platform.introspect.mockResolvedValue(result);
      const baseUrl = await startAuthServer(dependencies);

      const response = await fetch(
        `${baseUrl}/callback?code=${opaque()}&state=${stored.state}`,
        {
          redirect: "manual",
          headers: {
            cookie: `${AUTH_COOKIE_NAMES.transaction}=${opaque()}`,
          },
        },
      );

      expect(response.status).toBe(400);
      expect(dependencies.sessionStore.createSession).not.toHaveBeenCalled();
      expect(
        setCookies(response).some((cookie) =>
          cookie.startsWith(`${AUTH_COOKIE_NAMES.session}=`),
        ),
      ).toBe(false);
    },
  );

  it.each([
    `code=${opaque()}`,
    `state=${opaque()}`,
    `code=${opaque()}&state=${opaque()}&extra=bad`,
    `code=${opaque()}&code=${opaque()}&state=${opaque()}`,
    `code=${opaque()}&state=${opaque()}&state=${opaque()}`,
    `code=short&state=${opaque()}`,
    `code=${opaque()}&state=short`,
  ])(
    "consumes the transaction before rejecting malformed callback query %s",
    async (query) => {
      const dependencies = createDependencies();
      const baseUrl = await startAuthServer(dependencies);
      const transactionHandle = opaque();

      const response = await fetch(`${baseUrl}/callback?${query}`, {
        redirect: "manual",
        headers: {
          cookie: `${AUTH_COOKIE_NAMES.transaction}=${transactionHandle}`,
        },
      });

      expect(response.status).toBe(400);
      expect(
        dependencies.sessionStore.consumeTransaction,
      ).toHaveBeenCalledOnce();
      expect(dependencies.sessionStore.consumeTransaction).toHaveBeenCalledWith(
        transactionHandle,
      );
      expect(dependencies.platform.exchangeCode).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/auth/me", () => {
  it("returns only the bounded web session projection", async () => {
    const storedSession = session();
    const dependencies = createDependencies({ tfSession: storedSession });
    const baseUrl = await startAuthServer(dependencies);
    const handle = opaque();

    const response = await fetch(`${baseUrl}/me`, {
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.session}=${handle}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      accountId: ACCOUNT_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.downloads", "tf.search"],
      expiresAt: storedSession.expiresAt,
    });
    expect(dependencies.sessionStore.getSession).toHaveBeenCalledWith(handle);
  });

  it.each([
    ["missing cookie", undefined],
    ["invalid cookie", "invalid"],
    ["revoked session", opaque()],
  ])("returns the same 401 for %s", async (_label, handle) => {
    const dependencies = createDependencies({ tfSession: null });
    const baseUrl = await startAuthServer(dependencies);

    const response = await fetch(`${baseUrl}/me`, {
      headers:
        handle === undefined
          ? undefined
          : { cookie: `${AUTH_COOKIE_NAMES.session}=${handle}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
    });
  });

  it("fails closed with sanitized 503 when strict Redis is unavailable", async () => {
    const dependencies = createDependencies();
    dependencies.sessionStore.getSession.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const baseUrl = await startAuthServer(dependencies);

    const response = await fetch(`${baseUrl}/me`, {
      headers: {
        cookie: `${AUTH_COOKIE_NAMES.session}=${opaque()}`,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "authentication_unavailable",
    });
  });
});

describe("POST /api/auth/logout", () => {
  it("requires exact Origin, fixed-length matching CSRF, and a TF session", async () => {
    const csrf = opaque();
    const handle = opaque();
    for (const headers of [
      {
        origin: "https://attacker.example",
        "x-csrf-token": csrf,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${csrf}; ${AUTH_COOKIE_NAMES.session}=${handle}`,
      },
      {
        origin: WEB_ORIGIN,
        "x-csrf-token": `${csrf}x`,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${csrf}; ${AUTH_COOKIE_NAMES.session}=${handle}`,
      },
      {
        origin: WEB_ORIGIN,
        "x-csrf-token": csrf,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${csrf}`,
      },
    ]) {
      const dependencies = createDependencies();
      const baseUrl = await startAuthServer(dependencies);
      const response = await fetch(`${baseUrl}/logout`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(403);
      expect(dependencies.sessionStore.revokeSession).not.toHaveBeenCalled();
    }
  });

  it("revokes through strict Redis, clears auth cookies identically, and returns 204", async () => {
    const dependencies = createDependencies();
    const baseUrl = await startAuthServer(dependencies);
    const csrf = opaque();
    const handle = opaque();

    const response = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      headers: {
        origin: WEB_ORIGIN,
        "x-csrf-token": csrf,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${csrf}; ${AUTH_COOKIE_NAMES.session}=${handle}; ${AUTH_COOKIE_NAMES.transaction}=${opaque()}`,
      },
    });

    expect(response.status).toBe(204);
    expect(dependencies.sessionStore.revokeSession).toHaveBeenCalledWith(
      handle,
    );
    const cookies = setCookies(response);
    expectHostCookie(
      cookies.find((cookie) =>
        cookie.startsWith(`${AUTH_COOKIE_NAMES.session}=`),
      )!,
      { httpOnly: true, cleared: true },
    );
    expectHostCookie(
      cookies.find((cookie) =>
        cookie.startsWith(`${AUTH_COOKIE_NAMES.csrf}=`),
      )!,
      { httpOnly: false, cleared: true },
    );
    expectHostCookie(
      cookies.find((cookie) =>
        cookie.startsWith(`${AUTH_COOKIE_NAMES.transaction}=`),
      )!,
      { httpOnly: true, cleared: true },
    );
  });

  it("returns 503 but still clears browser cookies when revocation fails", async () => {
    const dependencies = createDependencies();
    dependencies.sessionStore.revokeSession.mockRejectedValue(
      new TfSessionStoreUnavailableError(),
    );
    const baseUrl = await startAuthServer(dependencies);
    const csrf = opaque();

    const response = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      headers: {
        origin: WEB_ORIGIN,
        "x-csrf-token": csrf,
        cookie: `${AUTH_COOKIE_NAMES.csrf}=${csrf}; ${AUTH_COOKIE_NAMES.session}=${opaque()}`,
      },
    });

    expect(response.status).toBe(503);
    expect(setCookies(response)).toHaveLength(3);
    await expect(response.json()).resolves.toEqual({
      error: "authentication_unavailable",
    });
  });
});

describe("TF auth logger hygiene", () => {
  it("deeply removes auth secrets, error messages, accessors, and serialization hooks", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const canaries = {
      authorization: `Basic ${opaque()}`,
      cookie: `session=${opaque()}`,
      assertion: opaque(),
      code: opaque(),
      state: opaque(),
      codeVerifier: opaque(),
      nonce: opaque(),
      clientSecret: opaque(),
      redisKey: `tf-auth:session:${opaque()}`,
      upstreamBody: opaque(),
      ticket: opaque(),
      errorText: opaque(),
    };
    const accessorObject: Record<string, unknown> = {};
    Object.defineProperty(accessorObject, "clientSecret", {
      enumerable: true,
      get: () => {
        throw new Error(canaries.clientSecret);
      },
    });

    logger.error(
      {
        nested: {
          ...canaries,
          array: [{ sessionToken: opaque() }],
          accessorObject,
          err: new Error(canaries.upstreamBody),
          stringError: { err: canaries.errorText },
          providerResponse: { text: canaries.upstreamBody },
          binary: Buffer.from(canaries.assertion, "utf8"),
          serializer: {
            toJSON: () => canaries.assertion,
          },
        },
      },
      "generic failure",
    );

    for (const canary of Object.values(canaries)) {
      expect(output).not.toContain(canary);
    }
    expect(output).not.toContain("toJSON");
    expect(output).toContain('"binary":"[Binary]"');
    expect(output).toContain("[REDACTED]");
  });

  it("does not invoke array accessors and sanitizes interpolation objects", () => {
    let output = "";
    let accessorInvoked = false;
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const arraySecret = opaque();
    const interpolationSecret = opaque();
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      enumerable: true,
      get: () => {
        accessorInvoked = true;
        return { assertion: arraySecret };
      },
    });
    values.length = 1;

    logger.error({ values }, "array accessor");
    logger.error("interpolated %j", {
      nested: { clientSecret: interpolationSecret },
    });

    expect(accessorInvoked).toBe(false);
    expect(output).not.toContain(arraySecret);
    expect(output).not.toContain(interpolationSecret);
    expect(output).toContain("[Accessor]");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts auth aliases and recursively sanitizes child bindings", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const canaries = {
      authorizationCode: opaque(),
      rawAuthorizationCode: opaque(),
      authorizationCodeDigest: opaque(),
      rawToken: opaque(),
      tokenDigest: opaque(),
      token: opaque(),
      oauthToken: opaque(),
      rawOauthToken: opaque(),
      oauthTokenDigest: opaque(),
      refreshToken: opaque(),
      providerAccessToken: opaque(),
      providerRefreshToken: opaque(),
      sessionHandle: opaque(),
      rawSessionHandle: opaque(),
      sessionDigest: opaque(),
      ticketHandle: opaque(),
      rawTicket: opaque(),
      ticketDigest: opaque(),
      password: opaque(),
    };
    const childSecret = opaque();
    const child = logger.child({
      nested: {
        clientSecret: childSecret,
        sessionHandle: canaries.sessionHandle,
      },
    });

    logger.error({ nested: canaries }, "alias canaries");
    logger.info({ tokenCount: 3 }, "safe token metadata");
    child.info({ event: "child-canary" }, "child binding canary");

    for (const canary of [...Object.values(canaries), childSecret]) {
      expect(output).not.toContain(canary);
    }
    expect(output).toContain('"tokenCount":3');
    expect(output).toContain("[REDACTED]");
  });

  it("drops child serializer overrides without invoking or mutating caller data", () => {
    let output = "";
    let serializerInvoked = false;
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const serializerCanary = opaque();
    const serializer = () => {
      serializerInvoked = true;
      return { clientSecret: serializerCanary };
    };
    const bindings = Object.freeze({ safe: "bound" });
    const serializers = Object.freeze({ safe: serializer });
    const childOptions = Object.freeze({ serializers });

    const child = logger.child(bindings, childOptions);
    child.info({ event: "child-serializer-canary" }, "child serializer canary");

    expect(serializerInvoked).toBe(false);
    expect(output).not.toContain(serializerCanary);
    expect(output).toContain('"safe":"bound"');
    expect(bindings).toEqual({ safe: "bound" });
    expect(childOptions.serializers).toBe(serializers);
    expect(serializers.safe).toBe(serializer);
  });

  it("projects HTTP bindings to inert primitives without invoking or mutating hooks", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createTfLogger(destination);
    const canaries = {
      requestId: opaque(),
      method: opaque(),
      url: opaque(),
      statusCode: opaque(),
    };
    const invocations = {
      requestId: 0,
      method: 0,
      url: 0,
      statusCode: 0,
    };
    const requestId = Object.freeze({
      toJSON() {
        invocations.requestId += 1;
        return canaries.requestId;
      },
    });
    const method = () => {
      invocations.method += 1;
      return canaries.method;
    };
    const url = Object.freeze({
      toJSON() {
        invocations.url += 1;
        return canaries.url;
      },
    });
    const statusCode = Object.freeze({
      toJSON() {
        invocations.statusCode += 1;
        return canaries.statusCode;
      },
    });
    const req = Object.freeze({ id: requestId, method, url });
    const res = Object.freeze({ statusCode });

    logger.info({ req, res }, "malicious HTTP projections");

    expect(invocations).toEqual({
      requestId: 0,
      method: 0,
      url: 0,
      statusCode: 0,
    });
    for (const canary of Object.values(canaries)) {
      expect(output).not.toContain(canary);
    }
    expect(req.id).toBe(requestId);
    expect(req.method).toBe(method);
    expect(req.url).toBe(url);
    expect(res.statusCode).toBe(statusCode);
  });

  it("mounts injected auth routes and omits auth query values from request logs", async () => {
    process.env["DATABASE_URL"] ??=
      "postgres://unused:unused@127.0.0.1:1/unused";
    const appModule = await import("../app.js");
    expect(appModule.createApiApp).toBeTypeOf("function");
    expect(appModule).not.toHaveProperty("default");
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const dependencies = createDependencies({ tfSession: null });
    const app = appModule.createApiApp({
      auth: dependencies,
      requestLogger: createTfLogger(destination),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const queryCanary = opaque();

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/auth/callback?code=${queryCanary}&state=${opaque()}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(400);
    expect(output).not.toContain(queryCanary);
    expect(output).not.toContain("?code=");

    const attackerOrigin = "https://localhost.attacker.example";
    const attackerResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/auth/me`,
      { headers: { origin: attackerOrigin } },
    );
    expect(
      attackerResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
  });
});
