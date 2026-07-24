import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import Redis from "ioredis";
import type {
  PlatformAssertionClaims,
  PolicyIntrospectionResponse,
} from "@workspace/platform-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  TfSessionStore,
  TfSessionStoreUnavailableError,
  createStrictRedisClient,
  type TfAuthTransaction,
} from "./tf-session-store.js";

const execFileAsync = promisify(execFile);
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const resourceSuffix = randomBytes(8).toString("hex");
const containerName = `apollo-tf-task6-redis-${resourceSuffix}`;
const networkName = `apollo-tf-task6-network-${resourceSuffix}`;
const volumeName = `apollo-tf-task6-volume-${resourceSuffix}`;

let redis: Redis;
let store: TfSessionStore;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    windowsHide: true,
  });
  return stdout.trim();
}

async function waitForRedis(client: Redis): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.connect();
      await client.ping();
      return;
    } catch (error) {
      lastError = error;
      client.disconnect(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  await docker("network", "create", networkName);
  try {
    await docker("volume", "create", volumeName);
    try {
      await docker(
        "run",
        "--detach",
        "--name",
        containerName,
        "--network",
        networkName,
        "--mount",
        `type=volume,source=${volumeName},target=/data`,
        "--publish",
        "127.0.0.1::6379",
        "redis:7-alpine",
        "redis-server",
        "--save",
        "",
        "--appendonly",
        "no",
      );
      const published = await docker("port", containerName, "6379/tcp");
      const port = Number(published.slice(published.lastIndexOf(":") + 1));
      redis = new Redis(`redis://127.0.0.1:${port}/15`, {
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      await waitForRedis(redis);
      store = new TfSessionStore(createStrictRedisClient(redis));
    } catch (error) {
      await docker("rm", "--force", containerName).catch(() => "");
      throw error;
    }
  } catch (error) {
    await docker("volume", "rm", "--force", volumeName).catch(() => "");
    throw error;
  }
}, 30_000);

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  redis?.disconnect(false);
  await docker("rm", "--force", containerName).catch(() => "");
  await docker("network", "rm", networkName).catch(() => "");
  await docker("volume", "rm", "--force", volumeName).catch(() => "");

  expect(
    await docker(
      "ps",
      "--all",
      "--filter",
      `name=^/${containerName}$`,
      "--format",
      "{{.Names}}",
    ),
  ).toBe("");
  expect(
    await docker(
      "network",
      "ls",
      "--filter",
      `name=^${networkName}$`,
      "--format",
      "{{.Name}}",
    ),
  ).toBe("");
  expect(
    await docker(
      "volume",
      "ls",
      "--filter",
      `name=^${volumeName}$`,
      "--format",
      "{{.Name}}",
    ),
  ).toBe("");
}, 30_000);

function opaque(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transactionInput() {
  return {
    state: opaque(),
    codeVerifier: opaque(),
    nonce: opaque(),
    installationId: INSTALLATION_ID,
    installationLabel: "Apollo TF Web",
  };
}

function assertionClaims(
  overrides: Partial<PlatformAssertionClaims> = {},
): PlatformAssertionClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: "https://api.apollot.ru",
    aud: "apollo-tf" as const,
    sub: ACCOUNT_ID,
    sid: SESSION_ID,
    installation_id: INSTALLATION_ID,
    nonce: opaque(),
    account_status: "active" as const,
    entitlements: ["tf.search", "tf.downloads"],
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 240,
    ...overrides,
  };
}

type ActiveIntrospection = Extract<
  PolicyIntrospectionResponse,
  { active: true }
>;

