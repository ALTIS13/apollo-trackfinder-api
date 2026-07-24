import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createYandexRouter,
  type YandexRouteDependencies,
  type YandexTokenRecord,
} from "./yandex.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "90000000-0000-4000-8000-000000000009";
const principal = {
  accountId: ACCOUNT_ID,
  tfSessionId: "40000000-0000-4000-8000-000000000004",
  installationId: "30000000-0000-4000-8000-000000000003",
  entitlements: ["tf.integrations"],
  sessionExpiresAt: "2026-07-24T04:00:00.000Z",
  policyFreshUntil: "2026-07-24T03:05:00.000Z",
} as const;
const servers: Server[] = [];

function yandexRecord(
  overrides: Partial<YandexTokenRecord> = {},
): YandexTokenRecord {
  return {
    oauthToken: "yandex-provider-token",
    yandexUserId: "12345",
    displayName: "Yandex User",
    login: "yandex-user",
    ...overrides,
  };
}

function yandexDependencies() {
  return {
    fetch: vi.fn(),
    log: {
      error: vi.fn(),
    },
    tokenStore: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } satisfies YandexRouteDependencies;
}

async function startYandexServer(
  dependencies: YandexRouteDependencies,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.tfPrincipal = principal;
    next();
  });
  app.use("/api", createYandexRouter(dependencies));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api`;
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

describe("Yandex account ownership", () => {
  it("stores submitted provider credentials only for the principal account", async () => {
    const dependencies = yandexDependencies();
    const tokenCanary = `yandex-${randomBytes(24).toString("base64url")}`;
    dependencies.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            account: {
              uid: 12345,
              login: "yandex-user",
              displayName: "Yandex User",
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const baseUrl = await startYandexServer(dependencies);

    const response = await fetch(
      `${baseUrl}/yandex/token?sessionId=${OTHER_ACCOUNT_ID}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-session": OTHER_ACCOUNT_ID,
        },
        body: JSON.stringify({
          token: tokenCanary,
          sessionId: OTHER_ACCOUNT_ID,
        }),
      },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(dependencies.tokenStore.upsert).toHaveBeenCalledWith(ACCOUNT_ID, {
      oauthToken: tokenCanary,
      yandexUserId: "12345",
      displayName: "Yandex User",
      login: "yandex-user",
    });
    expect(
      JSON.stringify(dependencies.tokenStore.upsert.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
    expect(body).not.toContain(tokenCanary);
    expect(JSON.stringify(dependencies.log.error.mock.calls)).not.toContain(
      tokenCanary,
    );
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "https://api.music.yandex.net/account/status",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `OAuth ${tokenCanary}`,
        }),
      }),
    );
  });

  it("ignores arbitrary session selectors for token reads and logout", async () => {
    const dependencies = yandexDependencies();
    dependencies.tokenStore.get.mockResolvedValue(yandexRecord());
    const baseUrl = await startYandexServer(dependencies);
    const headers = { "x-client-session": OTHER_ACCOUNT_ID };

    const status = await fetch(
      `${baseUrl}/yandex/status?sessionId=${OTHER_ACCOUNT_ID}&sid=${OTHER_ACCOUNT_ID}`,
      { headers },
    );
    const logout = await fetch(
      `${baseUrl}/yandex/logout?sessionId=${OTHER_ACCOUNT_ID}`,
      {
        method: "POST",
        headers,
      },
    );

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      connected: true,
      displayName: "Yandex User",
      login: "yandex-user",
      userId: "12345",
    });
    expect(logout.status).toBe(200);
    expect(dependencies.tokenStore.get).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(dependencies.tokenStore.delete).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(
      JSON.stringify(dependencies.tokenStore.get.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
    expect(
      JSON.stringify(dependencies.tokenStore.delete.mock.calls),
    ).not.toContain(OTHER_ACCOUNT_ID);
  });

  it("sanitizes submitted-token persistence rejection", async () => {
    const dependencies = yandexDependencies();
    const tokenCanary = `yandex-token-${randomBytes(24).toString("base64url")}`;
    const databaseCanary = `yandex-db-${randomBytes(24).toString("base64url")}`;
    dependencies.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            account: {
              uid: 12345,
              login: "yandex-user",
              displayName: "Yandex User",
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    dependencies.tokenStore.upsert.mockRejectedValue(
      new Error(`${databaseCanary}:${tokenCanary}`),
    );
    const baseUrl = await startYandexServer(dependencies);

    const response = await fetch(`${baseUrl}/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tokenCanary }),
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"yandex_unavailable"}');
    expect(body).not.toContain(tokenCanary);
    expect(body).not.toContain(databaseCanary);
    expect(JSON.stringify(dependencies.log.error.mock.calls)).not.toContain(
      tokenCanary,
    );
    expect(JSON.stringify(dependencies.log.error.mock.calls)).not.toContain(
      databaseCanary,
    );
  });

  it("sanitizes provider-token deletion rejection", async () => {
    const dependencies = yandexDependencies();
    const databaseCanary = `yandex-delete-${randomBytes(24).toString(
      "base64url",
    )}`;
    dependencies.tokenStore.delete.mockRejectedValue(new Error(databaseCanary));
    const baseUrl = await startYandexServer(dependencies);

    const response = await fetch(`${baseUrl}/yandex/logout`, {
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"yandex_unavailable"}');
    expect(body).not.toContain(databaseCanary);
    expect(JSON.stringify(dependencies.log.error.mock.calls)).not.toContain(
      databaseCanary,
    );
  });
});
