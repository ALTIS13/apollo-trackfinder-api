import { createServer, request as httpRequest, type Server } from "node:http";

import { PROTECTED_PLATFORM_ROUTES } from "@workspace/platform-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlatformApp,
  REGISTERED_PROTECTED_PLATFORM_ROUTES,
  type PlatformApiDependencies,
} from "../app.js";
import { platformDomainError } from "../domain/errors.js";
import { createPlatformLogger } from "../logger.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const origin = "https://admin.apollo.test";
const now = new Date("2026-07-16T10:00:00.000Z");
const portalSessionToken = "p".repeat(43);
const portalCsrfToken = "c".repeat(43);
const clientId = "apollo-tf-api";
const clientSecret = "client-secret-\u03c0";
const basicAuthorization = `Basic ${Buffer.from(
  `${clientId}:${clientSecret}`,
  "utf8",
).toString("base64")}`;
const registeredRedirectUri =
  "https://api.tf.apollot.ru/api/auth/callback?registered=1";
const authorizationState = "s".repeat(43);
const authorizationNonce = "n".repeat(43);
const codeChallenge = "A".repeat(43);
const codeVerifier = "v".repeat(43);
const authorizationCode = "o".repeat(32);
const installationId = "77777777-7777-4777-8777-777777777777";

const account = {
  id: accountId,
  email: "member@example.test",
  displayName: "Member",
  status: "pending" as const,
  emailVerifiedAt: null,
  activatedAt: null,
  suspendedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

const entitlement = {
  id: "44444444-4444-4444-8444-444444444444",
  accountId,
  moduleId: "55555555-5555-4555-8555-555555555555",
  moduleKey: "tf.search",
  moduleState: "active" as const,
  expiresAt: null,
  revokedAt: null,
  source: "operator",
  grantedByAccountId: accountId,
  reason: "Access approved",
  createdAt: now,
  updatedAt: now,
};

type TestPlatformApiDependencies = PlatformApiDependencies & {
  readonly userSessions: {
    login: ReturnType<typeof vi.fn>;
    authenticate: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  readonly authorization: {
    issueCode: ReturnType<typeof vi.fn>;
    exchangeCode: ReturnType<typeof vi.fn>;
    introspect: ReturnType<typeof vi.fn>;
  };
  readonly assertionSigner: {
    publicJwks: ReturnType<typeof vi.fn>;
  };
  readonly introspectionClientId: string;
};

function createDependencies(
  overrides: Partial<TestPlatformApiDependencies> = {},
): TestPlatformApiDependencies {
  return {
    registration: {
      getStatus: vi.fn().mockResolvedValue({ mode: "open_approval" }),
      register: vi.fn().mockResolvedValue({
        account,
        verificationToken: "verification-secret",
      }),
      consumeVerificationToken: vi.fn().mockResolvedValue(account),
      changeMode: vi.fn().mockResolvedValue({ mode: "invite_only" }),
      activateAccount: vi.fn().mockResolvedValue({
        ...account,
        status: "active",
      }),
      suspendAccount: vi.fn().mockResolvedValue({
        ...account,
        status: "suspended",
      }),
    },
    invitations: {
      redeem: vi.fn().mockResolvedValue({
        account,
        verificationToken: "verification-secret",
      }),
      create: vi.fn().mockResolvedValue({
        rawToken: "invitation-secret",
        invitation: {
          id: "66666666-6666-4666-8666-666666666666",
          expiresAt: now,
          usesLimit: 1,
          usesRemaining: 1,
          emailBound: false,
          moduleKeys: ["tf.search"],
        },
      }),
      revoke: vi.fn().mockResolvedValue({
        id: "66666666-6666-4666-8666-666666666666",
        expiresAt: now,
        usesLimit: 1,
        usesRemaining: 1,
        emailBound: false,
        moduleKeys: ["tf.search"],
      }),
    },
    operatorSessions: {
      bootstrap: vi.fn().mockResolvedValue({ ...account, status: "active" }),
      login: vi.fn().mockResolvedValue({
        account: { ...account, status: "active" },
        session: {
          id: sessionId,
          accountId,
          installationId: null,
          audience: "apollo-admin",
          expiresAt: new Date("2026-07-16T18:00:00.000Z"),
          revokedAt: null,
          createdAt: now,
          lastSeenAt: now,
        },
        rawToken: "admin-session-secret",
      }),
      authenticate: vi.fn().mockResolvedValue({
        accountId,
        sessionId,
        capabilities: Object.values(PROTECTED_PLATFORM_ROUTES).flat(),
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
    entitlements: {
      grant: vi.fn().mockResolvedValue(entitlement),
      revoke: vi.fn().mockResolvedValue({ ...entitlement, revokedAt: now }),
    },
    userSessions: {
      login: vi.fn().mockResolvedValue({
        account: {
          ...account,
          status: "active",
          emailVerifiedAt: now,
          activatedAt: now,
        },
        session: {
          id: sessionId,
          accountId,
          installationId: null,
          audience: "apollo-portal",
          expiresAt: new Date("2026-07-16T18:00:00.000Z"),
          revokedAt: null,
          createdAt: now,
          lastSeenAt: now,
        },
        rawToken: portalSessionToken,
      }),
      authenticate: vi.fn().mockResolvedValue({
        accountId,
        sessionId,
        status: "active",
        emailVerified: true,
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
    authorization: {
      issueCode: vi.fn().mockResolvedValue({
        rawCode: authorizationCode,
        redirectUri: registeredRedirectUri,
        state: authorizationState,
      }),
      exchangeCode: vi.fn().mockResolvedValue({
        assertion: "signed-platform-assertion",
        claims: {
          iss: "https://api.apollot.ru",
          aud: "apollo-tf",
          sub: accountId,
          sid: sessionId,
          installation_id: installationId,
          nonce: authorizationNonce,
          account_status: "active",
          entitlements: ["tf.search"],
          jti: "88888888-8888-4888-8888-888888888888",
          iat: 1,
          nbf: 1,
          exp: 301,
        },
        expiresIn: 300,
        tokenType: "Bearer",
      }),
      introspect: vi.fn().mockResolvedValue({
        active: true,
        accountId,
        sessionId,
        installationId,
        accountStatus: "active",
        entitlements: ["tf.search"],
        expiresAt: "2026-07-16T18:00:00.000Z",
      }),
    },
    assertionSigner: {
      publicJwks: vi.fn().mockReturnValue({
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            alg: "EdDSA",
            use: "sig",
            kid: "current",
            x: "x".repeat(43),
          },
        ],
      }),
    },
    introspectionClientId: clientId,
    readiness: vi.fn().mockResolvedValue(true),
    rateLimiter: {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
    },
    allowedOrigins: [origin],
    bootstrapSecret: "bootstrap-secret",
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

async function startApp(dependencies = createDependencies()) {
  const server = createServer(createPlatformApp(dependencies));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return {
    dependencies,
    port: address.port,
    request: (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init),
    server,
  };
}

async function rawAppRequest(
  path: string,
  options: {
    readonly method: string;
    readonly headers?: string[] | Record<string, string | string[]>;
    readonly body?: string;
  },
  dependencies = createDependencies(),
) {
  const app = await startApp(dependencies);
  servers.push(app.server);
  return new Promise<{ readonly status: number; readonly body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: app.port,
          path,
          method: options.method,
          headers: options.headers,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body }),
          );
        },
      );
      request.on("error", reject);
      request.end(options.body);
    },
  );
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function appRequest(
  path: string,
  init?: RequestInit,
  dependencies = createDependencies(),
) {
  const app = await startApp(dependencies);
  servers.push(app.server);
  return { response: await app.request(path, init), dependencies };
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

function form(body: string, headers: Record<string, string> = {}) {
  return {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  } satisfies RequestInit;
}

function adminHeaders(csrf = "csrf-token") {
  return {
    origin,
    cookie: `__Host-apollo_admin=admin-session-secret; __Host-apollo_admin_csrf=${csrf}`,
    "x-csrf-token": csrf,
  };
}

function portalHeaders(csrf = portalCsrfToken) {
  return {
    origin,
    cookie: `__Host-apollo_portal=${portalSessionToken}; __Host-apollo_portal_csrf=${csrf}`,
    "x-csrf-token": csrf,
  };
}

function authorizationQuery(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    client_id: "apollo-tf-web",
    redirect_uri: "https://untrusted-request.example/callback",
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: authorizationState,
    nonce: authorizationNonce,
    installation_id: installationId,
    installation_label: "Firefox on Windows",
    ...overrides,
  }).toString();
}

function tokenForm(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: registeredRedirectUri,
    code_verifier: codeVerifier,
    ...overrides,
  }).toString();
}