function activeIntrospection(
  overrides: Partial<ActiveIntrospection> = {},
): ActiveIntrospection {
  return {
    active: true as const,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    installationId: INSTALLATION_ID,
    accountStatus: "active" as const,
    entitlements: ["tf.downloads", "tf.search"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

describe("TfSessionStore transactions", () => {
  it("stores only a digest-keyed transaction for exactly five minutes", async () => {
    const input = transactionInput();

    const handle = await store.createTransaction(input);

    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const keys = await redis.keys("tf-auth:tx:*");
    expect(keys).toEqual([`tf-auth:tx:${digest(handle)}`]);
    expect(keys[0]).not.toContain(handle);
    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThanOrEqual(299);
    expect(ttl).toBeLessThanOrEqual(300);
    const stored = await redis.get(keys[0]!);
    expect(stored).not.toContain(handle);
    expect(JSON.parse(stored ?? "")).toMatchObject(input);
  });

  it("atomically consumes one transaction and rejects every replay", async () => {
    const input = transactionInput();
    const handle = await store.createTransaction(input);

    const results = await Promise.all(
      Array.from({ length: 24 }, () => store.consumeTransaction(handle)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toMatchObject(input);
    await expect(store.consumeTransaction(handle)).resolves.toBeNull();
  });

  it("treats malformed, expired, and non-opaque handles as absent", async () => {
    await expect(store.consumeTransaction("not-opaque")).resolves.toBeNull();
    const expiredHandle = opaque();
    const expired: TfAuthTransaction = {
      ...transactionInput(),
      createdAt: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
      expiresAt: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
    };
    await redis.set(
      `tf-auth:tx:${digest(expiredHandle)}`,
      JSON.stringify(expired),
      "EX",
      60,
    );
    await expect(store.consumeTransaction(expiredHandle)).resolves.toBeNull();
  });

  it("fails closed and sanitizes malformed stored JSON or script errors", async () => {
    const handle = opaque();
    await redis.set(
      `tf-auth:tx:${digest(handle)}`,
      JSON.stringify({ state: "private-state", unknown: true }),
      "EX",
      60,
    );

    await expect(store.consumeTransaction(handle)).rejects.toThrow(
      "TF authentication storage unavailable",
    );

    const failingStore = new TfSessionStore({
      get: async () => {
        throw new Error("redis://private-host/payload");
      },
      set: async () => {
        throw new Error("redis://private-host/payload");
      },
      eval: async () => {
        throw new Error("redis://private-host/payload");
      },
    });
    let error: unknown;
    try {
      await failingStore.createTransaction(transactionInput());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TfSessionStoreUnavailableError);
    expect((error as Error).message).toBe(
      "TF authentication storage unavailable",
    );
    expect(JSON.stringify(error)).not.toContain("private-host");
  });
});

describe("TfSessionStore sessions", () => {
  it("creates a bounded session only from bound verified claims and active introspection", async () => {
    const platformExpiresAt = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const claims = assertionClaims({
      entitlements: ["tf.search", "tf.downloads"],
    });

    const created = await store.createSession({
      assertionClaims: claims,
      introspection: activeIntrospection({
        entitlements: ["tf.search", "tf.downloads"],
        expiresAt: platformExpiresAt,
      }),
    });

    expect(created.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.session).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      accountId: ACCOUNT_ID,
      platformSessionId: SESSION_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.downloads", "tf.search"],
      assertionExpiresAt: new Date(claims.exp * 1_000).toISOString(),
      expiresAt: expect.any(String),
    });
    expect(Date.parse(created.session.expiresAt)).toBeLessThan(
      Date.parse(platformExpiresAt),
    );
    expect(Date.parse(created.session.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 8 * 60 * 60 * 1_000 + 1_000,
    );
    const keys = await redis.keys("tf-auth:session:*");
    expect(keys).toEqual([`tf-auth:session:${digest(created.handle)}`]);
    expect(keys[0]).not.toContain(created.handle);
  });

  it.each([
    ["account", { accountId: "40000000-0000-4000-8000-000000000004" }],
    ["session", { sessionId: "40000000-0000-4000-8000-000000000004" }],
    [
      "installation",
      { installationId: "40000000-0000-4000-8000-000000000004" },
    ],
    ["inactive", { active: false }],
  ])(
    "rejects %s introspection mismatch before storage",
    async (_label, mutation) => {
      await expect(
        store.createSession({
          assertionClaims: assertionClaims(),
          introspection:
            "active" in mutation && mutation.active === false
              ? { active: false }
              : activeIntrospection(mutation as Partial<ActiveIntrospection>),
        }),
      ).rejects.toThrow("TF authentication storage unavailable");
      await expect(redis.keys("tf-auth:session:*")).resolves.toEqual([]);
    },
  );

  it("reads valid sessions and fails closed on malformed stored state", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });
    await expect(store.getSession(created.handle)).resolves.toEqual(
      created.session,
    );
    await expect(store.getSession("invalid")).resolves.toBeNull();

    await redis.set(
      `tf-auth:session:${digest(created.handle)}`,
      JSON.stringify({ ...created.session, extra: "private-payload" }),
      "EX",
      60,
    );
    await expect(store.getSession(created.handle)).rejects.toThrow(
      "TF authentication storage unavailable",
    );
  });

  it("atomically refreshes only policy freshness without extending the session", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });
    const originalExpiry = created.session.expiresAt;
    const refresh = activeIntrospection({
      entitlements: ["tf.collections", "tf.search"],
      expiresAt: originalExpiry,
    });

    const refreshed = await store.refreshSession(created.handle, refresh);

    expect(refreshed).toMatchObject({
      id: created.session.id,
      accountId: ACCOUNT_ID,
      platformSessionId: SESSION_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.collections", "tf.search"],
      expiresAt: originalExpiry,
    });
    expect(Date.parse(refreshed?.assertionExpiresAt ?? "")).toBeLessThanOrEqual(
      Date.now() + 300 * 1_000 + 1_000,
    );
    expect(Date.parse(refreshed?.assertionExpiresAt ?? "")).toBeLessThanOrEqual(
      Date.parse(originalExpiry),
    );
  });

  it("keeps concurrent refresh/revoke races atomic and never resurrects a session", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });
    const refresh = activeIntrospection({
      entitlements: ["tf.collections"],
      expiresAt: created.session.expiresAt,
    });

    const outcomes = await Promise.all([
      ...Array.from({ length: 16 }, () =>
        store.refreshSession(created.handle, refresh),
      ),
      ...Array.from({ length: 8 }, () => store.revokeSession(created.handle)),
    ]);

    expect(outcomes.some((result) => result === true)).toBe(true);
    await expect(store.getSession(created.handle)).resolves.toBeNull();
  });

  it("rejects refresh binding mismatch and expired platform state", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });

    await expect(
      store.refreshSession(
        created.handle,
        activeIntrospection({
          sessionId: "40000000-0000-4000-8000-000000000004",
        }),
      ),
    ).rejects.toThrow("TF authentication storage unavailable");
    await expect(
      store.refreshSession(
        created.handle,
        activeIntrospection({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      ),
    ).rejects.toThrow("TF authentication storage unavailable");
  });
});

