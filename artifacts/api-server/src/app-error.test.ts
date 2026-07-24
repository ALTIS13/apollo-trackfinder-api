import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp, sanitizedApiErrorHandler } from "./app.js";
import { createTfLogger } from "./lib/logger.js";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://unused:unused@127.0.0.1:1/unused";
});

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const PLATFORM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "30000000-0000-4000-8000-000000000003";
const TF_SESSION_ID = "40000000-0000-4000-8000-000000000004";
const REVISION = randomBytes(32).toString("base64url");
const HANDLE = randomBytes(32).toString("base64url");
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("terminal API error sanitization", () => {
  it("does not forward a sensitive error after response headers were sent", () => {
    const canary = `partial-response-${randomBytes(24).toString("base64url")}`;
    const log = { error: vi.fn() };
    const destroy = vi.fn();
    const next = vi.fn();

    sanitizedApiErrorHandler(
      new Error(canary),
      {
        log,
        method: "GET",
        path: "/yandex/status",
      } as unknown as Request,
      {
        destroy,
        headersSent: true,
      } as unknown as Response,
      next as NextFunction,
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(canary);
  });

  it("keeps rejected database query parameters out of response, logs, and stderr", async () => {
    const canary = `drizzle-params-${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const assertionExpiresAt = new Date(
      Date.now() + 5 * 60 * 1_000,
    ).toISOString();
    const tfSession = {
      id: TF_SESSION_ID,
      accountId: ACCOUNT_ID,
      platformSessionId: PLATFORM_SESSION_ID,
      installationId: INSTALLATION_ID,
      entitlements: ["tf.integrations"],
      assertionExpiresAt,
      expiresAt,
    };
    const introspection = {
      active: true as const,
      accountId: ACCOUNT_ID,
      sessionId: PLATFORM_SESSION_ID,
      installationId: INSTALLATION_ID,
      accountStatus: "active" as const,
      entitlements: ["tf.integrations"],
      expiresAt,
    };
    let logOutput = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const tokenStore = {
      get: vi
        .fn()
        .mockRejectedValue(
          new Error(`Failed query: params ${canary} yandex-token-canary`),
        ),
      upsert: vi.fn(),
      delete: vi.fn(),
    };
    const app = createApiApp({
      requestLogger: createTfLogger(destination),
      auth: {
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
        },
        webOrigin: "https://tf.apollot.ru",
        secureCookies: true,
      },
      yandex: {
        fetch: vi.fn(),
        log: { error: vi.fn() },
        tokenStore,
      },
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/yandex/status?token=${canary}`,
      { headers: { cookie: `__Host-apollo_tf=${HANDLE}` } },
    );
    const body = await response.text();

    expect(tokenStore.get).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(response.status).toBe(500);
    expect(body).toBe('{"error":"internal_error"}');
    expect(body).not.toContain(canary);
    expect(logOutput).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });
});