describe("platform HTTP API", () => {
  it("uses the exact protected route manifest", () => {
    expect(REGISTERED_PROTECTED_PLATFORM_ROUTES).toEqual(
      PROTECTED_PLATFORM_ROUTES,
    );
  });

  it("fails application construction when the actual protected route mapping drifts", () => {
    const drifted = {
      ...REGISTERED_PROTECTED_PLATFORM_ROUTES,
      "PATCH /v1/operator/registration-settings": [],
    } as unknown as typeof REGISTERED_PROTECTED_PLATFORM_ROUTES;

    expect(() => createPlatformApp(createDependencies(), drifted)).toThrow(
      "Protected operator route mapping mismatch",
    );
  });

  it("registers every protected route through capability middleware", () => {
    const app = createPlatformApp(createDependencies());
    const registered = Object.fromEntries(
      (
        app.router.stack as Array<{
          route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: Array<{
              handle: { requiredCapabilities?: readonly string[] };
            }>;
          };
        }>
      ).flatMap(({ route }) => {
        if (route === undefined) return [];
        const method = Object.keys(route.methods)[0];
        const capabilities = route.stack[0]?.handle.requiredCapabilities;
        return capabilities === undefined || capabilities.length === 0
          ? []
          : [[`${method.toUpperCase()} ${route.path}`, capabilities]];
      }),
    );
    expect(registered).toEqual(PROTECTED_PLATFORM_ROUTES);
  });

  it("serves liveness and gates readiness without migrations", async () => {
    const { response: health } = await appRequest("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const dependencies = createDependencies({
      readiness: vi.fn().mockResolvedValue(false),
    });
    const { response } = await appRequest("/readyz", undefined, dependencies);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "policy_unavailable",
      requestId: expect.any(String),
    });
  });

  it("returns registration mode with identity hardening headers and request IDs", async () => {
    const { response } = await appRequest("/v1/registration", {
      headers: { "x-request-id": requestId },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ mode: "open_approval" });
  });

  it("replaces malformed request IDs and maps unknown failures to stable public errors", async () => {
    const dependencies = createDependencies({
      registration: {
        ...createDependencies().registration,
        getStatus: vi
          .fn()
          .mockRejectedValue(new Error("postgres password=leak")),
      },
    });
    const { response } = await appRequest(
      "/v1/registration",
      { headers: { "x-request-id": "not-a-uuid" } },
      dependencies,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await response.json()).toEqual({
      error: "policy_unavailable",
      requestId: expect.any(String),
    });
  });

  it("requires JSON for every body-bearing request while allowing empty logout", async () => {
    const { response: noJson } = await appRequest("/v1/registrations", {
      method: "POST",
      body: "not json",
    });
    expect(noJson.status).toBe(400);

    const { response: extraField, dependencies } = await appRequest(
      "/v1/registrations",
      {
        method: "POST",
        ...json({
          email: "member@example.test",
          displayName: "Member",
          password: "password",
          unexpected: true,
        }),
      },
    );
    expect(extraField.status).toBe(400);
    expect(dependencies.registration.register).not.toHaveBeenCalled();

    const { response: tooLarge } = await appRequest("/v1/registrations", {
      method: "POST",
      ...json({ value: "a".repeat(65 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    const getWithTextBody = await rawAppRequest("/v1/registration", {
      method: "GET",
      headers: { "content-length": "8" },
      body: "not json",
    });
    expect(getWithTextBody.status).toBe(400);

    const { response: emptyLogout } = await appRequest(
      "/v1/operator/sessions/current",
      {
        method: "DELETE",
        headers: { ...adminHeaders(), "content-length": "0" },
      },
    );
    expect(emptyLogout.status).toBe(204);
  });

  it("dispatches open registration and invitation redemption through injected services", async () => {
    const dependencies = createDependencies();
    const { response } = await appRequest(
      "/v1/registrations",
      {
        method: "POST",
        ...json({
          email: "member@example.test",
          displayName: "Member",
          password: "password",
        }),
      },
      dependencies,
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({
      account: expect.objectContaining({ id: accountId, status: "pending" }),
    });
    expect(dependencies.registration.register).toHaveBeenCalledWith(
      expect.objectContaining({ email: "member@example.test" }),
      { correlationId: expect.any(String) },
    );
    expect(JSON.stringify(body)).not.toContain("secret");

    const invite = createDependencies();
    const { response: inviteResponse } = await appRequest(
      "/v1/registrations",
      {
        method: "POST",
        ...json({
          email: "member@example.test",
          displayName: "Member",
          password: "password",
          invitationToken: "invite-secret",
        }),
      },
      invite,
    );
    expect(inviteResponse.status).toBe(202);
    expect(invite.invitations.redeem).toHaveBeenCalledWith(
      expect.objectContaining({ invitationToken: "invite-secret" }),
      { correlationId: expect.any(String) },
    );
    expect(invite.registration.register).not.toHaveBeenCalled();
  });

  it("consumes verification tokens through a strict DTO and maps domain codes", async () => {
    const dependencies = createDependencies({
      registration: {
        ...createDependencies().registration,
        consumeVerificationToken: vi
          .fn()
          .mockRejectedValue(platformDomainError("registration_not_available")),
      },
    });
    const { response } = await appRequest(
      "/v1/email-verifications/consume",
      { method: "POST", ...json({ token: "verification-secret" }) },
      dependencies,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "registration_not_available",
      requestId: expect.any(String),
    });
  });

  it("reflects only exact allowed CORS origins", async () => {
    const { response: allowed } = await appRequest("/v1/registration", {
      headers: { origin },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );

    const { response: rejected } = await appRequest("/v1/registration", {
      headers: { origin: "https://admin.apollo.test.evil" },
    });
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("creates and authenticates a portal session without exposing its token", async () => {
    const dependencies = createDependencies();
    const { response: missingOrigin } = await appRequest(
      "/v1/sessions",
      {
        method: "POST",
        ...json({
          email: "member@example.test",
          password: "password-secret",
        }),
      },
      dependencies,
    );
    expect(missingOrigin.status).toBe(403);
    expect(dependencies.userSessions.login).not.toHaveBeenCalled();

    const { response } = await appRequest(
      "/v1/sessions",
      {
        method: "POST",
        ...json(
          {
            email: "MEMBER@example.test",
            password: "password-secret",
          },
          { origin },
        ),
      },
      dependencies,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      accountId,
      sessionId,
      status: "active",
      emailVerified: true,
      audience: "apollo-portal",
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(body)).not.toContain(portalSessionToken);
    expect(JSON.stringify(body)).not.toContain("password-secret");
    expect(dependencies.rateLimiter.consume).toHaveBeenCalledWith({
      bucket: "user-login",
      ip: expect.any(String),
      identity: "member@example.test",
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(
            `^__Host-apollo_portal=${portalSessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax$`,
          ),
        ),
        expect.stringMatching(
          /^__Host-apollo_portal_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Lax$/,
        ),
      ]),
    );
    expect(cookies.join(";")).not.toContain("Domain=");

    const { response: current } = await appRequest(
      "/v1/session",
      {
        headers: { cookie: `__Host-apollo_portal=${portalSessionToken}` },
      },
      dependencies,
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      accountId,
      sessionId,
      status: "active",
      emailVerified: true,
      audience: "apollo-portal",
    });
    expect(dependencies.userSessions.authenticate).toHaveBeenCalledWith(
      portalSessionToken,
    );
  });

  it("requires exact origin and fixed-length portal CSRF before clearing a valid session", async () => {
    const dependencies = createDependencies();
    for (const headers of [
      {
        ...portalHeaders(),
        origin: "https://admin.apollo.test.evil",
      },
      {
        ...portalHeaders(),
        "x-csrf-token": `${portalCsrfToken}x`,
      },
      {
        ...portalHeaders(),
        "x-csrf-token": `${"d".repeat(42)}c`,
      },
    ]) {
      const { response } = await appRequest(
        "/v1/session",
        { method: "DELETE", headers },
        dependencies,
      );
      expect(response.status).toBe(403);
    }
    expect(dependencies.userSessions.revoke).not.toHaveBeenCalled();

    const { response } = await appRequest(
      "/v1/session",
      { method: "DELETE", headers: portalHeaders() },
      dependencies,
    );
    expect(response.status).toBe(204);
    expect(dependencies.userSessions.revoke).toHaveBeenCalledWith(
      portalSessionToken,
      { correlationId: expect.any(String) },
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("__Host-apollo_portal=; Max-Age=0; Path=/;");
    expect(cookies[0]).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookies[1]).toContain(
      "__Host-apollo_portal_csrf=; Max-Age=0; Path=/;",
    );
    expect(cookies[1]).not.toContain("HttpOnly");
    expect(cookies[1]).toContain("Secure; SameSite=Lax");
    expect(cookies.join(";")).not.toContain("Domain=");
  });

  it("authorizes only active portal users and redirects from the issued registered URI", async () => {
    const dependencies = createDependencies();
    const { response } = await appRequest(
      `/v1/oauth/authorize?${authorizationQuery()}`,
      {
        headers: { cookie: `__Host-apollo_portal=${portalSessionToken}` },
        redirect: "manual",
      },
      dependencies,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${registeredRedirectUri}&code=${authorizationCode}&state=${authorizationState}`,
    );
    expect(dependencies.authorization.issueCode).toHaveBeenCalledWith(
      {
        accountId,
        sessionId,
        status: "active",
        emailVerified: true,
      },
      {
        clientId: "apollo-tf-web",
        redirectUri: "https://untrusted-request.example/callback",
        responseType: "code",
        codeChallenge,
        codeChallengeMethod: "S256",
        state: authorizationState,
        nonce: authorizationNonce,
        installationId,
        installationLabel: "Firefox on Windows",
      },
      { correlationId: expect.any(String) },
    );

    const pending = createDependencies({
      userSessions: {
        ...createDependencies().userSessions,
        authenticate: vi.fn().mockResolvedValue({
          accountId,
          sessionId,
          status: "pending",
          emailVerified: true,
        }),
      },
    });
    const { response: denied } = await appRequest(
      `/v1/oauth/authorize?${authorizationQuery()}`,
      { headers: { cookie: `__Host-apollo_portal=${portalSessionToken}` } },
      pending,
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "account_access_denied",
      requestId: expect.any(String),
    });
    expect(pending.authorization.issueCode).not.toHaveBeenCalled();
  });

  it("uses strict exact and bounded parsers for the new session and OAuth bodies", async () => {
    const dependencies = createDependencies();
    const { response: sessionText } = await appRequest(
      "/v1/sessions",
      {
        method: "POST",
        headers: { "content-type": "text/plain", origin },
        body: "{}",
      },
      dependencies,
    );
    expect(sessionText.status).toBe(400);

    const { response: tokenJson } = await appRequest(
      "/v1/oauth/token",
      {
        method: "POST",
        ...json(
          {
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: registeredRedirectUri,
            code_verifier: codeVerifier,
          },
          { authorization: basicAuthorization },
        ),
      },
      dependencies,
    );
    expect(tokenJson.status).toBe(400);

    const { response: introspectionForm } = await appRequest(
      "/v1/oauth/introspect",
      {
        method: "POST",
        ...form(
          new URLSearchParams({
            accountId,
            sessionId,
            installationId,
            audience: "apollo-tf",
          }).toString(),
          { authorization: basicAuthorization },
        ),
      },
      dependencies,
    );
    expect(introspectionForm.status).toBe(400);

    const hugeBody = `code=${"a".repeat(9 * 1024)}`;
    const oversized = await rawAppRequest("/v1/oauth/token", {
      method: "POST",
      headers: {
        authorization: basicAuthorization,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(hugeBody)),
      },
      body: hugeBody,
    });
    expect(oversized.status).toBe(413);
    expect(dependencies.authorization.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw JSON keys before session login", async () => {
    const dependencies = createDependencies();
    const sessionBody =
      '{"email":"attacker@example.test","email":"member@example.test","password":"password-secret"}';
    const session = await rawAppRequest(
      "/v1/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(sessionBody)),
          origin,
        },
        body: sessionBody,
      },
      dependencies,
    );
    expect(session.status).toBe(400);
    expect(dependencies.userSessions.login).not.toHaveBeenCalled();
  });

  it("rejects duplicate raw JSON keys before introspection", async () => {
    const dependencies = createDependencies();
    const introspectionBody = `{"accountId":"99999999-9999-4999-8999-999999999999","accountId":"${accountId}","sessionId":"${sessionId}","installationId":"${installationId}","audience":"apollo-tf"}`;
    const introspection = await rawAppRequest(
      "/v1/oauth/introspect",
      {
        method: "POST",
        headers: {
          authorization: basicAuthorization,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(introspectionBody)),
        },
        body: introspectionBody,
      },
      dependencies,
    );
    expect(introspection.status).toBe(400);
    expect(dependencies.authorization.introspect).not.toHaveBeenCalled();
  });

  it.each([
    [
      "session JSON with an unsupported charset",
      "/v1/sessions",
      {
        "content-type": "application/json; charset=iso-8859-1",
        origin,
      },
      JSON.stringify({
        email: "member@example.test",
        password: "password-secret",
      }),
      "login",
    ],
    [
      "introspection JSON with an unsupported charset",
      "/v1/oauth/introspect",
      {
        authorization: basicAuthorization,
        "content-type": "application/json; charset=iso-8859-1",
      },
      JSON.stringify({
        accountId,
        sessionId,
        installationId,
        audience: "apollo-tf",
      }),
      "introspect",
    ],
    [
      "session JSON with an unsupported content encoding",
      "/v1/sessions",
      {
        "content-encoding": "compress",
        "content-type": "application/json",
        origin,
      },
      JSON.stringify({
        email: "member@example.test",
        password: "password-secret",
      }),
      "login",
    ],
    [
      "introspection JSON with an unsupported content encoding",
      "/v1/oauth/introspect",
      {
        authorization: basicAuthorization,
        "content-encoding": "compress",
        "content-type": "application/json",
      },
      JSON.stringify({
        accountId,
        sessionId,
        installationId,
        audience: "apollo-tf",
      }),
      "introspect",
    ],
  ] as const)(
    "maps %s to a generic validation failure",
    async (_name, path, headers, body, serviceMethod) => {
      const dependencies = createDependencies();
      const result = await rawAppRequest(
        path,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        },
        dependencies,
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        error: "validation_failed",
        requestId: expect.any(String),
      });
      expect(
        serviceMethod === "login"
          ? dependencies.userSessions.login
          : dependencies.authorization.introspect,
      ).not.toHaveBeenCalled();
    },
  );

  it("keeps excessive form parameters mapped to payload too large", async () => {
    const dependencies = createDependencies();
    const body = Array.from(
      { length: 9 },
      (_value, index) => `field${index}=value`,
    ).join("&");
    const result = await rawAppRequest(
      "/v1/oauth/token",
      {
        method: "POST",
        headers: {
          authorization: basicAuthorization,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      },
      dependencies,
    );

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({
      error: "payload_too_large",
      requestId: expect.any(String),
    });
    expect(dependencies.authorization.exchangeCode).not.toHaveBeenCalled();
  });

  it("exchanges an authorization code from exact form fields and Basic credentials", async () => {
    const dependencies = createDependencies();
    const { response } = await appRequest(
      "/v1/oauth/token",
      {
        method: "POST",
        ...form(tokenForm(), { authorization: basicAuthorization }),
      },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      access_token: "signed-platform-assertion",
      token_type: "Bearer",
      expires_in: 300,
    });
    expect(dependencies.authorization.exchangeCode).toHaveBeenCalledWith(
      {
        grantType: "authorization_code",
        clientId,
        code: authorizationCode,
        redirectUri: registeredRedirectUri,
        codeVerifier,
      },
      clientSecret,
      { correlationId: expect.any(String) },
    );
  });

  it.each([
    ["missing header", undefined],
    ["wrong scheme", "Bearer not-basic"],
    ["missing colon", `Basic ${Buffer.from("client").toString("base64")}`],
    ["empty client ID", `Basic ${Buffer.from(":secret").toString("base64")}`],
    ["empty secret", `Basic ${Buffer.from("client:").toString("base64")}`],
    [
      "non-canonical base64",
      `Basic ${Buffer.from("client:secret").toString("base64").replace(/=+$/, "")}`,
    ],
    [
      "fatal UTF-8",
      `Basic ${Buffer.from([0x61, 0x3a, 0xc3, 0x28]).toString("base64")}`,
    ],
    [
      "oversized secret",
      `Basic ${Buffer.from(`client:${"x".repeat(513)}`).toString("base64")}`,
    ],
  ])(
    "rejects %s generically in the strict Basic parser",
    async (_name, value) => {
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (value !== undefined) headers.authorization = value;
      const result = await rawAppRequest("/v1/oauth/token", {
        method: "POST",
        headers,
        body: tokenForm(),
      });
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: "invalid_client",
        requestId: expect.any(String),
      });
    },
  );

  it("rejects duplicate raw Authorization headers before code exchange", async () => {
    const dependencies = createDependencies();
    const body = tokenForm();
    const result = await rawAppRequest(
      "/v1/oauth/token",
      {
        method: "POST",
        headers: {
          authorization: [basicAuthorization, basicAuthorization],
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      },
      dependencies,
    );
    expect(result.status).toBe(401);
    expect(dependencies.authorization.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects client credentials and unknown fields in OAuth query or bodies", async () => {
    const dependencies = createDependencies();
    for (const [path, init] of [
      [
        "/v1/oauth/token?client_secret=query-secret",
        {
          method: "POST",
          ...form(tokenForm(), { authorization: basicAuthorization }),
        },
      ],
      [
        "/v1/oauth/token",
        {
          method: "POST",
          ...form(tokenForm({ client_secret: "body-secret" }), {
            authorization: basicAuthorization,
          }),
        },
      ],
      [
        "/v1/oauth/token",
        {
          method: "POST",
          ...form(tokenForm({ client_id: clientId }), {
            authorization: basicAuthorization,
          }),
        },
      ],
      [
        "/v1/oauth/introspect",
        {
          method: "POST",
          ...json(
            {
              accountId,
              sessionId,
              installationId,
              audience: "apollo-tf",
              clientSecret: "body-secret",
            },
            { authorization: basicAuthorization },
          ),
        },
      ],
    ] as const) {
      const { response } = await appRequest(path, init, dependencies);
      expect(response.status).toBe(400);
    }
    expect(dependencies.authorization.exchangeCode).not.toHaveBeenCalled();
    expect(dependencies.authorization.introspect).not.toHaveBeenCalled();
  });

  it("binds introspection to the configured Basic client and returns only policy state", async () => {
    const dependencies = createDependencies();
    const requestBody = {
      accountId,
      sessionId,
      installationId,
      audience: "apollo-tf",
    };
    const { response } = await appRequest(
      "/v1/oauth/introspect",
      {
        method: "POST",
        ...json(requestBody, { authorization: basicAuthorization }),
      },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      active: true,
      accountId,
      sessionId,
      installationId,
      accountStatus: "active",
      entitlements: ["tf.search"],
      expiresAt: "2026-07-16T18:00:00.000Z",
    });
    expect(dependencies.authorization.introspect).toHaveBeenCalledWith(
      requestBody,
      clientSecret,
    );

    const wrongClient = `Basic ${Buffer.from(
      `another-client:${clientSecret}`,
    ).toString("base64")}`;
    const { response: rejected } = await appRequest(
      "/v1/oauth/introspect",
      {
        method: "POST",
        ...json(requestBody, { authorization: wrongClient }),
      },
      dependencies,
    );
    expect(rejected.status).toBe(401);
    expect(dependencies.authorization.introspect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid_request", 400],
    ["invalid_client", 401],
    ["invalid_grant", 400],
    ["account_access_denied", 403],
  ] as const)(
    "maps %s exhaustively to a sanitized OAuth response",
    async (code, status) => {
      const dependencies = createDependencies({
        authorization: {
          ...createDependencies().authorization,
          exchangeCode: vi.fn().mockRejectedValue(platformDomainError(code)),
        },
      });
      const { response } = await appRequest(
        "/v1/oauth/token",
        {
          method: "POST",
          ...form(tokenForm(), { authorization: basicAuthorization }),
        },
        dependencies,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      const serialized = JSON.stringify(await response.json());
      expect(JSON.parse(serialized)).toEqual({
        error: code,
        requestId: expect.any(String),
      });
      for (const secret of [
        authorizationCode,
        authorizationState,
        codeVerifier,
        authorizationNonce,
        portalSessionToken,
        basicAuthorization,
        clientSecret,
      ]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it("serves only the public JWKS with a bounded exact cache policy", async () => {
    const privateCanary = "private-key-canary";
    const dependencies = createDependencies({
      assertionSigner: {
        publicJwks: vi.fn().mockReturnValue({
          keys: [
            {
              kty: "OKP",
              crv: "Ed25519",
              alg: "EdDSA",
              use: "sig",
              kid: "current",
              x: "x".repeat(43),
            },
          ],
        }),
      },
    });
    const { response } = await appRequest(
      "/.well-known/jwks.json",
      undefined,
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await response.json();
    expect(body).toEqual({
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          kid: "current",
          x: "x".repeat(43),
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"d"');
    expect(serialized).not.toContain(privateCanary);
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("NODE_ENV");
  });

  it("redacts OAuth, cookie, JWK, and client-secret fields at the logger boundary", () => {
    const output: string[] = [];
    const logger = createPlatformLogger({
      write: (chunk: string) => output.push(chunk),
    });
    logger.info({
      code: "code-canary",
      state: "state-canary",
      assertion: "assertion-canary",
      access_token: "access-canary",
      code_verifier: "verifier-canary",
      nonce: "nonce-canary",
      cookies: "cookies-canary",
      authorization: "authorization-canary",
      jwk: { d: "private-jwk-canary" },
      client: {
        clientSecret: "client-secret-canary",
        clientSecretDigest: "client-digest-canary",
        client_secret_digest: "client-snake-digest-canary",
        secretDigest: "secret-digest-canary",
      },
    });
    const serialized = output.join("");
    for (const canary of [
      "code-canary",
      "state-canary",
      "assertion-canary",
      "access-canary",
      "verifier-canary",
      "nonce-canary",
      "cookies-canary",
      "authorization-canary",
      "private-jwk-canary",
      "client-secret-canary",
      "client-digest-canary",
      "client-snake-digest-canary",
      "secret-digest-canary",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(
      serialized.match(/\[REDACTED\]/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(11);
  });

  it("recursively redacts deeply nested logger fields without mutating input", () => {
    const output: string[] = [];
    const logger = createPlatformLogger({
      write: (chunk: string) => output.push(chunk),
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const fields = {
      level1: {
        level2: {
          level3: {
            level4: {
              rawToken: "deep-raw-session-token-canary",
              clientSecret: "deep-client-secret-canary",
            },
          },
        },
      },
      array: [{ raw_session_token: "array-session-token-canary" }],
      cyclic,
    };

    logger.info(fields);

    const serialized = output.join("");
    expect(serialized).not.toContain("deep-raw-session-token-canary");
    expect(serialized).not.toContain("deep-client-secret-canary");
    expect(serialized).not.toContain("array-session-token-canary");
    expect(serialized.match(/\[REDACTED\]/g)?.length).toBe(3);
    expect(serialized).toContain("[Circular]");
    expect(fields.level1.level2.level3.level4).toEqual({
      rawToken: "deep-raw-session-token-canary",
      clientSecret: "deep-client-secret-canary",
    });
    expect(cyclic.self).toBe(cyclic);
  });

  it("makes enumerable serialization hooks inert before Pino sees them", () => {
    const output: string[] = [];
    const logger = createPlatformLogger({
      write: (chunk: string) => output.push(chunk),
    });
    let serializationHookCalls = 0;
    const payload: { safe: string; toJSON?: () => unknown } = {
      safe: "preserved",
    };
    Object.defineProperty(payload, "toJSON", {
      enumerable: true,
      value: () => {
        serializationHookCalls += 1;
        return {
          a: {
            b: {
              clientSecret: "actual-logger-tojson-canary",
            },
          },
        };
      },
    });
    const fields = {
      payload,
      nested: {
        callback: () => "function-secret-canary",
      },
    };

    logger.info(fields);

    const serialized = output.join("");
    expect(serializationHookCalls).toBe(0);
    expect(serialized).not.toContain("actual-logger-tojson-canary");
    expect(serialized).not.toContain("function-secret-canary");
    expect(serialized).toContain("[Function]");
    expect(payload.safe).toBe("preserved");
    expect(typeof payload.toJSON).toBe("function");
    expect(typeof fields.nested.callback).toBe("function");
  });

  it("returns a CORS-readable CSRF token with secure host-only login cookies", async () => {
    const { response: rejected } = await appRequest("/v1/operator/sessions", {
      method: "POST",
      ...json({ email: "operator@example.test", password: "password" }),
    });
    expect(rejected.status).toBe(403);

    const { response } = await appRequest("/v1/operator/sessions", {
      method: "POST",
      ...json(
        { email: "operator@example.test", password: "password" },
        { origin },
      ),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { csrfToken: string };
    expect(body).toEqual({ csrfToken: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("admin-session-secret");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-apollo_admin=admin-session-secret; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
        ),
        expect.stringMatching(
          /^__Host-apollo_admin_csrf=[^;]+; Path=\/; Secure; SameSite=Lax$/,
        ),
      ]),
    );
    expect(cookies.join(";")).toContain(
      `__Host-apollo_admin_csrf=${body.csrfToken};`,
    );
    expect(cookies.join(";")).not.toContain("Domain=");
  });

  it("requires session, exact origin, and matching CSRF token for protected mutation and logout", async () => {
    const dependencies = createDependencies();
    const { response: csrfRejected } = await appRequest(
      "/v1/operator/registration-settings",
      {
        method: "PATCH",
        ...json({ mode: "invite_only", reason: "Restrict access" }, { origin }),
      },
      dependencies,
    );
    expect(csrfRejected.status).toBe(403);
    expect(dependencies.operatorSessions.authenticate).not.toHaveBeenCalled();

    const { response } = await appRequest(
      "/v1/operator/registration-settings",
      {
        method: "PATCH",
        ...json(
          { mode: "invite_only", reason: "Restrict access" },
          adminHeaders(),
        ),
      },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(dependencies.registration.changeMode).toHaveBeenCalledWith(
      { mode: "invite_only", reason: "Restrict access" },
      { accountId, correlationId: expect.any(String) },
    );

    const { response: logout } = await appRequest(
      "/v1/operator/sessions/current",
      {
        method: "DELETE",
        headers: adminHeaders(),
      },
      dependencies,
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().join(";")).toContain("Max-Age=0");
  });

  it("enforces protected-route capabilities and validates path IDs before service calls", async () => {
    const dependencies = createDependencies({
      operatorSessions: {
        ...createDependencies().operatorSessions,
        authenticate: vi.fn().mockResolvedValue({
          accountId,
          sessionId,
          capabilities: [],
        }),
      },
    });
    const { response: denied } = await appRequest(
      "/v1/operator/invitations",
      {
        method: "POST",
        ...json(
          {
            expiresAt: "2026-08-16T12:00:00.000Z",
            usesLimit: 1,
            moduleKeys: ["tf.search"],
            reason: "Invite",
          },
          adminHeaders(),
        ),
      },
      dependencies,
    );
    expect(denied.status).toBe(403);
    expect(dependencies.invitations.create).not.toHaveBeenCalled();

    const valid = createDependencies();
    const { response: malformedId } = await appRequest(
      "/v1/operator/accounts/not-a-uuid/entitlements/tf.search",
      {
        method: "PUT",
        ...json({ reason: "Grant" }, adminHeaders()),
      },
      valid,
    );
    expect(malformedId.status).toBe(400);
    expect(valid.entitlements.grant).not.toHaveBeenCalled();

    const { response: conflictingEntitlement } = await appRequest(
      `/v1/operator/accounts/${accountId}/entitlements/tf.search`,
      {
        method: "PUT",
        ...json(
          {
            accountId: "77777777-7777-4777-8777-777777777777",
            moduleKey: "tf.integrations",
            reason: "Grant",
          },
          adminHeaders(),
        ),
      },
      valid,
    );
    expect(conflictingEntitlement.status).toBe(400);
    expect(valid.entitlements.grant).not.toHaveBeenCalled();
  });

  it("fails closed with a stable error when the shared limiter denies a login", async () => {
    const rateLimiter = {
      consume: vi
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterSeconds: 30 }),
    };
    const { response, dependencies } = await appRequest(
      "/v1/operator/sessions",
      {
        method: "POST",
        ...json(
          { email: "operator@example.test", password: "password" },
          { origin },
        ),
      },
      createDependencies({ rateLimiter }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: "rate_limited",
      requestId: expect.any(String),
    });
    expect(dependencies.operatorSessions.login).not.toHaveBeenCalled();
  });

  it("fails closed when the shared limiter store is unavailable", async () => {
    const rateLimiter = {
      consume: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const { response, dependencies } = await appRequest(
      "/v1/operator/sessions",
      {
        method: "POST",
        ...json(
          { email: "operator@example.test", password: "password" },
          { origin },
        ),
      },
      createDependencies({ rateLimiter }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "policy_unavailable",
      requestId: expect.any(String),
    });
    expect(dependencies.operatorSessions.login).not.toHaveBeenCalled();
  });

  it("uses an explicit fixed trust-proxy hop count", () => {
    expect(createPlatformApp(createDependencies()).get("trust proxy")).toBe(0);
    expect(
      createPlatformApp(createDependencies({ trustProxyHops: 1 })).get(
        "trust proxy",
      ),
    ).toBe(1);
  });

  it("does not emit request body, query, cookie, authorization, or secret fields in logs", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const dependencies = createDependencies({ logger });
    await appRequest(
      "/v1/registrations?token=query-secret",
      {
        method: "POST",
        ...json(
          {
            email: "member@example.test",
            displayName: "Member",
            password: "body-secret",
          },
          { authorization: "Bearer header-secret", cookie: "cookie=secret" },
        ),
      },
      dependencies,
    );
    const logs = JSON.stringify(logger.info.mock.calls);
    expect(logs).not.toContain("query-secret");
    expect(logs).not.toContain("body-secret");
    expect(logs).not.toContain("header-secret");
    expect(logs).not.toContain("cookie=secret");
  });
});