describe("TfSessionStore WebSocket tickets", () => {
  it("issues a digest-keyed account/session-bound ticket for 30 seconds", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });

    const ticket = await store.issueWebSocketTicket(created.handle);

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const keys = await redis.keys("tf-auth:ticket:*");
    expect(keys).toEqual([`tf-auth:ticket:${digest(ticket)}`]);
    expect(await redis.ttl(keys[0]!)).toBeGreaterThanOrEqual(29);
    expect(await redis.ttl(keys[0]!)).toBeLessThanOrEqual(30);
    expect(JSON.parse((await redis.get(keys[0]!)) ?? "")).toMatchObject({
      accountId: ACCOUNT_ID,
      sessionId: created.session.id,
    });
  });

  it("atomically consumes a ticket once under concurrency", async () => {
    const created = await store.createSession({
      assertionClaims: assertionClaims(),
      introspection: activeIntrospection(),
    });
    const ticket = await store.issueWebSocketTicket(created.handle);

    const results = await Promise.all(
      Array.from({ length: 24 }, () => store.consumeWebSocketTicket(ticket)),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toMatchObject({
      accountId: ACCOUNT_ID,
      sessionId: created.session.id,
    });
    await expect(store.consumeWebSocketTicket(ticket)).resolves.toBeNull();
  });

  it("fails closed when ticket storage is malformed or the backing session is absent", async () => {
    await expect(store.issueWebSocketTicket(opaque())).rejects.toThrow(
      "TF authentication storage unavailable",
    );

    const ticket = opaque();
    await redis.set(
      `tf-auth:ticket:${digest(ticket)}`,
      JSON.stringify({ accountId: ACCOUNT_ID, unknown: true }),
      "EX",
      30,
    );
    await expect(store.consumeWebSocketTicket(ticket)).rejects.toThrow(
      "TF authentication storage unavailable",
    );
  });
});
