import { createServer, request as httpRequest, type Server } from "node:http";

import { PROTECTED_PLATFORM_ROUTES } from "@workspace/platform-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlatformApp,
  REGISTERED_PROTECTED_PLATFORM_ROUTES,
  type PlatformApiDependencies,
} from "../app.js";
import { platformDomainError } from "../domain/errors.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const origin = "https://admin.apollo.test";
const now = new Date("2026-07-16T10:00:00.000Z");

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
  expiresAt: null,
  revokedAt: null,
  source: "operator",
  grantedByAccountId: accountId,
  reason: "Access approved",
  createdAt: now,
  updatedAt: now,
};

function createDependencies(
  overrides: Partial<PlatformApiDependencies> = {},
): PlatformApiDependencies {
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
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) {
  const app = await startApp();
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

function adminHeaders(csrf = "csrf-token") {
  return {
    origin,
    cookie: `__Host-apollo_admin=admin-session-secret; __Host-apollo_admin_csrf=${csrf}`,
    "x-csrf-token": csrf,
  };
}

describe("platform HTTP API", () => {
  it("uses the exact protected route manifest", () => {
    expect(REGISTERED_PROTECTED_PLATFORM_ROUTES).toEqual(
      PROTECTED_PLATFORM_ROUTES,
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
