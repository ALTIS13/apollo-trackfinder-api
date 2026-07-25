import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiApp, sanitizedApiErrorHandler } from "./app.js";
import type { TfIntegrationsGateway } from "./lib/tf-integrations-client.js";
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

function captureRequestLogs(): {
  readonly logger: ReturnType<typeof createTfLogger>;
  readonly read: () => string;
} {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return {
    logger: createTfLogger(destination),
    read: () => output,
  };
}

async function startApp(app: ReturnType<typeof createApiApp>): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

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
  it("preserves a fixed sanitized 400 for malformed JSON", async () => {
    const canary = `malformed-json-${randomBytes(24).toString("base64url")}`;
    const logs = captureRequestLogs();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const origin = await startApp(createApiApp({ requestLogger: logs.logger }));

    const response = await fetch(`${origin}/api/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"token":"${canary}"`,
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toBe('{"error":"invalid_request"}');
    expect(body).not.toContain(canary);
    expect(logs.read()).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });

  it("preserves a fixed sanitized 413 for an oversized body", async () => {
    const canary = `oversized-json-${randomBytes(24).toString("base64url")}`;
    const logs = captureRequestLogs();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const origin = await startApp(createApiApp({ requestLogger: logs.logger }));

    const response = await fetch(`${origin}/api/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: canary,
        padding: "x".repeat(128 * 1024),
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(413);
    expect(body).toBe('{"error":"request_too_large"}');
    expect(body).not.toContain(canary);
    expect(logs.read()).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });

  it("preserves a fixed sanitized 413 for oversized URL-encoded input", async () => {
    const canary = `oversized-form-${randomBytes(24).toString("base64url")}`;
    const logs = captureRequestLogs();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const origin = await startApp(createApiApp({ requestLogger: logs.logger }));
    const form = new URLSearchParams({
      token: canary,
      padding: "x".repeat(128 * 1024),
    });

    const response = await fetch(`${origin}/api/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await response.text();

    expect(response.status).toBe(413);
    expect(body).toBe('{"error":"request_too_large"}');
    expect(body).not.toContain(canary);
    expect(logs.read()).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });

  it("preserves a fixed sanitized 413 for too many URL-encoded parameters", async () => {
    const canary = `parameter-limit-${randomBytes(24).toString("base64url")}`;
    const logs = captureRequestLogs();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const origin = await startApp(createApiApp({ requestLogger: logs.logger }));
    const form = new URLSearchParams({ token: canary });
    for (let index = 0; index < 1_000; index += 1) {
      form.append(`p${index}`, "x");
    }

    const response = await fetch(`${origin}/api/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await response.text();

    expect(response.status).toBe(413);
    expect(body).toBe('{"error":"request_too_large"}');
    expect(body).not.toContain(canary);
    expect(logs.read()).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });

  it("preserves a fixed sanitized 400 for excessive URL-encoded nesting", async () => {
    const canary = `nesting-limit-${randomBytes(24).toString("base64url")}`;
    const logs = captureRequestLogs();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const origin = await startApp(createApiApp({ requestLogger: logs.logger }));
    const nestedKey = `token${"[child]".repeat(33)}`;
    const form = new URLSearchParams({ [nestedKey]: canary });

    const response = await fetch(`${origin}/api/yandex/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toBe('{"error":"invalid_request"}');
    expect(body).not.toContain(canary);
    expect(logs.read()).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });

  it("rejects a fully forged malformed-parser shape as an internal error", () => {
    const canary = `forged-parse-${randomBytes(24).toString("base64url")}`;
    const log = { error: vi.fn(), warn: vi.fn() };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();

    sanitizedApiErrorHandler(
      Object.assign(new SyntaxError(canary), {
        body: `{"token":"${canary}"`,
        expose: true,
        status: 400,
        statusCode: 400,
        type: "entity.parse.failed",
      }),
      {
        log,
        method: "POST",
        path: "/yandex/token",
      } as unknown as Request,
      {
        headersSent: false,
        json,
        status,
      } as unknown as Response,
      vi.fn() as NextFunction,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "internal_error" });
    expect(log.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(canary);
  });

  it("rejects a fully forged oversized-parser shape as an internal error", () => {
    const canary = `forged-size-${randomBytes(24).toString("base64url")}`;
    const log = { error: vi.fn(), warn: vi.fn() };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();

    sanitizedApiErrorHandler(
      Object.assign(new Error(canary), {
        expected: 100 * 1024 + 1,
        expose: true,
        length: 100 * 1024 + 1,
        limit: 100 * 1024,
        name: "PayloadTooLargeError",
        status: 413,
        statusCode: 413,
        type: "entity.too.large",
      }),
      {
        log,
        method: "POST",
        path: "/yandex/token",
      } as unknown as Request,
      {
        headersSent: false,
        json,
        status,
      } as unknown as Response,
      vi.fn() as NextFunction,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "internal_error" });
    expect(log.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(canary);
  });

  it("does not trust a generic error with forged client status fields", () => {
    const canary = `forged-status-${randomBytes(24).toString("base64url")}`;
    const log = { error: vi.fn() };
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();

    sanitizedApiErrorHandler(
      Object.assign(new Error(canary), {
        status: 400,
        statusCode: 400,
      }),
      {
        log,
        method: "POST",
        path: "/yandex/token",
      } as unknown as Request,
      {
        headersSent: false,
        json,
        status,
      } as unknown as Response,
      next as NextFunction,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "internal_error" });
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(canary);
  });

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

  it("keeps rejected integration details out of response, logs, and stderr", async () => {
    const canary = `integration-error-${randomBytes(24).toString("base64url")}`;
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
    const execute = vi
      .fn()
      .mockRejectedValue(
        new Error(`Failed query: params ${canary} yandex-token-canary`),
      );
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
          issueWebSocketTicket: vi.fn(),
        },
        webOrigin: "https://tf.apollot.ru",
        secureCookies: true,
      },
      integrationsGateway: {
        execute,
      } as unknown as TfIntegrationsGateway,
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

    expect(execute).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      operation: "yandex.status",
      input: {},
    });
    expect(response.status).toBe(200);
    expect(body).toBe('{"connected":false}');
    expect(body).not.toContain(canary);
    expect(logOutput).not.toContain(canary);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(canary);
  });
});
