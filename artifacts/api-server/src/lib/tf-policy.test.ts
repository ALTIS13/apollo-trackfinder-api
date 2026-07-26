import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import cookieParser from "cookie-parser";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PolicyIntrospectionResponse } from "@workspace/platform-contract";
import type { TfSession, TfSessionObservation } from "./tf-session-store.js";
import {
  TF_ROUTE_POLICIES,
  requiredPolicyForRequest,
  requireTfCapability,
  type TfPolicyDependencies,
} from "./tf-policy.js";

const NOW = Date.parse("2026-07-24T03:00:00.000Z");
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const TF_SESSION_ID = "40000000-0000-4000-8000-000000000004";
const SESSION_HANDLE = randomBytes(32).toString("base64url");
const REVISION = randomBytes(32).toString("base64url");
const SESSION_COOKIE = "__Host-apollo_tf";
const servers: Server[] = [];
type PlatformModuleKey =
  | "tf.collections"
  | "tf.downloads"
  | "tf.integrations"
  | "tf.search";

function session(overrides: Partial<TfSession> = {}): TfSession {
  return {
    id: TF_SESSION_ID,
    accountId: ACCOUNT_ID,
    platformSessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    entitlements: [
      "tf.collections",
      "tf.downloads",
      "tf.integrations",
      "tf.search",
    ],
    assertionExpiresAt: new Date(NOW + 120_000).toISOString(),
    expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

function observation(overrides: Partial<TfSession> = {}): TfSessionObservation {
  return {
    revision: REVISION,
    session: session(overrides),
  };
}

function activeIntrospection(
  overrides: Partial<
    Extract<PolicyIntrospectionResponse, { active: true }>
  > = {},
): Extract<PolicyIntrospectionResponse, { active: true }> {
  return {
    active: true,
    accountId: ACCOUNT_ID,
    sessionId: PLATFORM_SESSION_ID,
    installationId: INSTALLATION_ID,
    accountStatus: "active",
    entitlements: [
      "tf.collections",
      "tf.downloads",
      "tf.integrations",
      "tf.search",
    ],
    expiresAt: new Date(NOW + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

function dependencies(
  currentObservation: TfSessionObservation | null = observation(),
) {
  const refreshed = session({
    assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
  });
  return {
    now: () => NOW,
    platform: {
      introspect: vi.fn().mockResolvedValue(activeIntrospection()),
    },
    sessionStore: {
      observeSession: vi.fn().mockResolvedValue(currentObservation),
      refreshSession: vi.fn().mockResolvedValue(refreshed),
      revokeSession: vi.fn().mockResolvedValue(true),
    },
  } satisfies TfPolicyDependencies;
}

async function startPolicyServer(
  currentDependencies: TfPolicyDependencies,
): Promise<string> {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(requireTfCapability(currentDependencies));
  app.use((request, response) => {
    response.status(200).json({ principal: request.tfPrincipal });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function protectedRequest(
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly cookie?: string | null;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Record<string, unknown>;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };
  if (options.cookie !== null) {
    headers.cookie = `${SESSION_COOKIE}=${options.cookie ?? SESSION_HANDLE}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetch(`${origin}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function concretePath(path: string): string {
  return path
    .replace(":playlistId", "playlist-1")
    .replace(":jobId", "job-1")
    .replace(":kind", "2")
    .replace(":uid", "123")
    .replace(":id", "track-1");
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

describe("TF route policy map", () => {
  it("contains the exact 31 anchored capability policies", () => {
    expect(TF_ROUTE_POLICIES).toHaveLength(31);
    expect(
      TF_ROUTE_POLICIES.filter((policy) => policy.live === false),
    ).toHaveLength(6);
    expect(
      TF_ROUTE_POLICIES.filter((policy) => policy.live === true),
    ).toHaveLength(25);

    expect(
      requiredPolicyForRequest("POST", "/api/tracks/search?ignored=1"),
    ).toMatchObject({ capability: "tf.search", live: false });
    expect(
      requiredPolicyForRequest("GET", "/api/tracks/track-1/download"),
    ).toMatchObject({ capability: "tf.downloads", live: true });
    expect(
      requiredPolicyForRequest("GET", "/api/spotify/status"),
    ).toMatchObject({ capability: "tf.integrations", live: true });
    expect(
      requiredPolicyForRequest("POST", "/api/yandex/logout"),
    ).toMatchObject({ capability: "tf.integrations", live: true });
    expect(requiredPolicyForRequest("POST", "/api/ws/tickets")).toMatchObject({
      capability: "tf.search",
      live: true,
    });
  });

  it.each([
    ["POST", "/api/tracks/download/queue"],
    ["GET", "/api/tracks/download/jobs"],
    ["GET", "/api/tracks/download/status/job-id"],
    ["GET", "/api/tracks/download/file/job-id"],
    ["DELETE", "/api/tracks/download/jobs/job-id"],
  ])("requires live tf.downloads for %s %s", (method, path) => {
    expect(requiredPolicyForRequest(method, path)).toMatchObject({
      capability: "tf.downloads",
      live: true,
    });
  });

  it.each([
    ["GET", "/api/tracks/search"],
    ["POST", "/api/tracks/search/extra"],
    ["POST", "/api/tracksx/search"],
    ["GET", "/api/spotify/status/extra"],
    ["GET", "/api/yandex"],
    ["GET", "/tracks/suggest"],
  ])("does not let near-match %s %s inherit a policy", (method, path) => {
    expect(requiredPolicyForRequest(method, path)).toBeNull();
  });
});

describe("requireTfCapability", () => {
  it.each([
    ["missing cookie", null],
    ["malformed cookie", "not-an-opaque-handle"],
  ])("returns the same 401 for a %s", async (_label, cookie) => {
    const currentDependencies = dependencies();
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/suggest", {
      cookie,
      headers: {
        authorization: `Bearer ${SESSION_HANDLE}`,
        "x-client-session": SESSION_HANDLE,
        "x-tf-capability": "tf.search",
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(currentDependencies.platform.introspect).not.toHaveBeenCalled();
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).not.toHaveBeenCalled();
  });

  it("authorizes a fresh noncritical snapshot without introspection", async () => {
    const currentDependencies = dependencies(
      observation({
        entitlements: ["tf.search"],
        assertionExpiresAt: new Date(NOW + 30_001).toISOString(),
      }),
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(
      origin,
      "/api/tracks/suggest?capability=tf.downloads",
      {
        headers: {
          "x-tf-capability": "tf.downloads",
        },
      },
    );
    const body = (await response.json()) as {
      principal: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.principal).toEqual({
      accountId: ACCOUNT_ID,
      tfSessionId: TF_SESSION_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.search"],
      sessionExpiresAt: session().expiresAt,
      policyFreshUntil: new Date(NOW + 30_001).toISOString(),
    });
    expect(body.principal).not.toHaveProperty("platformSessionId");
    expect(body.principal).not.toHaveProperty("revision");
    expect(body.principal).not.toHaveProperty("sessionHandle");
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledOnce();
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledWith(SESSION_HANDLE);
    expect(currentDependencies.platform.introspect).not.toHaveBeenCalled();
  });

  it("returns 403 when the authoritative snapshot lacks the capability", async () => {
    const currentDependencies = dependencies(
      observation({
        entitlements: ["tf.downloads"],
        assertionExpiresAt: new Date(NOW + 120_000).toISOString(),
      }),
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/suggest", {
      headers: { "x-tf-capability": "tf.search" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "module_access_denied",
    });
    expect(currentDependencies.platform.introspect).not.toHaveBeenCalled();
  });

  it("introspects a near-expiry snapshot and refreshes with the observed revision once", async () => {
    const currentDependencies = dependencies(
      observation({
        entitlements: [],
        assertionExpiresAt: new Date(NOW + 30_000).toISOString(),
      }),
    );
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(
      session({
        entitlements: ["tf.search"],
        assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
      }),
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/suggest");

    expect(response.status).toBe(200);
    expect(currentDependencies.platform.introspect).toHaveBeenCalledOnce();
    expect(currentDependencies.platform.introspect).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      sessionId: PLATFORM_SESSION_ID,
      installationId: INSTALLATION_ID,
      audience: "apollo-tf",
    });
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledOnce();
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledWith(
      SESSION_HANDLE,
      observation({
        entitlements: [],
        assertionExpiresAt: new Date(NOW + 30_000).toISOString(),
      }),
      activeIntrospection(),
    );
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledOnce();
  });

  it("samples snapshot freshness after asynchronous session observation", async () => {
    let currentTime = NOW;
    const currentDependencies = dependencies(
      observation({
        entitlements: ["tf.search"],
        assertionExpiresAt: new Date(NOW + 30_001).toISOString(),
      }),
    );
    currentDependencies.now = () => currentTime;
    currentDependencies.sessionStore.observeSession.mockImplementation(
      async () => {
        currentTime = NOW + 2_000;
        return observation({
          entitlements: ["tf.search"],
          assertionExpiresAt: new Date(NOW + 30_001).toISOString(),
        });
      },
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/suggest");

    expect(response.status).toBe(200);
    expect(currentDependencies.platform.introspect).toHaveBeenCalledOnce();
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledOnce();
  });

  it("rechecks refreshed live-session expiry after asynchronous refresh", async () => {
    let currentTime = NOW;
    const currentDependencies = dependencies();
    currentDependencies.now = () => currentTime;
    currentDependencies.sessionStore.refreshSession.mockImplementation(
      async () => {
        currentTime = NOW + 180_000;
        return session({
          assertionExpiresAt: new Date(NOW + 120_000).toISOString(),
        });
      },
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "policy_unavailable",
    });
  });

  it("introspects every critical policy even with a fresh snapshot", async () => {
    const currentDependencies = dependencies();
    const origin = await startPolicyServer(currentDependencies);
    const livePolicies = TF_ROUTE_POLICIES.filter((policy) => policy.live);

    for (const policy of livePolicies) {
      const response = await protectedRequest(
        origin,
        concretePath(policy.path),
        {
          method: policy.method,
          body: policy.method === "POST" ? {} : undefined,
        },
      );
      expect(response.status, `${policy.method} ${policy.path}`).toBe(200);
    }

    expect(currentDependencies.platform.introspect).toHaveBeenCalledTimes(
      livePolicies.length,
    );
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledTimes(livePolicies.length);
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledTimes(livePolicies.length);
  });

  it.each([
    ["storage corruption", "observe"],
    ["Platform failure", "introspect"],
    ["stale refresh", "refresh"],
  ])("sanitizes %s as policy_unavailable", async (_label, failurePoint) => {
    const canary = `private-${failurePoint}-${randomUUID()}`;
    const currentDependencies = dependencies();
    if (failurePoint === "observe") {
      currentDependencies.sessionStore.observeSession.mockRejectedValue(
        new Error(canary),
      );
    } else if (failurePoint === "introspect") {
      currentDependencies.platform.introspect.mockRejectedValue(
        new Error(canary),
      );
    } else {
      currentDependencies.sessionStore.refreshSession.mockRejectedValue(
        new Error(canary),
      );
    }
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"policy_unavailable"}');
    expect(body).not.toContain(canary);
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledOnce();
    expect(currentDependencies.platform.introspect).toHaveBeenCalledTimes(
      failurePoint === "observe" ? 0 : 1,
    );
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledTimes(failurePoint === "refresh" ? 1 : 0);
  });

  it("re-observes once and uses a valid concurrent refresh when the CAS result is missing", async () => {
    const currentDependencies = dependencies();
    const concurrent = {
      ...observation({
        entitlements: ["tf.collections"],
        assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
      }),
      revision: randomBytes(32).toString("base64url"),
    };
    currentDependencies.sessionStore.observeSession
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(concurrent);
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(null);
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");

    expect(response.status).toBe(200);
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledTimes(2);
    expect(currentDependencies.platform.introspect).toHaveBeenCalledOnce();
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledOnce();
  });

  it("denies a bounded concurrent entitlement absent from current introspection", async () => {
    const currentDependencies = dependencies();
    const concurrent = {
      ...observation({
        entitlements: ["tf.collections"],
        assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
      }),
      revision: randomBytes(32).toString("base64url"),
    };
    currentDependencies.platform.introspect.mockResolvedValue(
      activeIntrospection({ entitlements: [] }),
    );
    currentDependencies.sessionStore.observeSession
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(concurrent);
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(null);
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "module_access_denied",
    });
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledTimes(2);
  });

  it("does not regrant a bounded entitlement absent from concurrent storage", async () => {
    const currentDependencies = dependencies();
    const concurrent = {
      ...observation({
        entitlements: [],
        assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
      }),
      revision: randomBytes(32).toString("base64url"),
    };
    currentDependencies.platform.introspect.mockResolvedValue(
      activeIntrospection({ entitlements: ["tf.collections"] }),
    );
    currentDependencies.sessionStore.observeSession
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(concurrent);
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(null);
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "module_access_denied",
    });
  });

  it.each([
    {
      conflict: "session expiry beyond current introspection",
      assertionExpiresAt: new Date(NOW + 4 * 60_000).toISOString(),
      sessionExpiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      introspectionExpiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    },
    {
      conflict: "policy freshness beyond resolved session",
      assertionExpiresAt: new Date(NOW + 6 * 60_000).toISOString(),
      sessionExpiresAt: new Date(NOW + 5 * 60_000).toISOString(),
      introspectionExpiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    },
  ])("rejects a bounded concurrent $conflict", async (lifetime) => {
    const currentDependencies = dependencies();
    const concurrent = {
      ...observation({
        entitlements: ["tf.collections"],
        assertionExpiresAt: lifetime.assertionExpiresAt,
        expiresAt: lifetime.sessionExpiresAt,
      }),
      revision: randomBytes(32).toString("base64url"),
    };
    currentDependencies.platform.introspect.mockResolvedValue(
      activeIntrospection({
        entitlements: ["tf.collections"],
        expiresAt: lifetime.introspectionExpiresAt,
      }),
    );
    currentDependencies.sessionStore.observeSession
      .mockResolvedValueOnce(observation())
      .mockResolvedValueOnce(concurrent);
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(null);
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/tracks/recent");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "policy_unavailable",
    });
  });

  it("authorizes both parallel HTTP refreshes through one bounded concurrent re-read", async () => {
    const currentDependencies = dependencies();
    const initial = observation({
      entitlements: [],
      assertionExpiresAt: new Date(NOW + 1_000).toISOString(),
    });
    const concurrent = {
      ...observation({
        entitlements: ["tf.collections"],
        assertionExpiresAt: new Date(NOW + 300_000).toISOString(),
      }),
      revision: randomBytes(32).toString("base64url"),
    };
    currentDependencies.sessionStore.observeSession
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(concurrent);
    currentDependencies.sessionStore.refreshSession
      .mockResolvedValueOnce(concurrent.session)
      .mockResolvedValueOnce(null);
    const origin = await startPolicyServer(currentDependencies);

    const responses = await Promise.all([
      protectedRequest(origin, "/api/tracks/recent"),
      protectedRequest(origin, "/api/tracks/recent"),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 200]);
    expect(
      currentDependencies.sessionStore.observeSession,
    ).toHaveBeenCalledTimes(3);
    expect(currentDependencies.platform.introspect).toHaveBeenCalledTimes(2);
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).toHaveBeenCalledTimes(2);
  });

  it("revokes and denies an inactive introspection without refreshing", async () => {
    const currentDependencies = dependencies();
    currentDependencies.platform.introspect.mockResolvedValue({
      active: false,
    });
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/spotify/status");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(
      currentDependencies.sessionStore.revokeSession,
    ).toHaveBeenCalledOnce();
    expect(currentDependencies.sessionStore.revokeSession).toHaveBeenCalledWith(
      SESSION_HANDLE,
    );
    expect(
      currentDependencies.sessionStore.refreshSession,
    ).not.toHaveBeenCalled();
  });

  it("uses only refreshed entitlements for a live capability decision", async () => {
    const currentDependencies = dependencies(
      observation({ entitlements: ["tf.integrations"] }),
    );
    currentDependencies.sessionStore.refreshSession.mockResolvedValue(
      session({ entitlements: ["tf.search"] }),
    );
    const origin = await startPolicyServer(currentDependencies);

    const response = await protectedRequest(origin, "/api/spotify/status", {
      headers: { "x-tf-capability": "tf.integrations" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "module_access_denied",
    });
  });

  it("never accepts a capability outside the exact Platform module key set", () => {
    const capabilities = new Set<PlatformModuleKey>(
      TF_ROUTE_POLICIES.map((policy) => policy.capability),
    );
    expect([...capabilities].sort()).toEqual([
      "tf.collections",
      "tf.downloads",
      "tf.integrations",
      "tf.search",
    ]);
  });
});
